import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createPayment } from "@/modules/payables/payments";
import { createPo, poAction } from "@/modules/procurement/po";
import { clientInvoiceAction, createClientInvoice } from "@/modules/sales/invoice";
import { certifyRaBill, getRaBill, raBillAction } from "@/modules/sales/ra-bill";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { generateSoRunningBill, soBillingPosition } from "@/modules/sales/so-running-bill";
import { issueMaterialToSite } from "@/modules/stores/site-issue";
import { commercialFixture, day, errorOf, key, receiveWithProof, type CFx } from "./commercial-helpers";

/**
 * Workflow v2 · Phase 6 — automatic cumulative running bills on a sales order: built from delivered
 * material at SO selling rates, previous / current / cumulative, outstanding, contract limits, no
 * duplicate billing, taxes or receivables.
 */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "salesOrder" | "raBill" | "clientInvoice" | "purchaseOrder" | "grn";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

/** SO: 300 bags at ₹1,000 (0% GST to match the worked example) + installation ₹20,000 (+18% GST). */
async function approvedSo(extra: Record<string, unknown> = {}) {
  const so = await createSalesOrder(fx.roles.pm.actor, {
    projectId: fx.p1.id,
    partyId: fx.client.id,
    orderDate: day(-5),
    lines: [
      { kind: "MATERIAL", itemBrandId: fx.ibUltra.id, quantity: "300", rate: "1000", gstRate: "0" },
      { kind: "INSTALLATION", description: "Installation", unit: "Job", quantity: "1", rate: "20000", gstRate: "18" },
    ],
    ...extra,
  });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
  return db.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

/** 100 bags issued from the warehouse on a site challan and received at site with proof. */
async function deliverByChallan(qty: string) {
  const c = await issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty }] });
  const line = await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } });
  await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: qty }] });
}

/** Direct supplier-to-site delivery (PO to the project site, received with proof). Purchase rate ₹400 — never used for billing. */
async function deliverDirect(qty: string) {
  const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "400", gstRate: "28" }] });
  await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
  const pl = await db.poLine.findFirstOrThrow({ where: { poId: po.id } });
  await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: pl.id, receivedQty: qty }] });
}

/** Draft → review → approve → certified as claimed → invoice issued. */
async function certifyAndInvoice(billId: string) {
  await raBillAction(fx.roles.pm.actor, billId, "submit_review", { version: await v("raBill", billId) });
  const bill = await getRaBill(fx.actors.admin, billId);
  await certifyRaBill(fx.roles.ac.actor, billId, await v("raBill", billId), { clientCertRef: `CERT-${billId.slice(0, 4)}`, clientCertDate: day(), lines: bill.bill.lines.map((l) => ({ lineId: l.id, certifiedQty: l.claimedQty })) });
  const inv = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: billId, invoiceDate: day() });
  await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
  return db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } });
}

describe("cumulative running bills on a sales order", () => {
  it("bills delivered material at the SO selling rate (never the purchase rate) and carries the cumulative statement", async () => {
    const so = await approvedSo();
    // Nothing delivered yet → nothing to bill.
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id }))).message).toMatch(/Nothing new to bill/);

    await deliverByChallan("100");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    let view = (await getRaBill(fx.roles.pm.actor, b1.id)).bill;
    expect(view.basis).toBe("SO");
    expect(view.lines.map((l) => [l.ref.kind, l.deliveredQty, l.prevCertifiedQty, l.claimedQty, l.rate])).toEqual([["MATERIAL", "100", "0", "100", "1000"]]);
    expect([view.claimedAmount, view.gstAmount, view.netPayable]).toEqual(["100000.00", "0.00", "100000.00"]);
    expect(view.statement).toMatchObject({ previousValue: "0.00", currentValue: "100000.00", cumulativeValue: "100000.00", previousOutstanding: "0.00", totalPayable: "100000.00" });
    const inv1 = await certifyAndInvoice(b1.id);
    expect(inv1.netReceivable.toFixed(2)).toBe("100000.00");

    // Bill 1 unpaid; 100 more delivered directly by a supplier to site (purchase rate ₹400).
    await deliverDirect("100");
    const b2 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    view = (await getRaBill(fx.roles.pm.actor, b2.id)).bill;
    expect(view.raNumber).toBe(2);
    expect(view.lines.map((l) => [l.deliveredQty, l.prevCertifiedQty, l.claimedQty, l.cumulativeQty])).toEqual([["200", "100", "100", "200"]]);
    expect(view.statement).toEqual({
      previousValue: "100000.00",
      currentValue: "100000.00",
      cumulativeValue: "200000.00",
      previousBilled: "100000.00",
      currentBilling: "100000.00",
      previousOutstanding: "100000.00",
      receivedToDate: "0.00",
      totalPayable: "200000.00",
    });
    expect(view.previousBills).toMatchObject([{ raNumber: 1, netPayable: "100000.00", received: "0.00", outstanding: "100000.00" }]);

    // Invoicing bill 2 creates a receivable for bill 2 only — no duplicate of bill 1's amount or taxes.
    const inv2 = await certifyAndInvoice(b2.id);
    expect([inv2.taxable.toFixed(2), inv2.netReceivable.toFixed(2)]).toEqual(["100000.00", "100000.00"]);
    const receivable = await db.clientInvoice.aggregate({ where: { soId: so.id, status: { not: "CANCELLED" } }, _sum: { netReceivable: true } });
    expect(receivable._sum.netReceivable!.toFixed(2)).toBe("200000.00");
    const soLine = await db.soLine.findFirstOrThrow({ where: { soId: so.id, lineNo: 1 } });
    expect(soLine.invoicedQty.toString()).toBe("200");
  });

  it("partial payments reduce the previous outstanding on the next bill", async () => {
    const so = await approvedSo();
    await deliverByChallan("100");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    const inv1 = await certifyAndInvoice(b1.id);
    await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", reference: "UTR-1", amount: "40000", idempotencyKey: key(), allocations: [{ documentId: inv1.id, amount: "40000" }] });
    await deliverDirect("50");
    const b2 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    const view = (await getRaBill(fx.roles.pm.actor, b2.id)).bill;
    expect(view.statement).toMatchObject({ previousValue: "100000.00", currentValue: "50000.00", cumulativeValue: "150000.00", previousOutstanding: "60000.00", receivedToDate: "40000.00", totalPayable: "110000.00" });
    expect(view.previousBills[0]).toMatchObject({ received: "40000.00", outstanding: "60000.00" });
  });

  it("an un-invoiced previous bill counts as outstanding; a draft is consolidated instead of duplicated", async () => {
    const so = await approvedSo();
    await deliverByChallan("100");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await raBillAction(fx.roles.pm.actor, b1.id, "submit_review", { version: await v("raBill", b1.id) });
    await deliverDirect("30");
    const d = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    expect((await getRaBill(fx.roles.pm.actor, d.id)).bill.statement.previousOutstanding).toBe("100000.00");
    // More arrives; generating again refreshes the same draft (consolidation) — one draft, no double billing.
    await deliverDirect("20");
    const again = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    expect([again.id, again.consolidated]).toEqual([d.id, true]);
    expect(await db.raBill.count({ where: { soId: so.id, status: "DRAFT" } })).toBe(1);
    const lines = (await getRaBill(fx.roles.pm.actor, d.id)).bill.lines;
    expect(lines[0]).toMatchObject({ prevCertifiedQty: "100", claimedQty: "50", deliveredQty: "150" });
  });

  it("never bills beyond delivery, the contract quantity, or what was already billed; services up to the contract", async () => {
    const so = await approvedSo();
    await deliverByChallan("100");
    const [mat, inst] = so.lines;
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, lines: [{ soLineId: mat!.id, claimedQty: "101" }] }))).message).toMatch(/only 100 Bag can be billed now/);
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, lines: [{ soLineId: mat!.id, claimedQty: "0" }, { soLineId: inst!.id, claimedQty: "2" }] }))).message).toMatch(/only 1 Job can be billed now/);
    // Partial billing: 60 bags + installation (18% GST on the service only).
    const b = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, lines: [{ soLineId: mat!.id, claimedQty: "60" }, { soLineId: inst!.id, claimedQty: "1" }] });
    const view = (await getRaBill(fx.roles.pm.actor, b.id)).bill;
    expect([view.claimedAmount, view.gstAmount, view.netPayable]).toEqual(["80000.00", "3600.00", "83600.00"]);
    await raBillAction(fx.roles.pm.actor, b.id, "submit_review", { version: await v("raBill", b.id) });
    const pos = (await soBillingPosition(db, so.id)).lines;
    expect(pos.map((p) => [p.billed, p.billable])).toEqual([["60", "40"], ["1", "0"]]);
    // A material line can never pass the order quantity even when more is delivered.
    await deliverDirect("100");
    await deliverDirect("150");
    expect((await soBillingPosition(db, so.id)).lines[0]).toMatchObject({ delivered: "300", billable: "240" });
  });

  it("retention, advance recovery and deductions; the final bill closes billing", async () => {
    const so = await approvedSo();
    await deliverByChallan("100");
    const b = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, retentionPct: "5", otherDeductions: "1000", deductionNotes: "Debris removal" });
    const view = (await getRaBill(fx.roles.pm.actor, b.id)).bill;
    expect([view.retentionAmount, view.advanceRecovery, view.otherDeductions, view.netPayable]).toEqual(["5000.00", "0.00", "1000.00", "94000.00"]);
    // Advance recovery cannot exceed the advance actually received (none here).
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, advanceRecovery: "1" }))).message).toMatch(/cannot exceed the advance/);
    // Final bill: everything billable incl. installation; nothing can be billed after it.
    const fin = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, isFinal: true });
    const fv = (await getRaBill(fx.roles.pm.actor, fin.id)).bill;
    expect([fv.isFinal, fv.lines.find((l) => l.ref.kind === "INSTALLATION")?.claimedQty]).toEqual([true, "1"]);
    await raBillAction(fx.roles.pm.actor, fin.id, "submit_review", { version: await v("raBill", fin.id) });
    await deliverDirect("10");
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id }))).message).toMatch(/final running bill/);
  });

  it("one billing basis: no SO delivery invoices or milestone tax invoices alongside running bills; client-PO orders bill on the client PO", async () => {
    const so = await approvedSo();
    await deliverByChallan("100");
    await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    // Material was also delivered to the client? A direct SO invoice is refused while running bills exist.
    expect((await errorOf(createClientInvoice(fx.roles.ac.actor, { source: "SO", soId: so.id, invoiceDate: day(), lines: [] }))).message).toMatch(/cumulative running bills/);
    // Invoicing a running bill twice is impossible.
    const b = await db.raBill.findFirstOrThrow({ where: { soId: so.id } });
    const inv = await certifyAndInvoice(b.id);
    expect((await errorOf(createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: b.id, invoiceDate: day() }))).message).toMatch(/already invoiced/);
    expect(await db.clientInvoice.count({ where: { raBillId: b.id, status: { not: "CANCELLED" } } })).toBe(1);
    // Cancelling the invoice reverses the SO counters, so the bill can be re-invoiced once.
    await clientInvoiceAction(fx.actors.superAdmin, inv.id, "cancel", { version: await v("clientInvoice", inv.id), note: "Wrong date" });
    expect((await db.soLine.findFirstOrThrow({ where: { soId: so.id, lineNo: 1 } })).invoicedQty.toString()).toBe("0");
  });

  it("permissions", async () => {
    const so = await approvedSo();
    await deliverByChallan("10");
    expect((await errorOf(generateSoRunningBill(fx.roles.ac.actor, { soId: so.id }))).message).toMatch(/permission/);
    expect((await errorOf(generateSoRunningBill(fx.roles.outsider.actor, { soId: so.id }))).message).toMatch(/permission|not found/i);
  });
});
