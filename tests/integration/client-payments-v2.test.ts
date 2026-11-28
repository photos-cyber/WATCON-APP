import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildPdfModel } from "@/modules/documents/pdf-models";
import { projectFinancials } from "@/modules/insights/finance";
import { allocatePayment, cancelPayment, createPayment, refundClientAdvance } from "@/modules/payables/payments";
import { clientAccount } from "@/modules/sales/client-account";
import { clientPoAction, createClientPo } from "@/modules/sales/client-po";
import { clientInvoiceAction, createClientInvoice } from "@/modules/sales/invoice";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { PDF, commercialFixture, day, errorOf, key, type CFx } from "./commercial-helpers";

/** Workflow v2 · Phase 7 — client payments, advances, refunds and outstanding balances. */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "clientPo" | "clientInvoice" | "payment" | "salesOrder";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

/** Contract ₹10,00,000: 100 units × ₹10,000, 0% GST so the figures read like the owner's example. */
async function contract() {
  const cpo = await createClientPo(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: `PO-${key().slice(0, 6)}`, poDate: day(-90), lines: [{ description: "Pool works", unit: "Unit", quantity: "100", rate: "10000", gstRate: "0" }] });
  await clientPoAction(fx.roles.pm.actor, cpo.id, "submit", { version: await v("clientPo", cpo.id) });
  return db.clientPo.findUniqueOrThrow({ where: { id: cpo.id }, include: { lines: true } });
}
async function invoice(cpo: Awaited<ReturnType<typeof contract>>, qty: string, invoiceDate = day()) {
  const inv = await createClientInvoice(fx.roles.ac.actor, { source: "CPO", clientPoId: cpo.id, invoiceDate, lines: [{ sourceLineId: cpo.lines[0]!.id, quantity: qty }] });
  await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
  return inv;
}
const receive = (amount: string, allocations: { documentId: string; amount: string }[] = [], extra: Record<string, unknown> = {}, proof?: { fileName: string; bytes: Uint8Array }) =>
  createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", reference: `UTR-${key().slice(0, 6)}`, amount, idempotencyKey: key(), allocations, ...extra }, proof);
const account = () => clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id });

describe("client account reconciliation", () => {
  it("matches the worked example: contract 10L, billed 6.5L, received 4L", async () => {
    const cpo = await contract();
    const inv = await invoice(cpo, "65");
    await receive("400000", [{ documentId: inv.id, amount: "400000" }]);
    expect(await account()).toMatchObject({
      contractValue: "1000000.00",
      invoiced: "650000.00",
      received: "400000.00",
      outstandingBilled: "250000.00",
      unbilled: "350000.00",
      clientAdvances: "0.00",
      paymentReceived: "400000.00",
      remainingContract: "600000.00",
      overdue: "0.00",
    });
  });

  it("partial and multiple payments against one invoice; one payment across several invoices; overdue", async () => {
    const cpo = await contract();
    const old = await invoice(cpo, "35", day(-80)); // client terms 45 days → overdue
    const recent = await invoice(cpo, "30");
    await receive("100000", [{ documentId: old.id, amount: "100000" }]);
    await receive("100000", [{ documentId: old.id, amount: "100000" }]);
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("PARTIALLY_PAID");
    expect((await account()).overdue).toBe("150000.00");
    // One receipt settles the rest of the old invoice and part of the new one.
    const p = await receive("250000", [{ documentId: old.id, amount: "150000" }, { documentId: recent.id, amount: "100000" }]);
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("PAID");
    expect((await db.paymentAllocation.count({ where: { paymentId: p.id, reversedAt: null } }))).toBe(2);
    expect(await account()).toMatchObject({ invoiced: "650000.00", received: "450000.00", outstandingBilled: "200000.00", overdue: "0.00", remainingContract: "550000.00" });
  });

  it("advances are counted once: held, then allocated, then refunded", async () => {
    const cpo = await contract();
    const inv = await invoice(cpo, "20");
    const adv = await receive("300000", [], {}, { fileName: "bank-advice.pdf", bytes: PDF });
    expect(await db.attachment.count({ where: { entityType: "payment", entityId: adv.id, category: "PAYMENT_PROOF" } })).toBe(1);
    let a = await account();
    expect([a.clientAdvances, a.paymentReceived, a.outstandingBilled, a.remainingContract]).toEqual(["300000.00", "300000.00", "200000.00", "700000.00"]);
    // Advance adjustment: set 2L of it against the invoice — received up, advances down, remaining unchanged.
    await allocatePayment(fx.roles.ac.actor, adv.id, { documentId: inv.id, amount: "200000" });
    a = await account();
    expect([a.received, a.clientAdvances, a.paymentReceived, a.outstandingBilled, a.remainingContract]).toEqual(["200000.00", "100000.00", "300000.00", "0.00", "700000.00"]);
    // Refunds need an approver other than the person who recorded the receipt, and only from the advance.
    expect((await errorOf(refundClientAdvance(fx.roles.ac.actor, adv.id, { amount: "1000", paymentDate: day(), mode: "UPI", reason: "Client overpaid", idempotencyKey: key() }))).message).toMatch(/Separation of duties/);
    expect((await errorOf(refundClientAdvance(fx.actors.admin, adv.id, { amount: "100001", paymentDate: day(), mode: "UPI", reason: "Client overpaid", idempotencyKey: key() }))).message).toMatch(/Only ₹1,00,000.00/);
    expect((await errorOf(refundClientAdvance(fx.roles.pm.actor, adv.id, { amount: "1000", paymentDate: day(), mode: "UPI", reason: "Client overpaid", idempotencyKey: key() }))).message).toMatch(/permission/);
    const k = key();
    const [r1, r2] = await Promise.all([refundClientAdvance(fx.actors.admin, adv.id, { amount: "40000", paymentDate: day(), mode: "UPI", reason: "Client overpaid", idempotencyKey: k }), refundClientAdvance(fx.actors.admin, adv.id, { amount: "40000", paymentDate: day(), mode: "UPI", reason: "Client overpaid", idempotencyKey: k })]);
    expect(r1.id).toBe(r2.id);
    a = await account();
    expect([a.clientAdvances, a.paymentReceived, a.remainingContract]).toEqual(["60000.00", "260000.00", "740000.00"]);
    // The refund is not a supplier payment; it reduces money received in project accounts.
    const fin = (await projectFinancials(fx.org.id, [fx.p1.id])).get(fx.p1.id)!;
    expect([fin.paid, fin.received]).toEqual(["0.00", "260000.00"]);
    // The receipt can't be cancelled while a refund stands; cancelling the refund restores the advance.
    // (Accounts users cancel a recorded payment directly, with a reason — no Super Admin step.)
    expect((await errorOf(cancelPayment(fx.roles.ac.actor, adv.id, await v("payment", adv.id), "Bounced"))).message).toMatch(/Cancel the refund first/);
    await cancelPayment(fx.roles.ac.actor, r1.id, await v("payment", r1.id), "Refund reversed by bank");
    expect((await account()).clientAdvances).toBe("100000.00");
    // A refund row cannot be allocated to invoices.
    expect((await errorOf(allocatePayment(fx.roles.ac.actor, r1.id, { documentId: inv.id, amount: "1" }))).message).toMatch(/cancelled|refund/i);
  });

  it("prevents duplicate receipts and incorrect allocations", async () => {
    const cpo = await contract();
    const inv = await invoice(cpo, "10");
    const k = key();
    const [a, b] = await Promise.all([receive("50000", [{ documentId: inv.id, amount: "50000" }], { idempotencyKey: k }), receive("50000", [{ documentId: inv.id, amount: "50000" }], { idempotencyKey: k })]);
    expect(a.id).toBe(b.id);
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } })).receivedAmount.toFixed(2)).toBe("50000.00");
    expect((await errorOf(receive("60000", [{ documentId: inv.id, amount: "60000" }]))).message).toMatch(/only ₹50,000.00 outstanding/);
    expect((await errorOf(receive("10000", [{ documentId: inv.id, amount: "20000" }]))).message).toMatch(/more than/);
    expect((await errorOf(receive("10000", [{ documentId: inv.id, amount: "5000" }, { documentId: inv.id, amount: "5000" }]))).message).toMatch(/only once/);
    // An invoice of another project can't be settled from this project's receipt.
    const other = await createClientPo(fx.roles.pm.actor, { projectId: fx.p2.id, partyId: fx.client.id, clientPoNumber: `PO-${key().slice(0, 6)}`, poDate: day(-10), lines: [{ description: "Other", unit: "Unit", quantity: "1", rate: "1000", gstRate: "0" }] });
    await clientPoAction(fx.roles.pm.actor, other.id, "submit", { version: await v("clientPo", other.id) });
    const ol = await db.clientPoLine.findFirstOrThrow({ where: { clientPoId: other.id } });
    const oi = await createClientInvoice(fx.roles.ac.actor, { source: "CPO", clientPoId: other.id, invoiceDate: day(), lines: [{ sourceLineId: ol.id, quantity: "1" }] });
    await clientInvoiceAction(fx.actors.admin, oi.id, "issue", { version: await v("clientInvoice", oi.id) });
    expect((await errorOf(receive("1000", [{ documentId: oi.id, amount: "1000" }]))).message).toMatch(/different project/);
  });
});

describe("milestones and receipts", () => {
  it("shows the next payment milestone from the editable schedule and how much of it is due", async () => {
    const milestones = [
      { label: "Advance with order", basis: "PERCENT", value: "50", trigger: "ADVANCE" },
      { label: "On delivery", basis: "PERCENT", value: "40", trigger: "ON_DELIVERY" },
      { label: "On installation", basis: "PERCENT", value: "10", trigger: "ON_INSTALLATION" },
    ];
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p2.id, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "100", rate: "1000", gstRate: "0" }], milestones });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    const a = await clientAccount(fx.roles.ac.actor, { projectId: fx.p2.id, soId: so.id });
    expect(a).toMatchObject({ scope: "SALES_ORDER", contractValue: "100000.00", unbilled: "100000.00", remainingContract: "100000.00" });
    expect(a.nextMilestone).toMatchObject({ label: "Advance with order", amount: "50000.00", dueNow: "50000.00" });
  });

  it("produces a professional payment receipt PDF with the account position", async () => {
    const cpo = await contract();
    const inv = await invoice(cpo, "10");
    const p = await receive("150000", [{ documentId: inv.id, amount: "100000" }]);
    const doc = await buildPdfModel(fx.roles.ac.actor, "payment", p.id);
    expect(doc.title).toBe("Payment Receipt");
    expect(doc.rows).toHaveLength(1);
    expect(doc.facts?.map((f) => f.label)).toEqual(["Contract value", "Total invoiced", "Received to date", "Outstanding billed", "Client advances", "Remaining contract payment"]);
    expect(doc.sections?.some((s) => s.title === "Advance")).toBe(true);
  });
});
