import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { inventoryIntegrityReport } from "@/modules/inventory/integrity";
import { reserveStock } from "@/modules/inventory/locations";
import { stockOverview } from "@/modules/inventory/overview";
import { postStockMovement, setItemStatus } from "@/modules/inventory/service";
import { setPlanningAttributes } from "@/modules/planning/service";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { challanAction, createChallan } from "@/modules/stores/challan";
import { createGrn, getGrn, grnAction } from "@/modules/stores/grn";
import { issueMaterialToSite, siteIssueData } from "@/modules/stores/site-issue";
import { actorFor } from "./helpers";
import { PDF, addReceiptProof, commercialFixture, day, errorOf, key, receiveWithProof, type CFx } from "./commercial-helpers";

/** Workflow v2 · Phase 5 — stock overview, issue material to site, site receipts with proof, owner-only adjustments. */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "salesOrder" | "grn" | "challan";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;
const bal = async (locationId: string, ib = fx.ibUltra.id) => (await db.stockBalance.findFirst({ where: { itemBrandId: ib, locationId } }))?.onHand.toString() ?? "0";
const site = async (projectId = fx.p1.id) => (await db.stockLocation.findFirstOrThrow({ where: { projectId } })).id;
const quarantine = async () => (await db.stockLocation.findFirstOrThrow({ where: { organizationId: fx.org.id, code: "QC-HOLD" } })).id;

async function soNeed(qty: string, projectId = fx.p1.id) {
  const so = await createSalesOrder(fx.roles.pm.actor, { projectId, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "450", gstRate: "28" }] });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
  return so;
}
const issue = (qty: string, extra: Record<string, unknown> = {}) => issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty }], ...extra });

describe("issue material to site", () => {
  it("lists sales-order materials with issued, remaining and available stock", async () => {
    await soNeed("60");
    const data = await siteIssueData(fx.roles.sk.actor, fx.p1.id);
    expect(data.fromLocationId).toBe(fx.warehouse.id);
    expect(data.rows[0]).toMatchObject({ itemBrandId: fx.ibUltra.id, required: "60", issued: "0", remaining: "60", atWarehouse: "100", available: "100", suggested: "60" });
  });

  it("draft: no stock moves; issued: warehouse → in transit; site receipt with proof: in transit → site", async () => {
    await soNeed("60");
    const draft = await issue("60", { issueNow: false });
    expect(draft.status).toBe("DRAFT");
    expect([await bal(fx.warehouse.id), await bal(fx.transit.id)]).toEqual(["100", "0"]);
    await challanAction(fx.roles.sk.actor, draft.id, "cancel", { version: await v("challan", draft.id), note: "Wrong date" });

    const c = await issue("60");
    expect(c.status).toBe("DISPATCHED");
    expect([await bal(fx.warehouse.id), await bal(fx.transit.id)]).toEqual(["40", "60"]);
    const data = await siteIssueData(fx.roles.sk.actor, fx.p1.id);
    expect(data.rows[0]).toMatchObject({ issued: "60", inTransit: "60", remaining: "0", suggested: "0" });

    // Site receipt: proof (photo + signed challan, + damage photo) is mandatory.
    const line = await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } });
    expect((await errorOf(createGrn(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), submit: true, lines: [{ challanLineId: line.id, receivedQty: "50" }] }))).message).toMatch(/Material photos; Signed challan/);
    const g = await createGrn(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: "50", damagedQty: "5" }] });
    expect((await getGrn(fx.roles.se.actor, g.id)).proof.missing).toEqual(["Material photos", "Signed challan", "Damaged / rejected material"]);
    await addReceiptProof(fx.roles.se.actor, g.id);
    expect((await errorOf(grnAction(fx.roles.se.actor, g.id, "submit", { version: await v("grn", g.id) }))).message).toMatch(/Damaged \/ rejected material/);
    await addReceiptProof(fx.roles.se.actor, g.id, { photo: false, challan: false, damage: true });
    await grnAction(fx.roles.se.actor, g.id, "submit", { version: await v("grn", g.id) });
    // Partial receipt with damage: 50 left transit, 45 to site, 5 to quarantine; 10 still in transit (shortage).
    expect([await bal(fx.transit.id), await bal(await site()), await bal(await quarantine())]).toEqual(["10", "45", "5"]);
    expect((await db.challan.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PARTIALLY_RECEIVED");
    // Shortage closed by returning it to the warehouse.
    await challanAction(fx.roles.sk.actor, c.id, "close_discrepancy", { version: await v("challan", c.id), note: "10 bags not loaded", resolution: "RETURN" });
    expect([await bal(fx.transit.id), await bal(fx.warehouse.id)]).toEqual(["0", "50"]);

    // Overview reflects every bucket.
    const ov = (await stockOverview(fx.roles.sk.actor, { q: "OPC" })).rows.find((r) => r.itemBrandId === fx.ibUltra.id)!;
    expect(ov).toMatchObject({ physical: "95", available: "50", inTransit: "0", site: "45", damaged: "5" });

    // Return to store from the site (with proof at the warehouse).
    const ret = await createChallan(fx.roles.sk.actor, { type: "RETURN_TO_STORE", fromLocationId: await site(), toLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "5" }] });
    await challanAction(fx.roles.sk.actor, ret.id, "dispatch", { version: await v("challan", ret.id) });
    const rl = await db.challanLine.findFirstOrThrow({ where: { challanId: ret.id } });
    await receiveWithProof(fx.roles.sk.actor, { clientKey: key(), challanId: ret.id, receiptDate: day(), lines: [{ challanLineId: rl.id, receivedQty: "5" }] });
    expect([await bal(await site()), await bal(fx.warehouse.id)]).toEqual(["40", "55"]);
    expect((await inventoryIntegrityReport(fx.org.id)).errors).toBe(0);
  });

  it("a repeated tap returns the same challan; concurrent issues can never take more than is available", async () => {
    await soNeed("150");
    const k = key();
    const same = await Promise.all([issue("10", { clientKey: k }), issue("10", { clientKey: k })]);
    expect(same[0].id).toBe(same[1].id);
    expect(await db.challan.count({ where: { clientKey: k } })).toBe(1);
    expect(await bal(fx.warehouse.id)).toBe("90");
    // 90 left: two issues of 60 at once → exactly one succeeds; stock never negative; nothing half-posted.
    const r = await Promise.allSettled([issue("60"), issue("60")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await bal(fx.warehouse.id)).toBe("30");
    expect(await db.challan.count({ where: { projectId: fx.p1.id, status: "DRAFT" } })).toBe(0);
  });

  it("stock reserved for another project cannot be issued", async () => {
    await soNeed("100");
    await reserveStock(fx.actors.admin, { projectId: fx.p2.id, itemBrandId: fx.ibUltra.id, locationId: fx.warehouse.id, quantity: "70" });
    expect((await siteIssueData(fx.roles.sk.actor, fx.p1.id)).rows[0]).toMatchObject({ atWarehouse: "100", available: "30", suggested: "30" });
    expect((await errorOf(issue("31"))).message).toMatch(/reserved|Insufficient/i);
    expect(await bal(fx.warehouse.id)).toBe("100");
    await issue("30");
    expect(await bal(fx.warehouse.id)).toBe("70");
  });

  it("reversing a site receipt puts the stock back in transit (history kept)", async () => {
    await soNeed("20");
    const c = await issue("20");
    const line = await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } });
    const g = await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: "20" }] });
    expect([await bal(fx.transit.id), await bal(await site())]).toEqual(["0", "20"]);
    await grnAction(fx.actors.superAdmin, g.id, "reverse", { version: await v("grn", g.id), note: "Recorded against the wrong challan" });
    expect([await bal(fx.transit.id), await bal(await site())]).toEqual(["20", "0"]);
    expect(await db.stockTransaction.count({ where: { sourceType: "grn", sourceId: g.id } })).toBe(4);
    expect((await inventoryIntegrityReport(fx.org.id)).errors).toBe(0);
  });

  it("permissions: needs stock transfer and project access", async () => {
    expect((await errorOf(siteIssueData(fx.roles.vw.actor, fx.p1.id))).message).toMatch(/permission/);
    expect((await errorOf(issueMaterialToSite(fx.roles.outsider.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "1" }] }))).message).toMatch(/permission|not found/i);
  });
});

describe("stock overview", () => {
  it("shows incoming and the reorder quantity", async () => {
    await setPlanningAttributes(fx.roles.pu.actor, fx.ibAcc.id, { reorderLevel: "50", targetStock: "120" });
    const ov = (await stockOverview(fx.roles.sk.actor, { filter: "reorder" })).rows;
    expect(ov.map((r) => [r.itemBrandId, r.available, r.reorderQty])).toEqual([[fx.ibAcc.id, "40", "80"]]);
  });
});

describe("manual stock changes: owner only, with reason and evidence", () => {
  const input = (extra: Record<string, unknown> = {}) => ({ itemBrandId: fx.ibUltra.id, type: "ADJUSTMENT", direction: "OUT", quantity: "2", txnDate: day(), reason: "Bags torn in storage", idempotencyKey: key(), ...extra });
  const evidence = { fileName: "photo.pdf", bytes: PDF };

  it("Super Admin with reason + evidence; the evidence is kept with the entry", async () => {
    expect((await errorOf(postStockMovement(fx.actors.superAdmin, input()))).message).toMatch(/Attach evidence/);
    expect(((await errorOf(postStockMovement(fx.actors.superAdmin, input({ reason: "" }), evidence))) as { fieldErrors?: Record<string, string> }).fieldErrors?.reason).toBeTruthy();
    expect((await errorOf(postStockMovement(fx.actors.superAdmin, input(), { fileName: "x.exe", bytes: new Uint8Array([1, 2, 3]) }))).message).toMatch(/Unsupported/);
    const { txn } = await postStockMovement(fx.actors.superAdmin, input(), evidence);
    expect(await bal(fx.warehouse.id)).toBe("98");
    const file = await db.attachment.findFirstOrThrow({ where: { entityType: "stock_txn", entityId: txn.id } });
    expect(file.description).toMatch(/Bags torn/);
    // Unsupported evidence or a failed posting stores nothing.
    expect(await db.attachment.count({ where: { entityType: "stock_txn" } })).toBe(1);
    // Never below zero.
    expect((await errorOf(postStockMovement(fx.actors.superAdmin, input({ quantity: "99" }), evidence))).message).toMatch(/Insufficient stock/);
    expect(await db.attachment.count({ where: { entityType: "stock_txn" } })).toBe(1);
  });

  it("nobody else can, even when the permission row is granted to their role", async () => {
    for (const a of [fx.actors.admin, fx.roles.sk.actor, fx.roles.pm.actor]) expect((await errorOf(postStockMovement(a, input(), evidence))).message).toMatch(/permission/);
    const perm = await db.permission.findUniqueOrThrow({ where: { key: "stock.adjust" } });
    const role = await db.role.findUniqueOrThrow({ where: { key: "STOREKEEPER" } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    const sk = await actorFor(fx.roles.sk.user.id);
    expect((await errorOf(postStockMovement(sk, input(), evidence))).message).toMatch(/permission/);
    expect(await bal(fx.warehouse.id)).toBe("100");
  });

  it("inactive items cannot be adjusted", async () => {
    await setItemStatus(fx.actors.admin, fx.item.id, "INACTIVE");
    expect((await errorOf(postStockMovement(fx.actors.superAdmin, input(), evidence))).message).toMatch(/inactive/);
  });
});
