import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { billAction, billPrefillFromPo, createBill, getBill, listBills } from "@/modules/payables/bills";
import { createNote, noteAction } from "@/modules/payables/notes";
import { allocatePayment, cancelPayment, createPayment, getPayment, reverseAllocation } from "@/modules/payables/payments";
import { createPo, poAction } from "@/modules/procurement/po";
import { commercialFixture, day, errorOf, key, type CFx, receiveWithProof } from "./commercial-helpers";

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type Versioned = "purchaseOrder" | "grn" | "supplierBill" | "payment" | "adjustmentNote";
const v = async (model: Versioned, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

async function approvedPo(qty = "50", rate = "100") {
  const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate, gstRate: "18" }] });
  await poAction(fx.roles.pu.actor, po.id, "submit", { version: await v("purchaseOrder", po.id) });
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
}

async function receive(poId: string, poLineId: string, qty: string) {
  const g = await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId, receiptDate: day(), lines: [{ poLineId, receivedQty: qty }] });
  return db.grnLine.findFirstOrThrow({ where: { grnId: g.id } });
}

/** A bill for the PO prefilled from receipts, with the quantity overridden when given. */
async function billFor(poId: string, invoiceNo: string, qty?: string, extra: Record<string, unknown> = {}, actor = fx.roles.ac.actor) {
  const pre = await billPrefillFromPo(actor, poId);
  const lines = pre.lines.map((l) => ({ ...l, quantity: qty ?? l.quantity }));
  return createBill(actor, { poId, supplierInvoiceNo: invoiceNo, invoiceDate: day(), lines, ...extra });
}

async function submit(billId: string, actor = fx.roles.ac.actor) {
  await billAction(actor, billId, "submit", { version: await v("supplierBill", billId) });
}
async function approve(billId: string, actor = fx.actors.admin, opts: { override?: boolean; note?: string } = {}) {
  await billAction(actor, billId, "approve", { version: await v("supplierBill", billId), ...opts });
}

async function approvedBill(qty = "10", invoiceNo = `INV-${Math.random().toString(36).slice(2, 8)}`) {
  const po = await approvedPo("50");
  await receive(po.id, po.lines[0]!.id, "50");
  const bill = await billFor(po.id, invoiceNo, qty);
  await submit(bill.id); // a matching bill is finalized in one step
  return db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
}

const pay = (amount: string, allocations: { documentId: string; amount: string }[] = [], extra: Record<string, unknown> = {}) =>
  createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", reference: "UTR123", amount, idempotencyKey: key(), allocations, ...extra });

describe("supplier bills", () => {
  it("computes GST and TDS server-side and derives the project from the PO", async () => {
    const po = await approvedPo("50");
    await receive(po.id, po.lines[0]!.id, "50");
    const bill = await billFor(po.id, "SCT/101", "10", { tdsSection: "194C", tdsRate: "1" });
    // 10 × 100 = 1000 taxable; CGST/SGST 9% = 90 each → 1180; TDS 1% of taxable = 10 → 1170 net
    expect([bill.projectId, bill.taxable.toFixed(2), bill.cgst.toFixed(2), bill.total.toFixed(2), bill.tdsAmount.toFixed(2), bill.netPayable.toFixed(2), bill.matchStatus]).toEqual([fx.p1.id, "1000.00", "90.00", "1180.00", "10.00", "1170.00", "MATCHED"]);
  });

  it("requires a project for bills without a purchase order", async () => {
    const err = await errorOf(createBill(fx.roles.ac.actor, { partyId: fx.supplier.id, supplierInvoiceNo: "X-1", invoiceDate: day(), lines: [{ description: "Transport", quantity: "1", rate: "500", gstRate: "18" }] }));
    expect(err.message).toMatch(/project/i);
    const ok = await createBill(fx.roles.ac.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, supplierInvoiceNo: "X-1", invoiceDate: day(), lines: [{ description: "Transport", quantity: "1", rate: "500", gstRate: "18" }] });
    expect(ok.matchStatus).toBe("NOT_MATCHED");
  });

  it("rejects a duplicate supplier invoice number (normalised), but allows it again once the first is cancelled", async () => {
    const po = await approvedPo("50");
    await receive(po.id, po.lines[0]!.id, "50");
    const first = await billFor(po.id, "INV/2026/001", "5");
    expect((await errorOf(billFor(po.id, "inv-2026-001", "5"))).message).toMatch(/already entered as/);
    await billAction(fx.roles.ac.actor, first.id, "cancel", { version: await v("supplierBill", first.id), note: "Wrong entry" });
    const again = await billFor(po.id, "inv-2026-001", "5");
    expect(again.number).not.toBe(first.number);
  });

  it("3-way match: billing more than was received is an exception that needs an override with a reason", async () => {
    const po = await approvedPo("50");
    const gl = await receive(po.id, po.lines[0]!.id, "20");
    const bill = await billFor(po.id, "OVER-1", "25");
    expect(bill.matchStatus).toBe("EXCEPTION");
    await submit(bill.id);
    // A mismatching bill is not finalized by "submit": it is held for an override.
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PENDING_APPROVAL");
    expect((await errorOf(approve(bill.id))).message).toMatch(/does not match/);
    expect((await errorOf(approve(bill.id, fx.actors.admin, { override: true, note: "ok" }))).message).toMatch(/permission/);
    expect((await errorOf(approve(bill.id, fx.actors.superAdmin, { override: true }))).message).toMatch(/reason/);
    await approve(bill.id, fx.actors.superAdmin, { override: true, note: "Supplier delivered 5 extra bags directly to site; GRN to follow" });
    const b = await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([b.status, b.overrideReason?.slice(0, 8)]).toEqual(["APPROVED", "Supplier"]);
    // The GRN line records only what was actually accepted; the PO line records the full billed quantity.
    expect((await db.grnLine.findUniqueOrThrow({ where: { id: gl.id } })).billedQty.toFixed(0)).toBe("20");
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0]!.id } })).billedQty.toFixed(0)).toBe("25");
    // An Admin (bills.approve) cancels a final bill directly; a user without it cannot. It restores both counters exactly.
    expect((await errorOf(billAction(fx.roles.ac.actor, bill.id, "cancel", { version: await v("supplierBill", bill.id), note: "Re-enter after GRN" }))).message).toMatch(/permission/);
    await billAction(fx.actors.admin, bill.id, "cancel", { version: await v("supplierBill", bill.id), note: "Re-enter after GRN" });
    expect((await db.grnLine.findUniqueOrThrow({ where: { id: gl.id } })).billedQty.toFixed(0)).toBe("0");
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0]!.id } })).billedQty.toFixed(0)).toBe("0");
  });

  it("flags rate variance and GSTIN mismatch in plain words", async () => {
    const po = await approvedPo("50", "100");
    await receive(po.id, po.lines[0]!.id, "50");
    const pre = await billPrefillFromPo(fx.roles.ac.actor, po.id);
    const bill = await createBill(fx.roles.ac.actor, { poId: po.id, supplierInvoiceNo: "RATE-1", invoiceDate: day(), supplierGstin: "27AAACR5055K1Z5", lines: pre.lines.map((l) => ({ ...l, quantity: "5", rate: "110" })) });
    const { bill: view } = await getBill(fx.roles.ac.actor, bill.id);
    expect(view.exceptionList.map((e) => e.code).sort()).toEqual(["GSTIN_MISMATCH", "RATE_VARIANCE"]);
    expect(view.exceptionList.find((e) => e.code === "RATE_VARIANCE")!.message).toMatch(/10\.00% above the PO rate/);
  });

  it("accounts finalizes its own matching bill in one step; users without bill rights cannot", async () => {
    const po = await approvedPo("50");
    await receive(po.id, po.lines[0]!.id, "50");
    const bill = await billFor(po.id, "ONE-1", "5");
    expect((await errorOf(submit(bill.id, fx.roles.se.actor))).message).toMatch(/permission/);
    await submit(bill.id, fx.roles.ac.actor);
    const b = await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([b.status, b.approvedById, b.submittedById]).toEqual(["APPROVED", fx.roles.ac.actor.id, fx.roles.ac.actor.id]);
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0]!.id } })).billedQty.toFixed(0)).toBe("5");
  });

  it("two bills finalized at the same time can never bill more than was received", async () => {
    const po = await approvedPo("50");
    const gl = await receive(po.id, po.lines[0]!.id, "50");
    const a = await billFor(po.id, "CONC-A", "30");
    const b = await billFor(po.id, "CONC-B", "30");
    await Promise.allSettled([submit(a.id), submit(b.id)]);
    const statuses = (await db.supplierBill.findMany({ where: { id: { in: [a.id, b.id] } } })).map((x) => x.status).sort();
    // One is final; the other is refused or held for checking — never both final.
    expect(statuses.filter((s) => s === "APPROVED")).toHaveLength(1);
    expect((await db.grnLine.findUniqueOrThrow({ where: { id: gl.id } })).billedQty.toFixed(0)).toBe("30");
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0]!.id } })).billedQty.toFixed(0)).toBe("30");
    // The remaining 20 can still be billed.
    const pre = await billPrefillFromPo(fx.roles.ac.actor, po.id);
    expect(pre.lines.map((l) => l.quantity)).toEqual(["20"]);
  });

  it("2-way match bills against the ordered quantity before anything is received", async () => {
    await db.orgSettings.update({ where: { organizationId: fx.org.id }, data: { billMatchMode: "TWO_WAY" } });
    const po = await approvedPo("40");
    const pre = await billPrefillFromPo(fx.roles.ac.actor, po.id);
    expect(pre.lines.map((l) => [l.quantity, l.grnLineId])).toEqual([["40", null]]);
    const over = await createBill(fx.roles.ac.actor, { poId: po.id, supplierInvoiceNo: "TW-1", invoiceDate: day(), lines: pre.lines.map((l) => ({ ...l, quantity: "45" })) });
    expect(over.matchStatus).toBe("EXCEPTION");
  });
});

describe("payments, advances and notes", () => {
  it("partial payments move the bill to partially paid, then paid; overpayment is refused", async () => {
    const bill = await approvedBill("10"); // net 1180
    await pay("500", [{ documentId: bill.id, amount: "500" }]);
    let b = await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([b.status, b.paidAmount.toFixed(2)]).toEqual(["PARTIALLY_PAID", "500.00"]);
    expect((await errorOf(pay("700", [{ documentId: bill.id, amount: "700" }]))).message).toMatch(/only ₹680\.00 outstanding/);
    await pay("680", [{ documentId: bill.id, amount: "680" }]);
    b = await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([b.status, b.paidAmount.toFixed(2)]).toEqual(["PAID", "1180.00"]);
    const listed = await listBills(fx.roles.ac.actor, { view: "unpaid" });
    expect(listed.rows.map((r) => r.id)).not.toContain(bill.id);
  });

  it("records an advance and allocates it to a bill later; cannot allocate more than is unallocated", async () => {
    const adv = await pay("1000");
    let p = await getPayment(fx.roles.ac.actor, adv.id);
    expect(p.unallocated).toBe("1000.00");
    const bill = await approvedBill("10"); // 1180
    expect((await errorOf(allocatePayment(fx.roles.ac.actor, adv.id, { documentId: bill.id, amount: "1100" }))).message).toMatch(/Only ₹1,000\.00/);
    await allocatePayment(fx.roles.ac.actor, adv.id, { documentId: bill.id, amount: "1000" });
    p = await getPayment(fx.roles.ac.actor, adv.id);
    expect([p.unallocated, p.payment.allocatedAmount]).toEqual(["0.00", "1000.00"]);
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PARTIALLY_PAID");
  });

  it("a payment belongs to one project and can only settle that project's bills", async () => {
    const bill = await approvedBill("10"); // project p1
    expect((await errorOf(createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, paymentDate: day(), mode: "CASH", amount: "10", idempotencyKey: key() })) as Error & { fieldErrors?: Record<string, string> }).fieldErrors?.projectId).toMatch(/project/i);
    const other = await pay("100", [], { projectId: fx.p2.id });
    expect((await errorOf(allocatePayment(fx.roles.ac.actor, other.id, { documentId: bill.id, amount: "100" }))).message).toMatch(/different project/);
  });

  it("concurrent allocations to the same bill can never exceed what is outstanding", async () => {
    const bill = await approvedBill("10"); // 1180
    const p1 = await pay("700");
    const p2 = await pay("700");
    const res = await Promise.allSettled([allocatePayment(fx.roles.ac.actor, p1.id, { documentId: bill.id, amount: "700" }), allocatePayment(fx.roles.ac.actor, p2.id, { documentId: bill.id, amount: "700" })]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).paidAmount.toFixed(2)).toBe("700.00");
  });

  it("is idempotent on double submit, and cancelling a payment reverses its allocations", async () => {
    const bill = await approvedBill("10");
    const k = key();
    const [a, b] = await Promise.all([pay("1180", [{ documentId: bill.id, amount: "1180" }], { idempotencyKey: k }), pay("1180", [{ documentId: bill.id, amount: "1180" }], { idempotencyKey: k })]);
    expect(a.id).toBe(b.id);
    expect(await db.payment.count({ where: { organizationId: fx.org.id } })).toBe(1);
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PAID");
    // Accounts cancel a recorded payment directly, with a reason.
    expect((await errorOf(cancelPayment(fx.roles.vw.actor, a.id, await v("payment", a.id), "Bounced cheque"))).message).toMatch(/permission/i);
    expect((await errorOf(cancelPayment(fx.roles.ac.actor, a.id, await v("payment", a.id), ""))).message).toMatch(/reason/);
    await cancelPayment(fx.roles.ac.actor, a.id, await v("payment", a.id), "Bounced cheque");
    const after = await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([after.status, after.paidAmount.toFixed(2)]).toEqual(["APPROVED", "0.00"]);
    const alloc = await db.paymentAllocation.findFirstOrThrow({ where: { paymentId: a.id } });
    expect(alloc.reversedAt).not.toBeNull();
  });

  it("reversing one allocation frees the amount back to the payment as an advance", async () => {
    const bill = await approvedBill("10");
    const p = await pay("1180", [{ documentId: bill.id, amount: "1180" }]);
    const alloc = await db.paymentAllocation.findFirstOrThrow({ where: { paymentId: p.id } });
    await reverseAllocation(fx.roles.ac.actor, alloc.id, "Allocated to the wrong bill");
    expect((await errorOf(reverseAllocation(fx.roles.ac.actor, alloc.id, "again"))).message).toMatch(/already reversed/);
    expect((await getPayment(fx.roles.ac.actor, p.id)).unallocated).toBe("1180.00");
  });

  it("an approved credit note reduces what is outstanding; cancelling it restores the amount", async () => {
    const bill = await approvedBill("10"); // 1180
    expect((await errorOf(createNote(fx.roles.ac.actor, { noteType: "CREDIT", partyRole: "SUPPLIER", supplierBillId: bill.id, noteDate: day(), reason: "Too much", taxable: "1100", gstRate: "18" }))).message).toMatch(/more than the/);
    const note = await createNote(fx.roles.ac.actor, { noteType: "CREDIT", partyRole: "SUPPLIER", supplierBillId: bill.id, noteDate: day(), reason: "Rate difference", taxable: "100", gstRate: "18" });
    expect(note.total.toFixed(2)).toBe("118.00");
    // An Admin (bills.approve) applies a credit note directly; a user without it cannot.
    expect((await errorOf(noteAction(fx.roles.ac.actor, note.id, "approve", { version: 1 }))).message).toMatch(/permission/);
    await noteAction(fx.actors.admin, note.id, "approve", { version: 1 });
    const { outstanding } = await getBill(fx.roles.ac.actor, bill.id);
    expect(outstanding).toBe("1062.00");
    await pay("1062", [{ documentId: bill.id, amount: "1062" }]);
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PAID");
    // Cancelling the note after payment re-opens the difference on the bill.
    await noteAction(fx.actors.superAdmin, note.id, "cancel", { version: 2, note: "Supplier withdrew the credit note" });
    const after = await getBill(fx.roles.ac.actor, bill.id);
    expect([after.bill.status, after.outstanding]).toEqual(["PARTIALLY_PAID", "118.00"]);
  });

  it("client receipts with TDS settle issued invoices and the linked running bill", async () => {
    const admin = fx.actors.admin;
    const cpo = await db.clientPo.create({ data: { organizationId: fx.org.id, number: "CPO-T1", clientPoNumber: "ACME/1", projectId: fx.p1.id, partyId: fx.client.id, poDate: new Date(), status: "ACTIVE", createdById: admin.id } });
    const ra = await db.raBill.create({ data: { organizationId: fx.org.id, number: "RAB-T1", raNumber: 1, projectId: fx.p1.id, clientPoId: cpo.id, partyId: fx.client.id, billDate: new Date(), periodFrom: new Date(), periodTo: new Date(), status: "INVOICED", createdById: admin.id } });
    const inv = await db.clientInvoice.create({ data: { organizationId: fx.org.id, number: "INV-T1", projectId: fx.p1.id, partyId: fx.client.id, clientPoId: cpo.id, raBillId: ra.id, invoiceDate: new Date(), taxable: "10000", total: "11800", netReceivable: "11800", status: "ISSUED", createdById: admin.id } });
    const rc = await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", amount: "5000", tdsAmount: "200", idempotencyKey: key(), allocations: [{ documentId: inv.id, amount: "5200" }] });
    expect(rc.number).toMatch(/^RCPT/);
    let i = await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([i.status, i.receivedAmount.toFixed(2)]).toEqual(["PARTIALLY_PAID", "5200.00"]);
    expect((await db.raBill.findUniqueOrThrow({ where: { id: ra.id } })).status).toBe("PARTIALLY_PAID");
    await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "UPI", amount: "6600", idempotencyKey: key(), allocations: [{ documentId: inv.id, amount: "6600" }] });
    i = await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(i.status).toBe("PAID");
    expect((await db.raBill.findUniqueOrThrow({ where: { id: ra.id } })).status).toBe("PAID");
    // A supplier cannot be the party of a receipt.
    expect((await errorOf(createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.supplier.id, projectId: fx.p1.id, paymentDate: day(), mode: "UPI", amount: "1", idempotencyKey: key() }))).message).toMatch(/client/);
  });
});
