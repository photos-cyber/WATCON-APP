import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { projectFinancials } from "@/modules/insights/finance";
import { accountsReconciliation, projectAccountsDashboard, projectMaterialCost, projectTransactions } from "@/modules/insights/project-accounts";
import { billAction, billPrefillFromPo, createBill } from "@/modules/payables/bills";
import { allocatePayment, createPayment } from "@/modules/payables/payments";
import { createPo, poAction } from "@/modules/procurement/po";
import { clientInvoiceAction, createClientInvoice } from "@/modules/sales/invoice";
import { createMilestoneInvoice } from "@/modules/sales/milestone-billing";
import { certifyRaBill, getRaBill, raBillAction } from "@/modules/sales/ra-bill";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { generateSoRunningBill } from "@/modules/sales/so-running-bill";
import { issueMaterialToSite } from "@/modules/stores/site-issue";
import { PDF, commercialFixture, day, errorOf, key, receiveWithProof, type CFx } from "./commercial-helpers";

/** Workflow v2 · Phase 8 — supplier bills & payments from POs, project accounts dashboard, reconciliation. */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "purchaseOrder" | "grn" | "supplierBill" | "salesOrder" | "raBill" | "clientInvoice";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

/** Approved PO (₹400 + 18% GST) received in full with proof. */
async function receivedPo(qty: string, projectId: string | null = fx.p1.id) {
  const po = await createPo(fx.roles.pu.actor, { projectId, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "400", gstRate: "18" }] });
  await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
  const pl = await db.poLine.findFirstOrThrow({ where: { poId: po.id } });
  await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: pl.id, receivedQty: qty }] });
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
}
async function approvedBill(poId: string, qty: string, extra: Record<string, unknown> = {}) {
  const pre = await billPrefillFromPo(fx.roles.ac.actor, poId);
  const bill = await createBill(fx.roles.ac.actor, { poId, supplierInvoiceNo: `SINV-${key().slice(0, 6)}`, invoiceDate: day(), lines: pre.lines.map((l) => ({ ...l, quantity: qty })), ...extra });
  await billAction(fx.roles.ac.actor, bill.id, "submit", { version: await v("supplierBill", bill.id) });
  return db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
}
const pay = (input: Record<string, unknown>, proof?: { fileName: string; bytes: Uint8Array }) => createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, paymentDate: day(), mode: "BANK_TRANSFER", reference: `UTR-${key().slice(0, 5)}`, idempotencyKey: key(), allocations: [], ...input }, proof);
const stockCount = () => db.stockTransaction.count({ where: { organizationId: fx.org.id } });

describe("supplier bills and payments from a purchase order", () => {
  it("advance against the PO, partial bill, advance adjustment, final payment — no extra stock", async () => {
    const po = await receivedPo("50"); // ₹20,000 + GST = ₹23,600
    // Supplier advance before the bill: linked to the PO and its project automatically.
    const adv = await pay({ poId: po.id, amount: "5000" }, { fileName: "advice.pdf", bytes: PDF });
    expect([adv.poId, adv.projectId]).toEqual([po.id, fx.p1.id]);
    const before = await stockCount();
    const bill = await approvedBill(po.id, "30"); // partial invoice: 30 × 400 × 1.18 = 14,160
    expect(bill.total.toFixed(2)).toBe("14160.00");
    expect(await stockCount()).toBe(before); // a bill never adds stock for material already received
    await allocatePayment(fx.roles.ac.actor, adv.id, { documentId: bill.id, amount: "5000" });
    let d = await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id);
    expect(d.supplier).toEqual({ poValue: "23600.00", supplierBills: "14160.00", paymentsMade: "5000.00", advances: "0.00", outstanding: "9160.00" });
    await pay({ poId: po.id, amount: "9160", allocations: [{ documentId: bill.id, amount: "9160" }] });
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PAID");
    d = await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id);
    expect(d.supplier).toMatchObject({ paymentsMade: "14160.00", outstanding: "0.00" });
    // A PO-linked advance can't be set against another PO's bill; nor can a payment be for another supplier's PO.
    const po2 = await receivedPo("10");
    const bill2 = await approvedBill(po2.id, "10");
    const adv2 = await pay({ poId: po.id, amount: "100" });
    expect((await errorOf(allocatePayment(fx.roles.ac.actor, adv2.id, { documentId: bill2.id, amount: "100" }))).message).toMatch(/another purchase order/);
    expect((await errorOf(createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier2.id, poId: po.id, paymentDate: day(), mode: "UPI", amount: "1", idempotencyKey: key() }))).message).toMatch(/different supplier/);
    expect((await accountsReconciliation(fx.org.id)).errors).toBe(0);
  });

  it("general-stock purchases are billed and paid without a project, and are not charged to any project", async () => {
    const po = await receivedPo("40", null);
    const bill = await approvedBill(po.id, "40");
    expect(bill.projectId).toBeNull();
    await pay({ poId: po.id, amount: bill.netPayable.toFixed(2), allocations: [{ documentId: bill.id, amount: bill.netPayable.toFixed(2) }] });
    let d = await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id);
    expect(d.supplier).toEqual({ poValue: "0.00", supplierBills: "0.00", paymentsMade: "0.00", advances: "0.00", outstanding: "0.00" });
    expect(d.summary.materialCost).toBe("0.00");
    // Issued to the project: only the issued part becomes project material cost (warehouse average cost).
    const c = await issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "20" }] });
    const cl = await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } });
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: cl.id, receivedQty: "20" }] });
    d = await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id);
    expect(d.supplier.poValue).toBe("0.00");
    expect(d.summary.materialCost).toBe("8000.00"); // 20 × ₹400 (only receipt cost recorded so far)
    // A project payment without a project or PO is refused.
    expect((await errorOf(pay({ amount: "10" }))).message).toMatch(/Select the project/);
  });
});

describe("project accounts dashboard", () => {
  it("client side, supplier side and financial summary reconcile with the documents", async () => {
    // Contract: 300 bags × ₹1,000, 0% GST (₹3,00,000) — direct sales order, no client PO.
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(-3), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "300", rate: "1000", gstRate: "0" }] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    const po = await receivedPo("100"); // material cost 100 × 400 = 40,000
    const bill = await approvedBill(po.id, "100", { charges: "2000", chargesGstRate: "0" }); // freight = other expense
    // Running bill for the 100 bags delivered → invoiced ₹1,00,000.
    const rb = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await raBillAction(fx.roles.pm.actor, rb.id, "submit_review", { version: await v("raBill", rb.id) });
    const view = await getRaBill(fx.actors.admin, rb.id);
    await certifyRaBill(fx.roles.ac.actor, rb.id, await v("raBill", rb.id), { clientCertRef: "C-1", clientCertDate: day(), lines: view.bill.lines.map((l) => ({ lineId: l.id, certifiedQty: l.claimedQty })) });
    const inv = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: rb.id, invoiceDate: day() });
    await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
    await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "UPI", amount: "60000", idempotencyKey: key(), allocations: [{ documentId: inv.id, amount: "60000" }] });
    await pay({ poId: po.id, amount: "10000" });

    const d = await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id);
    expect(d.client).toMatchObject({ contractValue: "300000.00", invoiced: "100000.00", paymentReceived: "60000.00", outstandingBilled: "40000.00", unbilled: "200000.00", clientAdvances: "0.00", remainingContract: "240000.00" });
    expect(d.supplier).toEqual({ poValue: "47200.00", supplierBills: bill.total.toFixed(2), paymentsMade: "10000.00", advances: "10000.00", outstanding: bill.netPayable.toFixed(2) });
    expect(d.summary).toMatchObject({
      contractTaxable: "300000.00",
      revenue: "100000.00", // contract value is not revenue
      materialCost: "40000.00", // POs are commitments, not expenses
      otherExpenses: "2000.00",
      estRemaining: "80000.00", // 200 bags still to issue × last purchase rate ₹400
      estProfit: "178000.00",
      actualMargin: "58000.00",
    });
    expect(await projectMaterialCost(fx.org.id, fx.p1.id)).toBe("40000.00");
    // The older project summary agrees on billed revenue and supplier figures.
    const fin = (await projectFinancials(fx.org.id, [fx.p1.id])).get(fx.p1.id)!;
    expect([fin.billed, fin.received, fin.supplierBilled, fin.paid]).toEqual(["100000.00", "60000.00", bill.total.toFixed(2), "10000.00"]);

    // Transaction history: newest first, every money / material record linked.
    const txns = await projectTransactions(fx.roles.ac.actor, fx.p1.id);
    const kinds = txns.map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(["Client invoice", "Client receipt", "Supplier bill", "Supplier payment", "Running bill RA-1", "Material received from supplier"]));
    expect(txns.every((t) => t.href.startsWith("/"))).toBe(true);
    const grn = txns.find((t) => t.kind === "Material received from supplier")!;
    expect([grn.amount, grn.proofs > 0]).toEqual(["40000.00", true]);
    expect([...txns].map((t) => t.date)).toEqual([...txns].map((t) => t.date).sort().reverse());

    // Reconciliation: counters match allocations; tampering is detected.
    expect((await accountsReconciliation(fx.org.id)).errors).toBe(0);
    await db.supplierBill.update({ where: { id: bill.id }, data: { paidAmount: "1" } });
    expect((await accountsReconciliation(fx.org.id)).issues.map((i) => i.code)).toEqual(["bill_paid"]);
  });

  it("proforma advance requests are not billed revenue", async () => {
    const milestones = [
      { label: "Advance with order", basis: "PERCENT", value: "50", trigger: "ADVANCE" },
      { label: "On delivery", basis: "PERCENT", value: "50", trigger: "ON_DELIVERY" },
    ];
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p2.id, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "10", rate: "1000", gstRate: "0" }], milestones });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    const ms = await db.paymentMilestone.findFirstOrThrow({ where: { soId: so.id, trigger: "ADVANCE" } });
    const pi = await createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms.id, amount: "5000", invoiceDate: day() });
    await clientInvoiceAction(fx.actors.admin, pi.id, "issue", { version: await v("clientInvoice", pi.id) });
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: pi.id } })).kind).toBe("PROFORMA");
    const fin = (await projectFinancials(fx.org.id, [fx.p2.id])).get(fx.p2.id)!;
    expect([fin.billed, fin.billedTaxable]).toEqual(["0.00", "0.00"]);
    const d = await projectAccountsDashboard(fx.actors.admin, fx.p2.id);
    expect([d.summary.revenue, d.summary.actualMargin]).toEqual(["0.00", null]);
  });

  it("permissions", async () => {
    expect((await errorOf(projectAccountsDashboard(fx.roles.se.actor, fx.p1.id))).message).toMatch(/permission/);
    expect((await errorOf(projectTransactions(fx.roles.se.actor, fx.p1.id))).message).toMatch(/permission/);
  });
});
