import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordConsumption } from "@/modules/inventory/locations";
import { ledgerBalance } from "@/modules/inventory/repository";
import { getMrp, saveRequirement } from "@/modules/planning/service";
import { createPo, getPo, poAction, updatePo } from "@/modules/procurement/po";
import { createPr, createPrFromMrp, prAction } from "@/modules/procurement/pr";
import { createPosFromAward, createRfq, getRfq, proposeAward, recordQuotation, rfqAction } from "@/modules/procurement/rfq";
import { challanAction, createChallan, getChallan } from "@/modules/stores/challan";
import { createGrn, grnAction } from "@/modules/stores/grn";
import { addReceiptProof, commercialFixture, day, errorOf, key, type CFx, receiveWithProof } from "./commercial-helpers";

let fx: CFx;
const grnVer = async (id: string) => (await db.grn.findUniqueOrThrow({ where: { id } })).version;
beforeEach(async () => {
  fx = await commercialFixture();
});

const v = async (model: "purchaseOrder" | "purchaseRequisition" | "grn" | "rfq" | "challan", id: string) => ((await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version);

async function approvedPo(qty = "50", extra: Record<string, unknown> = {}) {
  const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), expectedDate: day(5), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "380", gstRate: "28" }], ...extra });
  await poAction(fx.roles.pu.actor, po.id, "submit", { version: await v("purchaseOrder", po.id) });
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
}

const receive = (poId: string, lineId: string, received: string, extra: Record<string, string> = {}) =>
  receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId, receiptDate: day(), lines: [{ poLineId: lineId, receivedQty: received, ...extra }] });

const siteBalance = async (projectId = fx.p1.id, ib = fx.ibUltra.id) => {
  const loc = await db.stockLocation.findUnique({ where: { projectId } });
  if (!loc) return "0";
  const b = await db.stockBalance.findUnique({ where: { itemBrandId_locationId: { itemBrandId: ib, locationId: loc.id } } });
  return b ? b.onHand.toFixed(0) : "0";
};

describe("purchase orders", () => {
  it("computes GST server-side; the buyer finalizes the PO in one step, others cannot", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), charges: "500", chargesGstRate: "18", lines: [{ itemBrandId: fx.ibUltra.id, quantity: "10", rate: "380.50", discountPct: "2", gstRate: "28" }] });
    // 10 × 380.50 = 3805.00, −2% = 3728.90 taxable; CGST/SGST 14% = 522.05 each; freight 500 + 18% = 590 → 5362.99 → rounded 5363
    expect([po.taxable.toFixed(2), po.cgst.toFixed(2), po.sgst.toFixed(2), po.igst.toFixed(2), po.total.toFixed(2)]).toEqual(["3728.90", "567.05", "567.05", "0.00", "5363.00"]);
    expect((await errorOf(poAction(fx.roles.se.actor, po.id, "submit", { version: 1 }))).message).toMatch(/permission|not found/i);
    await poAction(fx.roles.pu.actor, po.id, "submit", { version: 1 });
    const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect([row.status, row.approvedById]).toEqual(["APPROVED", fx.roles.pu.user.id]);
  });

  it("uses IGST for an inter-state supplier", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier2.id, orderDate: day(), roundToRupee: false, lines: [{ itemBrandId: fx.ibAcc.id, quantity: "4", rate: "100", gstRate: "18" }] });
    expect([po.taxMode, po.igst.toFixed(2), po.cgst.toFixed(2), po.total.toFixed(2)]).toEqual(["INTER", "72.00", "0.00", "472.00"]);
  });

  it("blocks receipts against unapproved orders (unless the exception is switched on)", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "5", rate: "1", gstRate: "28" }] });
    const line = (await db.poLine.findFirstOrThrow({ where: { poId: po.id } })).id;
    expect((await errorOf(receive(po.id, line, "5"))).message).toMatch(/approved, open purchase orders/);
    await poAction(fx.roles.pu.actor, po.id, "submit", { version: 1 });
    await db.orgSettings.update({ where: { organizationId: fx.org.id }, data: { allowReceiptOnUnapprovedPo: true } });
    await receive(po.id, line, "5");
  });
});

describe("site receipts (GRN) and stock posting", () => {
  it("partial deliveries, multiple GRNs, stock lands at the SITE on confirmation, rejected never enters stock", async () => {
    const po = await approvedPo("50");
    const line = po.lines[0]!;
    const draft = await createGrn(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: line.id, receivedQty: "30", damagedQty: "2", rejectedQty: "3" }] });
    expect(await siteBalance()).toBe("0"); // a draft moves no stock
    await db.grn.delete({ where: { id: draft.id } });
    await receive(po.id, line.id, "30", { damagedQty: "2", rejectedQty: "3" }); // confirmed with proof → posted
    expect(await siteBalance()).toBe("25");
    const wh = await db.stockBalance.findUnique({ where: { itemBrandId_locationId: { itemBrandId: fx.ibUltra.id, locationId: fx.warehouse.id } } });
    expect(wh?.onHand.toFixed(0)).toBe("100"); // central warehouse untouched
    let pl = await db.poLine.findUniqueOrThrow({ where: { id: line.id } });
    expect([pl.receivedQty.toFixed(0), pl.acceptedQty.toFixed(0), pl.rejectedQty.toFixed(0)]).toEqual(["30", "25", "5"]);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("PARTIALLY_RECEIVED");
    await receive(po.id, line.id, "25");
    pl = await db.poLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(pl.acceptedQty.toFixed(0)).toBe("50");
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("FULLY_RECEIVED");
    expect(await ledgerBalance(fx.ibUltra.id)).toEqual({ ledger: "150", current: "150" });
    const ib = await db.itemBrand.findUniqueOrThrow({ where: { id: fx.ibUltra.id } });
    expect(ib.lastPurchaseRate?.toFixed(4)).toBe("380.0000");
  });

  it("two people receiving the same PO at once cannot exceed the ordered quantity", async () => {
    const po = await approvedPo("40");
    const line = po.lines[0]!.id;
    const r = await Promise.allSettled([receive(po.id, line, "30"), receiveWithProof(fx.roles.sk.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: line, receivedQty: "30" }] })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failure = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(failure.reason.message)).toMatch(/exceed the ordered quantity/);
    expect(await siteBalance()).toBe("30");
  });

  it("confirming the same receipt twice (double click / two people) posts once", async () => {
    const po = await approvedPo("10");
    const g = await createGrn(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "10" }] });
    await addReceiptProof(fx.roles.se.actor, g.id);
    const gv = await grnVer(g.id);
    const r = await Promise.allSettled([grnAction(fx.roles.se.actor, g.id, "submit", { version: gv }), grnAction(fx.roles.sk.actor, g.id, "submit", { version: gv })]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await siteBalance()).toBe("10");
    expect(await db.stockTransaction.count({ where: { sourceType: "grn", sourceId: g.id } })).toBe(1);
  });

  it("a repeated save from a phone returns the same receipt", async () => {
    const po = await approvedPo("10");
    const k = key();
    const input = { clientKey: k, poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "4" }] };
    const [a, b] = await Promise.all([createGrn(fx.roles.se.actor, input), createGrn(fx.roles.se.actor, input)]);
    expect(a.id).toBe(b.id);
    expect(await db.grn.count({ where: { poId: po.id } })).toBe(1);
  });

  it("the receiver confirms their own receipt (no second person); outsiders cannot record receipts for the project", async () => {
    const po = await approvedPo("10");
    const g = await receiveWithProof(fx.roles.sk.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "1" }] });
    const row = await db.grn.findUniqueOrThrow({ where: { id: g.id } });
    expect([row.status, row.postedById]).toEqual(["POSTED", fx.roles.sk.user.id]);
    expect((await errorOf(createGrn(fx.roles.outsider.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "1" }] }))).message).toMatch(/not found/i);
  });

  it("reverses a posted receipt, but not once the stock has been consumed", async () => {
    const po = await approvedPo("10");
    const g = await receive(po.id, po.lines[0]!.id, "10");
    await recordConsumption(fx.roles.se.actor, { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id, quantity: "6", txnDate: day(), idempotencyKey: key() });
    // Reversal needs grn.reverse (Admins); the storekeeper cannot.
    expect((await errorOf(grnAction(fx.roles.sk.actor, g.id, "reverse", { version: await v("grn", g.id), note: "Wrong PO" }))).message).toMatch(/permission/);
    expect((await errorOf(grnAction(fx.actors.admin, g.id, "reverse", { version: await v("grn", g.id), note: "Wrong PO" }))).message).toMatch(/Insufficient stock/);
    await recordConsumption(fx.roles.se.actor, { projectId: fx.p1.id, itemBrandId: fx.ibAcc.id, quantity: "1", txnDate: day(), idempotencyKey: key() }).catch(() => null);
    const po2 = await approvedPo("5");
    const g2 = await receive(po2.id, po2.lines[0]!.id, "5");
    await grnAction(fx.actors.admin, g2.id, "reverse", { version: await v("grn", g2.id), note: "Duplicate delivery note" });
    const pl = await db.poLine.findUniqueOrThrow({ where: { id: po2.lines[0]!.id } });
    expect(pl.acceptedQty.toFixed(0)).toBe("0");
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po2.id } })).status).toBe("APPROVED");
    expect(await siteBalance()).toBe("4");
  });
});

describe("PO amendments, cancellation and closure", () => {
  it("an approved PO is amended (snapshot + re-approval), never edited in place; received quantities are protected", async () => {
    const po = await approvedPo("20");
    await receive(po.id, po.lines[0]!.id, "8");
    const ver = await v("purchaseOrder", po.id);
    expect((await errorOf(updatePo(fx.roles.pu.actor, po.id, ver, { partyId: fx.supplier.id, projectId: fx.p1.id, orderDate: day(), lines: [{ id: po.lines[0]!.id, itemBrandId: fx.ibUltra.id, quantity: "25", rate: "380", gstRate: "28" }] }))).message).toMatch(/Use Amend/);
    // Amending a finalized PO needs po.approve (Admins) — no Super Admin step.
    expect((await errorOf(poAction(fx.roles.pu.actor, po.id, "amend", { version: ver, note: "Client increased quantity" }))).message).toMatch(/permission/);
    await poAction(fx.actors.admin, po.id, "amend", { version: ver, note: "Client increased quantity" });
    expect((await errorOf(updatePo(fx.roles.pu.actor, po.id, ver + 1, { partyId: fx.supplier.id, projectId: fx.p1.id, orderDate: day(), lines: [{ id: po.lines[0]!.id, itemBrandId: fx.ibUltra.id, quantity: "5", rate: "380", gstRate: "28" }] }))).message).toMatch(/cannot be below/);
    await updatePo(fx.roles.pu.actor, po.id, ver + 1, { partyId: fx.supplier.id, projectId: fx.p1.id, orderDate: day(), lines: [{ id: po.lines[0]!.id, itemBrandId: fx.ibUltra.id, quantity: "25", rate: "380", gstRate: "28" }, { itemBrandId: fx.ibAcc.id, quantity: "5", rate: "360", gstRate: "28" }] });
    await poAction(fx.roles.pu.actor, po.id, "submit", { version: await v("purchaseOrder", po.id) });
    // (an admin who is not on the project cannot even see the PO — approvers need project access)
    const after = await getPo(fx.actors.admin, po.id);
    expect(after.po.status).toBe("PARTIALLY_RECEIVED");
    expect(after.po.revision).toBe(1);
    expect(after.po.revisions).toHaveLength(1);
    expect(after.po.lines.map((l) => [l.quantity, l.acceptedQty])).toEqual([["25", "8"], ["5", "0"]]);
  });

  it("a partially received PO cannot be cancelled, but can be short-closed (releasing the requisition)", async () => {
    const pr = await createPr(fx.roles.se.actor, { projectId: fx.p1.id, lines: [{ itemBrandId: fx.ibUltra.id, quantity: "20" }] });
    await prAction(fx.roles.se.actor, pr.id, "submit", { version: 1 });
    const prLine = await db.prLine.findFirstOrThrow({ where: { prId: pr.id } });
    const po = await approvedPo("20", { prId: pr.id, lines: [{ itemBrandId: fx.ibUltra.id, quantity: "20", rate: "380", gstRate: "28", prLineId: prLine.id }] });
    expect((await db.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("ORDERED");
    await receive(po.id, po.lines[0]!.id, "12");
    expect((await errorOf(poAction(fx.roles.pu.actor, po.id, "close", { version: await v("purchaseOrder", po.id), note: "x" }))).message).toMatch(/permission/);
    expect((await errorOf(poAction(fx.actors.admin, po.id, "cancel", { version: await v("purchaseOrder", po.id), note: "x" }))).message).toMatch(/Short-close/);
    await poAction(fx.actors.admin, po.id, "close", { version: await v("purchaseOrder", po.id), note: "Supplier cannot supply balance" });
    expect((await db.prLine.findUniqueOrThrow({ where: { id: prLine.id } })).orderedQty.toFixed(0)).toBe("12");
    expect((await db.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id } })).status).toBe("PARTIALLY_ORDERED");
    // the requisition cannot be over-ordered
    expect((await errorOf(createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "9", rate: "1", gstRate: "28", prLineId: prLine.id }] }))).message).toMatch(/exceed the requisitioned quantity/);
  });
});

describe("transfers & challans", () => {
  it("dispatch puts stock in transit; partial receipt; discrepancy write-off; nothing counted twice", async () => {
    const c = await createChallan(fx.roles.sk.actor, { type: "ISSUE_TO_SITE", projectId: fx.p1.id, fromLocationId: fx.warehouse.id, dispatchDate: day(), vehicleNo: "MH12AB1234", lines: [{ itemBrandId: fx.ibUltra.id, quantity: "20" }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: 1 });
    const transit = async () => (await db.stockBalance.findUnique({ where: { itemBrandId_locationId: { itemBrandId: fx.ibUltra.id, locationId: fx.transit.id } } }))?.onHand.toFixed(0);
    expect(await transit()).toBe("20");
    expect(await siteBalance()).toBe("0");
    const detail = await getChallan(fx.actors.admin, c.id);
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: detail.challan.lines[0]!.id, receivedQty: "15", damagedQty: "1" }] });
    expect([await transit(), await siteBalance()]).toEqual(["5", "14"]);
    expect((await db.challan.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("PARTIALLY_RECEIVED");
    expect((await errorOf(challanAction(fx.roles.sk.actor, c.id, "close_discrepancy", { version: await v("challan", c.id), note: "5 bags missing", resolution: "WRITE_OFF" }))).message).toMatch(/Stock adjustments/);
    await challanAction(fx.actors.superAdmin, c.id, "close_discrepancy", { version: await v("challan", c.id), note: "5 bags missing", resolution: "WRITE_OFF" });
    expect(await transit()).toBe("0");
    expect(await ledgerBalance(fx.ibUltra.id)).toEqual({ ledger: "95", current: "95" });
  });

  it("return to store: site → transit → warehouse receipt posts back into the warehouse", async () => {
    // Put 10 on the site first (issue from warehouse + receipt at site).
    const issue = await createChallan(fx.roles.sk.actor, { type: "ISSUE_TO_SITE", projectId: fx.p1.id, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "10" }] });
    await challanAction(fx.roles.sk.actor, issue.id, "dispatch", { version: 1 });
    const issueDetail = await getChallan(fx.actors.admin, issue.id);
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: issue.id, receiptDate: day(), lines: [{ challanLineId: issueDetail.challan.lines[0]!.id, receivedQty: "10" }] });
    const site = await db.stockLocation.findUniqueOrThrow({ where: { projectId: fx.p1.id } });
    const whBalance = async () => (await db.stockBalance.findUnique({ where: { itemBrandId_locationId: { itemBrandId: fx.ibUltra.id, locationId: fx.warehouse.id } } }))?.onHand.toFixed(0);
    const siteBefore = await siteBalance();
    const whBefore = await whBalance();
    const c = await createChallan(fx.roles.sk.actor, { type: "RETURN_TO_STORE", projectId: fx.p1.id, fromLocationId: site.id, toLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "4" }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: await v("challan", c.id) });
    const detail = await getChallan(fx.actors.admin, c.id);
    await receiveWithProof(fx.roles.sk.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: detail.challan.lines[0]!.id, receivedQty: "4" }] });
    expect(await siteBalance()).toBe(String(Number(siteBefore) - 4));
    expect(await whBalance()).toBe(String(Number(whBefore ?? "0") + 4));
    expect((await db.challan.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("RECEIVED");
  });
});

describe("material planning → requisition → RFQ → award → POs", () => {
  it("avoids double ordering and drives the full sourcing workflow", async () => {
    await saveRequirement(fx.roles.pm.actor, { projectId: fx.p1.id, itemBrandId: fx.ibAcc.id, requiredQty: "140", requiredBy: day(10) });
    let mrp = await getMrp(fx.roles.pm.actor, { projectId: fx.p1.id });
    const row = mrp.rows[0]!;
    // 40 ACC in the warehouse is free → 100 must be ordered
    expect([row.shortage, row.freeStock, row.toOrder, row.canReserveNow, row.status]).toEqual(["140", "40", "100", "40", "LOW_STOCK"]);
    const pr = await createPrFromMrp(fx.roles.se.actor, { projectId: fx.p1.id, requirementIds: [row.requirementId] });
    mrp = await getMrp(fx.roles.pm.actor, { projectId: fx.p1.id });
    expect([mrp.rows[0]!.openPr, mrp.rows[0]!.toOrder]).toEqual(["100", "0"]);
    expect((await errorOf(createPrFromMrp(fx.roles.se.actor, { projectId: fx.p1.id, requirementIds: [row.requirementId] }))).message).toMatch(/Nothing to order/);

    await prAction(fx.roles.se.actor, pr.id, "submit", { version: 1 });
    const prLine = await db.prLine.findFirstOrThrow({ where: { prId: pr.id } });
    const rfq = await createRfq(fx.roles.pu.actor, { projectId: fx.p1.id, prId: pr.id, title: "ACC cement", supplierIds: [fx.supplier.id, fx.supplier2.id], lines: [{ itemId: fx.item.id, itemBrandId: fx.ibAcc.id, quantity: "100", prLineId: prLine.id }] });
    await rfqAction(fx.roles.pu.actor, rfq.id, "send", { version: 1, via: "WhatsApp" });
    const rl = await db.rfqLine.findFirstOrThrow({ where: { rfqId: rfq.id } });
    await recordQuotation(fx.roles.pu.actor, { rfqId: rfq.id, partyId: fx.supplier.id, quoteDate: day(), validUntil: day(15), freight: "2000", freightGstRate: "18", advancePct: "30", creditDays: 45, warranty: "12 months", paymentTerms: "Balance against delivery", lines: [{ rfqLineId: rl.id, itemBrandId: fx.ibAcc.id, quantity: "100", rate: "350", gstRate: "28", leadTimeDays: 3, paymentTerms: "Cement: 100% before dispatch" }] });
    await recordQuotation(fx.roles.pu.actor, { rfqId: rfq.id, partyId: fx.supplier2.id, quoteDate: day(), validUntil: day(15), lines: [{ rfqLineId: rl.id, itemBrandId: fx.ibAcc.id, quantity: "100", rate: "362", gstRate: "28", leadTimeDays: 7 }] });
    const cmp = await getRfq(fx.roles.pu.actor, rfq.id);
    const quotes = cmp.comparison[0]!.quotes;
    // lowest rate is supplier 1 (350) but freight makes its landed cost higher: 350×100×1.28 + 2360 = 47160 → 471.6/unit vs 463.36
    expect(quotes.find((q) => q.partyId === fx.supplier.id)!.lowestRate).toBe(true);
    // Supplier payment terms are visible in the comparison (quotation level + item exception).
    const s1 = quotes.find((q) => q.partyId === fx.supplier.id)!;
    expect(s1.terms).toBe("30% advance · 45 days credit · Balance against delivery");
    expect([s1.lineTerms, s1.warranty, s1.creditDays]).toEqual(["Cement: 100% before dispatch", "12 months", 45]);
    expect(quotes.find((q) => q.partyId === fx.supplier2.id)!.recommended).toBe(true);
    // split award 60 / 40
    const ver = await v("rfq", rfq.id);
    // The award is final at once — no separate award approval.
    await proposeAward(fx.roles.pu.actor, rfq.id, { version: ver, awards: quotes.map((q) => ({ quotationLineId: q.quotationLineId, quantity: q.partyId === fx.supplier2.id ? "60" : "40" })) });
    expect((await db.rfq.findUniqueOrThrow({ where: { id: rfq.id } })).status).toBe("AWARDED");
    const attempts = await Promise.allSettled([createPosFromAward(fx.roles.pu.actor, rfq.id), createPosFromAward(fx.roles.pu.actor, rfq.id)]);
    const succeeded = attempts.filter((result) => result.status === "fulfilled");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.value).toHaveLength(2);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await db.prLine.findUniqueOrThrow({ where: { id: prLine.id } })).orderedQty.toFixed(0)).toBe("100");
    // The awarded supplier's terms are carried into its PO (advance amount = 30% of the PO total).
    const po1 = await db.purchaseOrder.findFirstOrThrow({ where: { rfqId: rfq.id, partyId: fx.supplier.id } });
    expect([po1.advancePct?.toFixed(2), po1.creditDays, po1.warranty, po1.paymentTerms]).toEqual(["30.00", 45, "12 months", "30% advance · 45 days credit · Balance against delivery"]);
    expect(po1.advanceAmount.toFixed(2)).toBe((Math.round(Number(po1.total) * 30) / 100).toFixed(2));
    expect((await errorOf(createPosFromAward(fx.roles.pu.actor, rfq.id))).message).toMatch(/already created/);
    // POs from an award are final at once (approver = the person who awarded).
    expect([po1.status, po1.approvedById, po1.submittedById]).toEqual(["APPROVED", fx.roles.pu.user.id, fx.roles.pu.user.id]);
    mrp = await getMrp(fx.roles.pm.actor, { projectId: fx.p1.id });
    expect([mrp.rows[0]!.poPipeline, mrp.rows[0]!.incoming, mrp.rows[0]!.openPr, mrp.rows[0]!.toOrder]).toEqual(["0", "100", "0", "0"]);
  });
});

  it("rejects unrelated brands, locations and requisitions on an enquiry", async () => {
    const base = { projectId: fx.p1.id, title: "Material rates", supplierIds: [fx.supplier.id], lines: [{ itemId: fx.item.id, itemBrandId: fx.ibAcc.id, quantity: "5" }] };
    expect((await errorOf(createRfq(fx.roles.pu.actor, { ...base, deliveryLocationId: fx.transit.id }))).message).toMatch(/delivery location/i);
    const pr = await createPr(fx.actors.admin, { projectId: fx.p2.id, lines: [{ itemBrandId: fx.ibAcc.id, quantity: "5" }] });
    expect((await errorOf(createRfq(fx.roles.pu.actor, { ...base, prId: pr.id }))).message).toMatch(/requisition/i);
    const otherItem = await db.item.create({ data: { organizationId: fx.org.id, code: "OTHER-ITEM", name: "Other item", unit: "Nos" } });
    expect((await errorOf(createRfq(fx.roles.pu.actor, { ...base, lines: [{ itemId: otherItem.id, itemBrandId: fx.ibAcc.id, quantity: "5" }] }))).message).toMatch(/brand/i);
  });

describe("procurement project scope (workflow v2: general inventory allowed)", () => {
  it("requisitions need a project; enquiries and purchase orders without one are general stock for the main warehouse", async () => {
    const pr = await errorOf(createPr(fx.roles.se.actor, { lines: [{ itemBrandId: fx.ibUltra.id, quantity: "5" }] }));
    expect((pr as { fieldErrors?: Record<string, string> }).fieldErrors?.projectId).toMatch(/project/i);
    const rfq = await createRfq(fx.roles.pu.actor, { projectId: "", title: "Rates", supplierIds: [fx.supplier.id], lines: [{ itemId: fx.item.id, itemBrandId: fx.ibAcc.id, quantity: "5" }] });
    expect((await db.rfq.findUniqueOrThrow({ where: { id: rfq.id } })).projectId).toBeNull();
    const po = await createPo(fx.roles.pu.actor, { projectId: null, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "1", rate: "1", gstRate: "28" }] });
    const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { deliveryLocation: true } });
    expect(row.projectId).toBeNull();
    expect(row.deliveryLocation.code).toBe("WH-MAIN");
    // A project-less PO cannot deliver to a project's site.
    const site = await db.stockLocation.findFirst({ where: { projectId: fx.p1.id } });
    if (site) expect((await errorOf(createPo(fx.roles.pu.actor, { projectId: null, partyId: fx.supplier.id, deliveryLocationId: site.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "1", rate: "1", gstRate: "28" }] }))).message).toMatch(/site must be raised for that project/);
  });

  it("a PO delivers to its project's site store by default", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "1", rate: "1", gstRate: "28" }] });
    const row = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { deliveryLocation: true } });
    expect(row.deliveryLocation.type).toBe("SITE");
    expect(row.deliveryLocation.projectId).toBe(fx.p1.id);
  });
});

describe("challan rules", () => {
  it("client deliveries require the project's approved sales order", async () => {
    const e = await errorOf(createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", projectId: fx.p1.id, fromLocationId: fx.warehouse.id, partyId: fx.client.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "1" }] }));
    expect(e.message).toMatch(/sales order/i);
  });

  it("a supplier return against a PO is linked to the PO line automatically and cannot exceed what was accepted", async () => {
    const po = await approvedPo("10");
    await receive(po.id, po.lines[0]!.id, "10");
    const site = await db.stockLocation.findUniqueOrThrow({ where: { projectId: fx.p1.id } });
    const c = await createChallan(fx.roles.sk.actor, { type: "RETURN_TO_SUPPLIER", projectId: fx.p1.id, fromLocationId: site.id, partyId: fx.supplier.id, poId: po.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "3" }] });
    const line = await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } });
    expect(line.poLineId).toBe(po.lines[0]!.id);
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: await v("challan", c.id) });
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0]!.id } })).returnedQty.toFixed(0)).toBe("3");
  });
});
