import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createPoFromPlanning, createRfqFromPlanning } from "@/modules/planning/ordering";
import { getMrp, listPlanningOrders, saveRequirement, setGeneralPurchaseQty, setPlanningAttributes } from "@/modules/planning/service";
import { createPo } from "@/modules/procurement/po";
import { createRfq } from "@/modules/procurement/rfq";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { commercialFixture, day, errorOf, type CFx } from "./commercial-helpers";

/**
 * Workflow v2 · Phase 2 — Sales Order → Material Planning → direct RFQ / PO, general inventory,
 * line-level allocations and duplicate-ordering guards.
 */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

const ver = async (id: string) => (await db.salesOrder.findUniqueOrThrow({ where: { id } })).version;

async function approvedSo(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}, projectId = fx.p1.id) {
  const so = await createSalesOrder(fx.roles.pm.actor, { projectId, partyId: fx.client.id, orderDate: day(), deliveryDate: day(10), lines, ...extra });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await ver(so.id) });
  return db.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: { orderBy: { lineNo: "asc" } }, milestones: { orderBy: { sortOrder: "asc" } } } });
}

const row = async (actor = fx.roles.pu.actor, scope: "project" | "general" | "all" = "all") => {
  const mrp = await getMrp(actor, { scope });
  return {
    project: (ibId: string, projectId = fx.p1.id) => mrp.rows.find((r) => r.scope === "PROJECT" && r.itemBrandId === ibId && r.project?.id === projectId)!,
    general: (ibId: string) => mrp.rows.find((r) => r.scope === "GENERAL" && r.itemBrandId === ibId)!,
    rows: mrp.rows,
  };
};

describe("sales order → material requirements", () => {
  it("only material lines create requirements; services and installation are billed but never planned", async () => {
    const so = await approvedSo([
      { kind: "MATERIAL", itemBrandId: fx.ibUltra.id, quantity: "300", rate: "450", gstRate: "28" },
      { kind: "SERVICE", description: "Site supervision", unit: "Month", quantity: "2", rate: "20000", gstRate: "18" },
      // An item picked on an installation line is ignored — installation is never purchased.
      { kind: "INSTALLATION", itemBrandId: fx.ibAcc.id, description: "Installation charges", unit: "Job", quantity: "1", rate: "15000", gstRate: "18" },
    ]);
    expect(so.lines.map((l) => [l.kind, l.itemBrandId])).toEqual([
      ["MATERIAL", fx.ibUltra.id],
      ["SERVICE", null],
      ["INSTALLATION", null],
    ]);
    const reqs = await db.materialRequirement.findMany({ where: { projectId: fx.p1.id } });
    expect(reqs.map((r) => [r.itemBrandId, r.requiredQty.toString(), r.salesOrderLineId])).toEqual([[fx.ibUltra.id, "300", so.lines[0]!.id]]);
  });

  it("line kind defaults from the item; a material line must name its item–brand", async () => {
    const so = await approvedSo([{ itemBrandId: fx.ibUltra.id, quantity: "5", rate: "450", gstRate: "28" }, { description: "Freight", unit: "Trip", quantity: "1", rate: "2000", gstRate: "18" }]);
    expect(so.lines.map((l) => l.kind)).toEqual(["MATERIAL", "SERVICE"]);
    const err = await errorOf(createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), lines: [{ kind: "MATERIAL", description: "Cement", unit: "Bag", quantity: "5", rate: "450", gstRate: "28" }] }));
    expect(err.message).toMatch(/Pick the item – brand for material lines/);
  });

  it("saves the editable 50 / 40 / 10 payment schedule with the order, and keeps it in step with draft edits", async () => {
    const milestones = [
      { label: "Advance with order", basis: "PERCENT", value: "50", trigger: "ADVANCE" },
      { label: "On delivery", basis: "PERCENT", value: "40", trigger: "ON_DELIVERY" },
      { label: "On installation", basis: "PERCENT", value: "10", trigger: "ON_INSTALLATION" },
    ];
    const so = await approvedSo([{ itemBrandId: fx.ibUltra.id, quantity: "10", rate: "1000", gstRate: "18" }], { milestones });
    expect(so.milestones.map((m) => [m.trigger, m.percent?.toString(), m.amount.toString()])).toEqual([
      ["ADVANCE", "50", "5900"],
      ["ON_DELIVERY", "40", "4720"],
      ["ON_INSTALLATION", "10", "1180"],
    ]);
    // An incomplete schedule is rejected.
    const err = await errorOf(createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "1", rate: "100", gstRate: "0" }], milestones: milestones.slice(0, 2) }));
    expect(err.message).toMatch(/not allocated/);
  });
});

describe("material planning: project + general inventory, combined ordering", () => {
  async function setup() {
    // Project need: 300 Ultra (100 free in the warehouse). General stock: ACC min 50 / target 120 (40 in stock).
    await approvedSo([{ itemBrandId: fx.ibUltra.id, quantity: "300", rate: "450", gstRate: "28" }]);
    await setPlanningAttributes(fx.roles.pu.actor, fx.ibAcc.id, { reorderLevel: "50", targetStock: "120" });
  }

  it("shows project and general lines with stock figures and reorder suggestions", async () => {
    await setup();
    const r = await row();
    const p = r.project(fx.ibUltra.id);
    expect(p).toMatchObject({ requiredQty: "300", issuedQty: "0", availableStock: "100", reservedStock: "0", incoming: "0", toOrder: "200", maxOrderQty: "300" });
    const g = r.general(fx.ibAcc.id);
    expect(g).toMatchObject({ project: null, requirementId: null, minStock: "50", targetStock: "120", availableStock: "40", suggestedQty: "80", toOrder: "80", maxOrderQty: null });
    expect(g.flags).toContain("BELOW_REORDER");
    // Scopes: project tab has no general lines, general tab has no project lines.
    expect((await row(fx.roles.pu.actor, "project")).rows.every((x) => x.scope === "PROJECT")).toBe(true);
    expect((await row(fx.roles.pu.actor, "general")).rows.every((x) => x.scope === "GENERAL")).toBe(true);
  });

  it("one combined PO covers a project and general stock, keeps line-level allocations and blocks double ordering", async () => {
    await setup();
    let r = await row();
    const p = r.project(fx.ibUltra.id);
    const po = await createPoFromPlanning(fx.roles.pu.actor, {
      partyId: fx.supplier.id,
      lines: [
        { requirementId: p.requirementId, itemBrandId: fx.ibUltra.id, quantity: "200", rate: "400" },
        { requirementId: null, itemBrandId: fx.ibAcc.id, quantity: "80", rate: "380" },
      ],
    });
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: "asc" }, include: { requirement: true } } } });
    expect(saved.projectId).toBeNull();
    expect(saved.deliveryLocationId).toBe(fx.warehouse.id);
    expect(saved.lines[0]!.requirement!.projectId).toBe(fx.p1.id);
    expect(saved.lines[1]!.requirement!.projectId).toBeNull();
    expect(saved.lines[1]!.requirement!.requiredQty.toString()).toBe("80");

    r = await row();
    expect(r.project(fx.ibUltra.id)).toMatchObject({ poPipeline: "200", toOrder: "0", maxOrderQty: "100" });
    expect(r.general(fx.ibAcc.id)).toMatchObject({ poPipeline: "80",suggestedQty: "0", toOrder: "0" });

    // Planning path: more than still needs ordering is refused.
    expect((await errorOf(createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: p.requirementId, itemBrandId: fx.ibUltra.id, quantity: "101", rate: "400" }] }))).message).toMatch(/only 100 Bag still needs ordering/);
    // Any other path: a PO line linked to the requirement cannot over-allocate it either.
    expect((await errorOf(createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "101", rate: "400", gstRate: "28", requirementId: p.requirementId }] }))).message).toMatch(/only 100 left to order/);
    // A project PO cannot take another project's (or general) requirement.
    const gReq = saved.lines[1]!.requirementId!;
    expect((await errorOf(createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibAcc.id, quantity: "1", rate: "380", gstRate: "28", requirementId: gReq }] }))).message).toMatch(/planned for general stock/);
    // Wrong item for the requirement.
    expect((await errorOf(createPo(fx.roles.pu.actor, { partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibAcc.id, quantity: "1", rate: "380", gstRate: "28", requirementId: p.requirementId }] }))).message).toMatch(/same item and brand/);
  });

  it("rate enquiries from planning count as already requested; Already Ordered lists every allocated line", async () => {
    await setup();
    const p = (await row()).project(fx.ibUltra.id);
    await createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: p.requirementId, itemBrandId: fx.ibUltra.id, quantity: "200", rate: "400" }] });
    const rfq = await createRfqFromPlanning(fx.roles.pu.actor, { supplierIds: [fx.supplier.id, fx.supplier2.id], lines: [{ requirementId: p.requirementId, itemBrandId: fx.ibUltra.id, quantity: "100" }] });
    const saved = await db.rfq.findUniqueOrThrow({ where: { id: rfq.id }, include: { lines: true } });
    expect(saved.projectId).toBe(fx.p1.id);
    expect(saved.lines[0]!.requirementId).toBe(p.requirementId);
    expect((await row()).project(fx.ibUltra.id)).toMatchObject({ openRfq: "100", maxOrderQty: "0", toOrder: "0" });
    expect((await errorOf(createRfq(fx.roles.pu.actor, { projectId: fx.p1.id, title: "Again", supplierIds: [fx.supplier.id], lines: [{ itemId: fx.item.id, itemBrandId: fx.ibUltra.id, quantity: "1", requirementId: p.requirementId }] }))).message).toMatch(/only 0 left to order/);

    const orders = await listPlanningOrders(fx.roles.pu.actor, { scope: "all" });
    expect(orders.rows.map((o) => [o.docType, o.quantity, o.project?.code ?? null]).sort()).toEqual([
      ["PO", "200", (await db.project.findUniqueOrThrow({ where: { id: fx.p1.id } })).code],
      ["RFQ", "100", (await db.project.findUniqueOrThrow({ where: { id: fx.p1.id } })).code],
    ]);
  });

  it("manual general purchase quantities are net of what is on order and cannot be set below it", async () => {
    await setup();
    await createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: null, itemBrandId: fx.ibAcc.id, quantity: "80", rate: "380" }] });
    await setGeneralPurchaseQty(fx.roles.pm.actor, { itemBrandId: fx.ibAcc.id, quantity: "30" });
    const g = (await row()).general(fx.ibAcc.id);
    expect(g).toMatchObject({ manualQty: "110", manualLeft: "30", toOrder: "30" });
    expect((await errorOf(saveRequirement(fx.roles.pm.actor, { itemBrandId: fx.ibAcc.id, requiredQty: "50" }))).message).toMatch(/80 Bag is already on/);
    // General items without any planning attributes or requirement do not appear.
    expect((await row()).rows.filter((x) => x.scope === "GENERAL").map((x) => x.itemBrandId)).toEqual([fx.ibAcc.id]);
  });

  it("permissions: ordering needs the procurement permission and access to every project on the order", async () => {
    await setup();
    const p1Req = (await row()).project(fx.ibUltra.id);
    expect((await errorOf(createPoFromPlanning(fx.roles.vw.actor, { partyId: fx.supplier.id, lines: [{ requirementId: p1Req.requirementId, itemBrandId: fx.ibUltra.id, quantity: "1", rate: "400" }] }))).message).toMatch(/permission/);
    expect((await errorOf(createRfqFromPlanning(fx.roles.se.actor, { supplierIds: [fx.supplier.id], lines: [{ requirementId: p1Req.requirementId, itemBrandId: fx.ibUltra.id, quantity: "1" }] }))).message).toMatch(/permission/);
    expect((await errorOf(setGeneralPurchaseQty(fx.roles.vw.actor, { itemBrandId: fx.ibAcc.id, quantity: "5" }))).message).toMatch(/permission/);
    expect((await errorOf(setPlanningAttributes(fx.roles.vw.actor, fx.ibAcc.id, { reorderLevel: "1" }))).message).toMatch(/permission/);
    // Requirements of projects a user cannot access are never shown (nor revealed by id).
    const p2Req = await saveRequirement(fx.roles.pm.actor, { projectId: fx.p2.id, itemBrandId: fx.ibUltra.id, requiredQty: "10" });
    expect((await getMrp(fx.roles.se.actor, { scope: "all" })).rows.some((x) => x.requirementId === p2Req.id)).toBe(false);
    expect((await errorOf(getMrp(fx.roles.outsider.actor, { projectId: fx.p1.id }))).message).toMatch(/not found/i);
    // The purchase team (sees all projects) can combine two projects on one PO; the document then has no project.
    const both = await createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: p1Req.requirementId, itemBrandId: fx.ibUltra.id, quantity: "5", rate: "400" }, { requirementId: p2Req.id, itemBrandId: fx.ibUltra.id, quantity: "10", rate: "400" }] });
    const lines = await db.poLine.findMany({ where: { poId: both.id }, orderBy: { lineNo: "asc" }, select: { requirementId: true, po: { select: { projectId: true } } } });
    expect(lines.map((l) => l.requirementId)).toEqual([p1Req.requirementId, p2Req.id]);
    expect(lines[0]!.po.projectId).toBeNull();
    // Target below minimum is rejected.
    expect((await errorOf(setPlanningAttributes(fx.roles.pu.actor, fx.ibAcc.id, { reorderLevel: "50", targetStock: "10" }))).message).toMatch(/Target stock cannot be below/);
  });
});
