import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createPoFromPlanning, createRfqFromPlanning } from "@/modules/planning/ordering";
import { getMrp } from "@/modules/planning/service";
import { createPo, getPo, poAction } from "@/modules/procurement/po";
import { convertQuotationToPo, getRfq, recordQuotation } from "@/modules/procurement/rfq";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { commercialFixture, day, errorOf, type CFx } from "./commercial-helpers";

/**
 * Workflow v2 · Phase 3 — simplified rate enquiries and purchase orders: RFQ from the sales order /
 * planning, quotation → PO without comparison or award, Finalize (one approval), allocations and
 * duplicate prevention, permissions.
 */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

const soVer = async (id: string) => (await db.salesOrder.findUniqueOrThrow({ where: { id } })).version;
const poVer = async (id: string) => (await db.purchaseOrder.findUniqueOrThrow({ where: { id } })).version;

async function soNeeds(qty = "300") {
  const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), deliveryDate: day(14), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "450", gstRate: "28" }] });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await soVer(so.id) });
  const row = (await getMrp(fx.roles.pu.actor, { projectId: fx.p1.id })).rows.find((r) => r.itemBrandId === fx.ibUltra.id)!;
  return { so: await db.salesOrder.findUniqueOrThrow({ where: { id: so.id } }), row };
}

const planRow = async () => (await getMrp(fx.roles.pu.actor, { projectId: fx.p1.id })).rows.find((r) => r.itemBrandId === fx.ibUltra.id)!;

async function enquiryWithQuotes() {
  const { so, row } = await soNeeds();
  const rfq = await createRfqFromPlanning(fx.roles.pu.actor, { supplierIds: [fx.supplier.id, fx.supplier2.id], lines: [{ requirementId: row.requirementId, itemBrandId: fx.ibUltra.id, quantity: "300" }] });
  const rl = await db.rfqLine.findFirstOrThrow({ where: { rfqId: rfq.id } });
  const q1 = await recordQuotation(fx.roles.pu.actor, { rfqId: rfq.id, partyId: fx.supplier.id, quoteDate: day(), freight: "1500", freightGstRate: "18", deliveryDays: 5, advancePct: "20", creditDays: 30, paymentTerms: "Balance on delivery", lines: [{ rfqLineId: rl.id, itemBrandId: fx.ibUltra.id, quantity: "300", rate: "390", gstRate: "28" }] });
  const q2 = await recordQuotation(fx.roles.pu.actor, { rfqId: rfq.id, partyId: fx.supplier2.id, quoteDate: day(), lines: [{ rfqLineId: rl.id, itemBrandId: fx.ibUltra.id, quantity: "300", rate: "395", gstRate: "28" }] });
  return { so, row, rfq, rl, q1, q2 };
}

describe("rate enquiry from the sales order / planning", () => {
  it("carries items, brand, quantity, project, delivery address and the sales order reference", async () => {
    const { so, rfq, rl, row } = await enquiryWithQuotes();
    const saved = await db.rfq.findUniqueOrThrow({ where: { id: rfq.id }, include: { suppliers: true } });
    expect(saved.projectId).toBe(fx.p1.id);
    expect(saved.prId).toBeNull(); // no requisition step
    expect(saved.suppliers.map((s) => s.partyId).sort()).toEqual([fx.supplier.id, fx.supplier2.id].sort());
    expect([rl.itemBrandId, rl.quantity.toString(), rl.requirementId]).toEqual([fx.ibUltra.id, "300", row.requirementId]);
    expect(rl.specifications).toContain(`SO ${so.number}`);
  });
});

describe("quotation → purchase order (comparison optional)", () => {
  it("converts one quotation directly, with its rates, freight, delivery and payment terms, keeping the allocation", async () => {
    const { rfq, q1, row } = await enquiryWithQuotes();
    const ql = await db.quotationLine.findFirstOrThrow({ where: { quotationId: q1.id } });
    const po = await convertQuotationToPo(fx.roles.pu.actor, { quotationId: q1.id, lines: [{ quotationLineId: ql.id, quantity: "200" }] });
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect([saved.status, saved.projectId, saved.partyId, saved.rfqId, saved.prId]).toEqual(["DRAFT", fx.p1.id, fx.supplier.id, rfq.id, null]);
    expect([saved.lines[0]!.quantity.toString(), saved.lines[0]!.rate.toFixed(2), saved.lines[0]!.requirementId, saved.lines[0]!.quotationLineId]).toEqual(["200", "390.00", row.requirementId, ql.id]);
    expect([saved.charges.toFixed(2), saved.creditDays, saved.paymentTerms]).toEqual(["1500.00", 30, "20% advance · 30 days credit · Balance on delivery"]);
    expect(saved.expectedDate!.getTime()).toBe(new Date(day(5)).getTime());
    expect((await db.supplierQuotation.findUniqueOrThrow({ where: { id: q1.id } })).status).toBe("AWARDED");
    // Planning: 200 on the PO + 100 still open on the enquiry = fully allocated, nothing to order.
    expect(await planRow()).toMatchObject({ poPipeline: "200", openRfq: "100", maxOrderQty: "0", toOrder: "0" });
    const view = await getRfq(fx.roles.pu.actor, rfq.id);
    expect(view.rfq.lines[0]).toMatchObject({ orderedQty: "200", openQty: "100" });
  });

  it("splits the rest to another supplier, never beyond what is open; concurrent conversions cannot double order", async () => {
    const { rfq, q1, q2 } = await enquiryWithQuotes();
    const ql1 = await db.quotationLine.findFirstOrThrow({ where: { quotationId: q1.id } });
    const ql2 = await db.quotationLine.findFirstOrThrow({ where: { quotationId: q2.id } });
    await convertQuotationToPo(fx.roles.pu.actor, { quotationId: q1.id, lines: [{ quotationLineId: ql1.id, quantity: "200" }] });
    expect((await errorOf(convertQuotationToPo(fx.roles.pu.actor, { quotationId: q2.id, lines: [{ quotationLineId: ql2.id, quantity: "150" }] }))).message).toMatch(/only 100 Bag is still open/);
    // Two people press "Create PO" on the second quotation at once: one PO for the remaining 100.
    const attempts = await Promise.allSettled([convertQuotationToPo(fx.roles.pu.actor, { quotationId: q2.id }), convertQuotationToPo(fx.roles.pu.actor, { quotationId: q2.id })]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const pos = await db.purchaseOrder.findMany({ where: { rfqId: rfq.id }, include: { lines: true } });
    expect(pos.map((p) => p.lines[0]!.quantity.toString()).sort()).toEqual(["100", "200"]);
    expect((await db.rfq.findUniqueOrThrow({ where: { id: rfq.id } })).status).toBe("AWARDED");
    expect((await errorOf(convertQuotationToPo(fx.roles.pu.actor, { quotationId: q1.id }))).message).toMatch(/Nothing left to order/);
    expect(await planRow()).toMatchObject({ poPipeline: "300", openRfq: "0", toOrder: "0", maxOrderQty: "0" });
    // Cancelling a PO frees its quantity on the enquiry again.
    const p100 = pos.find((p) => p.lines[0]!.quantity.toString() === "100")!;
    await poAction(fx.actors.superAdmin, p100.id, "cancel", { version: p100.version, note: "Supplier cannot deliver" });
    expect(await planRow()).toMatchObject({ poPipeline: "200", openRfq: "100" });
  });

  it("refuses superseded quotations and users without purchase-order permission", async () => {
    const { q1, rfq, rl } = await enquiryWithQuotes();
    expect((await errorOf(convertQuotationToPo(fx.roles.vw.actor, { quotationId: q1.id }))).message).toMatch(/permission/);
    expect((await errorOf(convertQuotationToPo(fx.roles.se.actor, { quotationId: q1.id }))).message).toMatch(/permission/);
    await recordQuotation(fx.roles.pu.actor, { rfqId: rfq.id, partyId: fx.supplier.id, quoteDate: day(), replacesId: q1.id, lines: [{ rfqLineId: rl.id, itemBrandId: fx.ibUltra.id, quantity: "300", rate: "385", gstRate: "28" }] });
    expect((await errorOf(convertQuotationToPo(fx.roles.pu.actor, { quotationId: q1.id }))).message).toMatch(/current quotation/);
  });
});

describe("Finalize: one step, no approval wait (simplified workflow)", () => {
  const draft = async (actor = fx.roles.pu.actor) => createPo(actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "10", rate: "400", gstRate: "28" }] });

  it("any purchase user finalizes their own PO at once — no separation of duties or amount limit", async () => {
    const a = await draft();
    expect((await getPo(fx.roles.pu.actor, a.id)).can).toMatchObject({ finalize: true, finalizeApproves: true, amend: false, requestChange: false });
    expect(await poAction(fx.roles.pu.actor, a.id, "finalize", { version: await poVer(a.id) })).toEqual({ approved: true });
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "APPROVED", approvedById: fx.roles.pu.user.id, submittedById: fx.roles.pu.user.id });
    // Once final, the buyer can only ask the Super Admin for a change.
    expect((await getPo(fx.roles.pu.actor, a.id)).can).toMatchObject({ amend: false, cancel: false, requestChange: true });
    expect((await getPo(fx.actors.superAdmin, a.id)).can).toMatchObject({ amend: true, cancel: true, requestChange: false });
    // An approval limit configured earlier no longer blocks daily work.
    await db.approvalLimit.create({ data: { organizationId: fx.org.id, roleKey: "PURCHASE", docType: "PO", maxAmount: "100" } }).catch(() => null);
    const e = await draft();
    expect(await poAction(fx.roles.pu.actor, e.id, "finalize", { version: await poVer(e.id) })).toEqual({ approved: true });
    const b = await draft();
    await poAction(fx.roles.pu.actor, b.id, "finalize", { version: await poVer(b.id) });
    // Only drafts can be finalized; no permission → refused.
    expect((await errorOf(poAction(fx.actors.admin, b.id, "finalize", { version: await poVer(b.id) }))).message).toMatch(/./);
    const f = await draft();
    expect((await errorOf(poAction(fx.roles.vw.actor, f.id, "finalize", { version: await poVer(f.id) }))).message).toMatch(/permission|not found/i);
  });

  it("detail page data: ordered, received, pending, related actions", async () => {
    const po = await draft();
    const view = await getPo(fx.roles.pu.actor, po.id);
    expect(view.po.lines[0]).toMatchObject({ quantity: "10", acceptedQty: "0", pendingQty: "10" });
    expect(view.can).toMatchObject({ finalize: true, receive: false, pay: false });
  });
});

describe("direct purchase orders (no enquiry, no requisition)", () => {
  it("project, general-stock and combined purchases from planning; duplicates refused", async () => {
    const { row } = await soNeeds("50");
    const po = await createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: row.requirementId, itemBrandId: fx.ibUltra.id, quantity: "50", rate: "400" }] });
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect([saved.projectId, saved.prId, saved.rfqId]).toEqual([fx.p1.id, null, null]);
    expect((await errorOf(createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: row.requirementId, itemBrandId: fx.ibUltra.id, quantity: "1", rate: "400" }] }))).message).toMatch(/only 0 Bag still needs ordering/);
    // General stock with no project, ordered directly.
    const general = await createPo(fx.roles.pu.actor, { partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibAcc.id, quantity: "20", rate: "380", gstRate: "28" }] });
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: general.id } })).projectId).toBeNull();
  });
});
