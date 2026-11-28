import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { projectFinancials } from "@/modules/insights/finance";
import { projectAccountsDashboard } from "@/modules/insights/project-accounts";
import { billAction, billPrefillFromPo, createBill } from "@/modules/payables/bills";
import { allocatePayment, createPayment } from "@/modules/payables/payments";
import { createPo, getPo, poAction } from "@/modules/procurement/po";
import { clientAccount } from "@/modules/sales/client-account";
import { clientPoAction, createClientPo } from "@/modules/sales/client-po";
import { clientInvoiceAction, createClientInvoice } from "@/modules/sales/invoice";
import { certifyRaBill, createRaBill, getRaBill, raBillAction } from "@/modules/sales/ra-bill";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { prepareRaBillPayment } from "@/modules/sales/quick-bill";
import { addMoney as addMoneyStr } from "@/lib/money";
import { generateSoRunningBill, soBillingPosition } from "@/modules/sales/so-running-bill";
import { issueMaterialToSite } from "@/modules/stores/site-issue";
import { PDF, commercialFixture, day, errorOf, key, receiveWithProof, type CFx } from "./commercial-helpers";

/**
 * SO / PO driven workflow (2026-11-27): the sales order runs the client side without a client PO, the
 * purchase order runs the supplier side; client POs stay optional references.
 */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "salesOrder" | "raBill" | "clientInvoice" | "purchaseOrder" | "supplierBill" | "clientPo";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

async function confirmedSo(qty: string, rate = "1000", extra: Record<string, unknown> = {}) {
  const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(-5), lines: [{ kind: "MATERIAL", itemBrandId: fx.ibUltra.id, quantity: qty, rate, gstRate: "0" }], ...extra });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
  return db.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

/** Site challan from the warehouse (optionally for one order line), received at site with proof. */
async function issueAndReceive(qty: string, soLineId?: string) {
  const c = await issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, soLineId }] });
  const line = await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } });
  await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: c.id, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: qty }] });
  return line;
}

async function deliverDirect(qty: string) {
  const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "400", gstRate: "18" }] });
  await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
  const pl = await db.poLine.findFirstOrThrow({ where: { poId: po.id } });
  await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: pl.id, receivedQty: qty }] });
}

async function certifyAndInvoice(billId: string) {
  await raBillAction(fx.roles.pm.actor, billId, "submit_review", { version: await v("raBill", billId) });
  const bill = await getRaBill(fx.actors.admin, billId);
  await certifyRaBill(fx.roles.ac.actor, billId, await v("raBill", billId), { clientCertRef: `CERT-${billId.slice(0, 4)}`, clientCertDate: day(), lines: bill.bill.lines.map((l) => ({ lineId: l.id, certifiedQty: l.claimedQty })) });
  const inv = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: billId, invoiceDate: day() });
  await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
  return db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } });
}

const receipt = (input: Record<string, unknown>) => createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", reference: `UTR-${key().slice(0, 5)}`, idempotencyKey: key(), allocations: [], ...input });

describe("client side runs on the sales order (client PO optional)", () => {
  it("Test 1: SO without client PO → challan → site receipt → running bill → invoice → payment", async () => {
    const so = await confirmedSo("100");
    expect(so.clientPoId).toBeNull();
    const cl = await issueAndReceive("40");
    expect(cl.soLineId).toBe(so.lines[0]!.id); // only one order carries the item → linked automatically
    const b = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    const view = (await getRaBill(fx.roles.pm.actor, b.id)).bill;
    expect([view.basis, view.claimedAmount, view.statement.totalPayable]).toEqual(["SO", "40000.00", "40000.00"]);
    const inv = await certifyAndInvoice(b.id);
    expect([inv.soId, inv.clientPoId]).toEqual([so.id, null]);
    const p = await receipt({ soId: so.id, amount: "40000", allocations: [{ documentId: inv.id, amount: "40000" }] });
    expect([p.soId, p.projectId]).toEqual([so.id, fx.p1.id]);
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    const acc = await clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id, soId: so.id });
    expect(acc).toMatchObject({ contractValue: "100000.00", deliveredValue: "40000.00", runningBillValue: "40000.00", invoiced: "40000.00", received: "40000.00", outstandingBilled: "0.00", clientAdvances: "0.00", unbilled: "60000.00", remainingContract: "60000.00" });
  });

  it("Test 2: several sales orders in one project — traced challans bill the right order; accounts add up once", async () => {
    const a = await confirmedSo("50", "1000");
    const b = await confirmedSo("50", "2000");
    // Issued for order B explicitly: billed on B, never on A.
    await issueAndReceive("20", b.lines[0]!.id);
    let [pa, pb] = await Promise.all([soBillingPosition(db, a.id), soBillingPosition(db, b.id)]);
    expect([pa.lines[0]!.delivered, pb.lines[0]!.delivered]).toEqual(["0", "20"]);
    // Untraced delivery (direct supplier-to-site): shared oldest order first.
    await deliverDirect("10");
    [pa, pb] = await Promise.all([soBillingPosition(db, a.id), soBillingPosition(db, b.id)]);
    expect([pa.lines[0]!.delivered, pb.lines[0]!.delivered]).toEqual(["10", "20"]);
    const rb = await generateSoRunningBill(fx.roles.pm.actor, { soId: b.id });
    expect((await getRaBill(fx.roles.pm.actor, rb.id)).bill.claimedAmount).toBe("40000.00"); // 20 × ₹2,000
    // A choice that does not carry the material is refused.
    const wrong = await errorOf(issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibAcc.id, quantity: "1", soLineId: a.lines[0]!.id }] }));
    expect(wrong.message).toMatch(/does not carry this material/);
    // Project contract = both orders, counted once.
    const acc = await clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id });
    expect([acc.contractValue, acc.deliveredValue, acc.runningBillValue]).toEqual(["150000.00", "50000.00", "40000.00"]);
  });

  it("Test 3: cumulative running bills keep unpaid earlier bills visible without billing them again", async () => {
    const so = await confirmedSo("1000"); // ₹10,00,000
    await issueAndReceive("100");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await certifyAndInvoice(b1.id);
    await deliverDirect("50");
    const b2 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    const view = (await getRaBill(fx.roles.pm.actor, b2.id)).bill;
    expect(view.statement).toEqual({ previousValue: "100000.00", currentValue: "50000.00", cumulativeValue: "150000.00", previousBilled: "100000.00", currentBilling: "50000.00", previousOutstanding: "100000.00", receivedToDate: "0.00", totalPayable: "150000.00" });
    expect(view.lines.map((l) => [l.prevCertifiedQty, l.claimedQty])).toEqual([["100", "50"]]);
    const inv2 = await certifyAndInvoice(b2.id);
    expect(inv2.netReceivable.toFixed(2)).toBe("50000.00"); // only the new billing becomes a receivable
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id }))).message).toMatch(/Nothing new to bill/);
  });

  it("Test 4: client advance against a sales order, applied to a later invoice — counted once", async () => {
    const so = await confirmedSo("100");
    const adv = await receipt({ soId: so.id, amount: "30000" });
    let acc = await clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id, soId: so.id });
    expect([acc.clientAdvances, acc.paymentReceived, acc.remainingContract]).toEqual(["30000.00", "30000.00", "70000.00"]);
    await issueAndReceive("50");
    const bill = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    // The unallocated advance recorded against the order counts as received on the bill's statement.
    expect((await getRaBill(fx.roles.pm.actor, bill.id)).bill.statement?.receivedToDate).toBe("30000.00");
    const inv = await certifyAndInvoice(bill.id);
    await allocatePayment(fx.roles.ac.actor, adv.id, { documentId: inv.id, amount: "30000" });
    acc = await clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id, soId: so.id });
    expect([acc.received, acc.clientAdvances, acc.paymentReceived, acc.outstandingBilled]).toEqual(["30000.00", "0.00", "30000.00", "20000.00"]);
    const project = await clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id });
    expect(project.paymentReceived).toBe("30000.00");
    // An order's advance can't settle another order's invoice; supplier payments can't carry a sales order.
    const other = await confirmedSo("10");
    await issueAndReceive("10", other.lines[0]!.id);
    const inv2 = await certifyAndInvoice((await generateSoRunningBill(fx.roles.pm.actor, { soId: other.id })).id);
    const adv2 = await receipt({ soId: so.id, amount: "5000" });
    expect((await errorOf(allocatePayment(fx.roles.ac.actor, adv2.id, { documentId: inv2.id, amount: "5000" }))).message).toMatch(/another sales order/);
    expect((await errorOf(createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, projectId: fx.p1.id, soId: so.id, paymentDate: day(), mode: "CASH", amount: "1", idempotencyKey: key() }))).message).toMatch(/Only client receipts/);
  });

  it("Test 8: client-PO linked orders bill on the sales order; legacy client-PO billing keeps working; no double contract", async () => {
    const cpo = await createClientPo(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: `PO-${key().slice(0, 6)}`, poDate: day(-20), lines: [{ description: "Cement", unit: "Bag", quantity: "100", rate: "1000", gstRate: "0" }] });
    await clientPoAction(fx.roles.pm.actor, cpo.id, "submit", { version: await v("clientPo", cpo.id) });
    const cpoLine = await db.clientPoLine.findFirstOrThrow({ where: { clientPoId: cpo.id } });
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoId: cpo.id, orderDate: day(-5), lines: [{ kind: "MATERIAL", itemBrandId: fx.ibUltra.id, clientPoLineId: cpoLine.id, quantity: "60", rate: "1000", gstRate: "0" }] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    // Contract value: the order, not order + client PO.
    expect((await clientAccount(fx.roles.ac.actor, { projectId: fx.p1.id })).contractValue).toBe("60000.00");
    expect((await projectFinancials(fx.org.id, [fx.p1.id])).get(fx.p1.id)!.contractValue).toBe("60000.00");
    await issueAndReceive("30");
    const rb = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    expect((await getRaBill(fx.roles.pm.actor, rb.id)).bill.basis).toBe("SO");
    // Once the order is billed on the SO, a parallel client-PO bill is refused (one statement, no double billing).
    const cpoBill = await errorOf(createRaBill(fx.roles.pm.actor, { clientPoId: cpo.id, billDate: day(), periodFrom: day(-5), periodTo: day(), lines: [{ clientPoLineId: cpoLine.id, claimedQty: "10" }] }));
    expect(cpoBill.message).toMatch(/billed by sales-order running bills/);

    // Legacy contract already billed on its own client PO: continues there; SO bills are refused for it.
    const legacy = await createClientPo(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: `PO-${key().slice(0, 6)}`, poDate: day(-20), lines: [{ description: "Works", unit: "Unit", quantity: "10", rate: "500", gstRate: "0" }] });
    await clientPoAction(fx.roles.pm.actor, legacy.id, "submit", { version: await v("clientPo", legacy.id) });
    const ll = await db.clientPoLine.findFirstOrThrow({ where: { clientPoId: legacy.id } });
    const old = await createRaBill(fx.roles.pm.actor, { clientPoId: legacy.id, billDate: day(), periodFrom: day(-5), periodTo: day(), lines: [{ clientPoLineId: ll.id, claimedQty: "2" }] });
    expect(old.id).toBeTruthy();
    const so2 = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoId: legacy.id, orderDate: day(-5), lines: [{ kind: "SERVICE", description: "Works", unit: "Unit", clientPoLineId: ll.id, quantity: "10", rate: "500", gstRate: "0" }] });
    await salesOrderAction(fx.roles.pm.actor, so2.id, "submit", { version: await v("salesOrder", so2.id) });
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so2.id, isFinal: true }))).message).toMatch(/already billed on its own running bills/);
  });

  it("Test 9: unauthorized roles and repeated submits", async () => {
    const so = await confirmedSo("10");
    await issueAndReceive("5");
    expect((await errorOf(generateSoRunningBill(fx.roles.vw.actor, { soId: so.id }))).message).toMatch(/permission/i);
    const k = key();
    const p1 = await receipt({ soId: so.id, amount: "100", idempotencyKey: k });
    const p2 = await receipt({ soId: so.id, amount: "100", idempotencyKey: k });
    expect(p2.id).toBe(p1.id);
    expect(await db.payment.count({ where: { soId: so.id } })).toBe(1);
  });
});

describe("supplier side runs on the purchase order", () => {
  it("Tests 5–6: advance before receipt, partial receipt, bill and partial payment — PO summary counts each rupee once", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "100", rate: "100", gstRate: "18" }] }); // ₹11,800
    await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
    // Supplier advance before any material: a PO advance, not a payable.
    await createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, poId: po.id, paymentDate: day(), mode: "BANK_TRANSFER", amount: "2000", idempotencyKey: key() }, { fileName: "advice.pdf", bytes: PDF });
    let f = (await getPo(fx.roles.pu.actor, po.id)).financial!;
    expect(f).toMatchObject({ poValue: "11800.00", receivedValue: "0.00", billed: "0.00", advance: "2000.00", paid: "2000.00", outstanding: "0.00", unbilledCommitment: "11800.00", remainingPayment: "9800.00" });
    // Partial receipt with mandatory proof → stock + PO counters.
    const before = await db.stockTransaction.count({ where: { organizationId: fx.org.id } });
    const pl = await db.poLine.findFirstOrThrow({ where: { poId: po.id } });
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: pl.id, receivedQty: "40" }] });
    expect((await db.poLine.findUniqueOrThrow({ where: { id: pl.id } })).acceptedQty.toString()).toBe("40");
    const afterReceipt = await db.stockTransaction.count({ where: { organizationId: fx.org.id } });
    expect(afterReceipt).toBeGreaterThan(before);
    // Bill for the received 40 (₹4,720) — no stock movement.
    const pre = await billPrefillFromPo(fx.roles.ac.actor, po.id);
    const bill = await createBill(fx.roles.ac.actor, { poId: po.id, supplierInvoiceNo: `SINV-${key().slice(0, 6)}`, invoiceDate: day(), lines: pre.lines.map((l) => ({ ...l, quantity: "40" })) });
    await billAction(fx.roles.ac.actor, bill.id, "submit", { version: await v("supplierBill", bill.id) });
    expect(await db.stockTransaction.count({ where: { organizationId: fx.org.id } })).toBe(afterReceipt);
    // Advance adjusted + partial payment.
    const adv = await db.payment.findFirstOrThrow({ where: { poId: po.id } });
    await allocatePayment(fx.roles.ac.actor, adv.id, { documentId: bill.id, amount: "2000" });
    await createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, poId: po.id, paymentDate: day(), mode: "BANK_TRANSFER", amount: "1000", idempotencyKey: key(), allocations: [{ documentId: bill.id, amount: "1000" }] });
    f = (await getPo(fx.roles.pu.actor, po.id)).financial!;
    expect(f).toMatchObject({ receivedValue: "4720.00", pendingValue: "7080.00", billed: "4720.00", paid: "3000.00", advance: "0.00", outstanding: "1720.00", unbilledCommitment: "7080.00", remainingPayment: "8800.00" });
    const d = await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id);
    expect(d.supplier).toMatchObject({ poValue: "11800.00", supplierBills: "4720.00", paymentsMade: "3000.00", outstanding: "1720.00" });
  });

  it("Test 7: a general-stock PO has no project and is never charged to a project", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: null, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "10", rate: "100", gstRate: "0" }] });
    await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).projectId).toBeNull();
    expect((await getPo(fx.roles.pu.actor, po.id)).financial!.poValue).toBe("1000.00");
    expect((await projectAccountsDashboard(fx.roles.ac.actor, fx.p1.id)).supplier.poValue).toBe("0.00");
  });
});

describe("running bills follow dispatched challans and are settled by client payments (owner rule 2026-11-27)", () => {
  /** Site challan from the warehouse, dispatched only (not yet received at site). */
  async function dispatchOnly(qty: string) {
    const c = await issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty }] });
    return { challanId: c.id, line: await db.challanLine.findFirstOrThrow({ where: { challanId: c.id } }) };
  }
  const billable = async (soId: string) => (await soBillingPosition(db, soId)).lines[0]!.billable;

  it("dispatch makes material billable; site receipt adds nothing; damage recorded later comes off the next bill", async () => {
    const so = await confirmedSo("100");
    const { challanId, line } = await dispatchOnly("50");
    expect(await billable(so.id)).toBe("50");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    expect((await getRaBill(fx.roles.pm.actor, b1.id)).bill.lines.map((l) => l.claimedQty)).toEqual(["50"]);
    // The site confirms 50 received, 5 of them damaged: the receipt itself never adds billable quantity.
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: "50", damagedQty: "5" }] });
    await raBillAction(fx.roles.pm.actor, b1.id, "submit_review", { version: await v("raBill", b1.id) });
    expect(await billable(so.id)).toBe("0");
    // Next dispatch of 20: only 15 is billable (the 5 damaged already billed are deducted).
    await dispatchOnly("20");
    expect(await billable(so.id)).toBe("15");
    // Supplier delivery straight to site still counts once its receipt is confirmed.
    await deliverDirect("10");
    expect(await billable(so.id)).toBe("25");
  });

  it("a shortfall returned to the warehouse comes off; cancelled / draft challans never count", async () => {
    const so = await confirmedSo("100");
    const { challanId } = await dispatchOnly("30");
    const c = await db.challan.findUniqueOrThrow({ where: { id: challanId } });
    const { challanAction } = await import("@/modules/stores/challan");
    await challanAction(fx.roles.sk.actor, challanId, "close_discrepancy", { version: c.version, note: "Lorry turned back", resolution: "RETURN" });
    expect(await billable(so.id)).toBe("0");
  });

  it("final bill raises a GST credit note for material billed earlier that never fully reached the site", async () => {
    const so = await confirmedSo("100", "1000", { lines: [
      { kind: "MATERIAL", itemBrandId: fx.ibUltra.id, quantity: "100", rate: "1000", gstRate: "18" },
      { kind: "INSTALLATION", description: "Installation", unit: "LS", quantity: "1", rate: "20000", gstRate: "18" },
    ] });
    const { challanId, line } = await dispatchOnly("50");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await raBillAction(fx.roles.pm.actor, b1.id, "submit_review", { version: await v("raBill", b1.id) });
    // After billing, the site records 5 damaged.
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: "50", damagedQty: "5" }] });
    // A normal bill carries no credit; the final bill credits 5 × ₹1,000 + 18% GST = ₹5,900.
    const fin = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, isFinal: true });
    let r = await db.raBill.findUniqueOrThrow({ where: { id: fin.id } });
    // The bill keeps its full value; the credit is shown and taken off the total payable, raised as a credit note on invoicing.
    expect([r.shortageCredit.toFixed(2), r.gstAmount.toFixed(2), r.netPayable.toFixed(2)]).toEqual(["5900.00", "3600.00", "23600.00"]);
    expect((await getRaBill(fx.roles.pm.actor, fin.id)).bill.statement!.totalPayable).toBe(addMoneyStr(r.previousOutstanding.toFixed(2), "17700.00"));
    expect(r.deductionNotes).toMatch(/Shortage \/ damage credit \(GST credit note on invoicing\): line 1 .* 5 .* billed but not delivered = ₹5900.00/);
    // Refreshing the draft (notes sent back from the form) neither doubles the credit nor the note.
    await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, isFinal: true, deductionNotes: `Site measured. ${r.deductionNotes}` });
    r = await db.raBill.findUniqueOrThrow({ where: { id: fin.id } });
    expect(r.shortageCredit.toFixed(2)).toBe("5900.00");
    expect(r.deductionNotes!.match(/Shortage/g)).toHaveLength(1);
    expect(r.deductionNotes).toMatch(/^Site measured\./);
    // The credit survives certification and reduces the invoice the client pays.
    await raBillAction(fx.roles.pm.actor, fin.id, "submit_review", { version: await v("raBill", fin.id) });
    const t = await prepareRaBillPayment(fx.roles.ac.actor, fin.id);
    const inv = await db.clientInvoice.findUniqueOrThrow({ where: { id: t.invoiceId } });
    expect([inv.total.toFixed(2), inv.netReceivable.toFixed(2), inv.adjustedAmount.toFixed(2)]).toEqual(["23600.00", "23600.00", "5900.00"]);
    const notes = await db.adjustmentNote.findMany({ where: { clientInvoiceId: inv.id } });
    expect(notes.map((n) => [n.noteType, n.partyRole, n.status, n.taxable.toFixed(2), n.gstRate.toFixed(2), n.taxAmount.toFixed(2), n.total.toFixed(2)])).toEqual([["CREDIT", "CLIENT", "APPROVED", "5000.00", "18.00", "900.00", "5900.00"]]);
    expect(notes[0]!.number).toMatch(/^CN\//);
    expect(notes[0]!.reason).toMatch(/billed but not delivered/);
    // Client pays the rest (₹17,700) and the final bill is settled.
    await receipt({ soId: so.id, amount: "17700", allocations: [{ documentId: inv.id, amount: "17700" }] });
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
  });

  it("a credit larger than the final invoice spills onto the order's other open invoices", async () => {
    const so = await confirmedSo("100", "1000", { lines: [
      { kind: "MATERIAL", itemBrandId: fx.ibUltra.id, quantity: "100", rate: "1000", gstRate: "18" },
      { kind: "INSTALLATION", description: "Installation", unit: "LS", quantity: "1", rate: "1000", gstRate: "18" },
    ] });
    const { challanId, line } = await dispatchOnly("20");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await raBillAction(fx.roles.pm.actor, b1.id, "submit_review", { version: await v("raBill", b1.id) });
    const inv1 = await prepareRaBillPayment(fx.roles.ac.actor, b1.id); // RA-1 invoiced ₹23,600, unpaid
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: "20", damagedQty: "5" }] });
    const fin = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, isFinal: true });
    await raBillAction(fx.roles.pm.actor, fin.id, "submit_review", { version: await v("raBill", fin.id) });
    const t = await prepareRaBillPayment(fx.roles.ac.actor, fin.id); // final invoice ₹1,180; credit ₹5,900
    const notes = await db.adjustmentNote.findMany({ where: { noteType: "CREDIT", clientInvoiceId: { in: [t.invoiceId, inv1.invoiceId] } }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => [n.clientInvoiceId, n.total.toFixed(2)])).toEqual([[t.invoiceId, "1180.00"], [inv1.invoiceId, "4720.00"]]);
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: t.invoiceId } })).status).toBe("PAID");
    expect((await db.clientInvoice.findUniqueOrThrow({ where: { id: inv1.invoiceId } })).adjustedAmount.toFixed(2)).toBe("4720.00");
    expect((await db.raBill.findUniqueOrThrow({ where: { id: fin.id } })).shortageCredit.toFixed(2)).toBe("5900.00");
  });

  it("a final bill with nothing left to bill cannot carry the credit (credit note instead)", async () => {
    const so = await confirmedSo("100", "1000");
    const { challanId, line } = await dispatchOnly("10");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await raBillAction(fx.roles.pm.actor, b1.id, "submit_review", { version: await v("raBill", b1.id) });
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId, receiptDate: day(), lines: [{ challanLineId: line.id, receivedQty: "10", damagedQty: "2" }] });
    expect((await errorOf(generateSoRunningBill(fx.roles.pm.actor, { soId: so.id, isFinal: true }))).message).toMatch(/shortage credit \(2000.00\).*credit note/);
  });

  it("client payment recorded on the bill raises the invoice; the unpaid part carries into the next bill", async () => {
    const so = await confirmedSo("100");
    await dispatchOnly("40");
    const b1 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    expect((await errorOf(prepareRaBillPayment(fx.roles.ac.actor, b1.id))).message).toMatch(/Submit the bill/);
    await raBillAction(fx.roles.pm.actor, b1.id, "submit_review", { version: await v("raBill", b1.id) });
    const t = await prepareRaBillPayment(fx.roles.ac.actor, b1.id);
    const inv = await db.clientInvoice.findUniqueOrThrow({ where: { id: t.invoiceId } });
    expect([inv.status, inv.raBillId, inv.netReceivable.toFixed(2), t.soId]).toEqual(["ISSUED", b1.id, "40000.00", so.id]);
    // Calling again (e.g. a second instalment) reuses the same invoice.
    expect((await prepareRaBillPayment(fx.roles.ac.actor, b1.id)).invoiceId).toBe(t.invoiceId);
    await receipt({ soId: so.id, amount: "25000", allocations: [{ documentId: t.invoiceId, amount: "25000" }] });
    expect((await db.raBill.findUniqueOrThrow({ where: { id: b1.id } })).status).toBe("PARTIALLY_PAID");
    await dispatchOnly("10");
    const b2 = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    const st = (await getRaBill(fx.roles.pm.actor, b2.id)).bill.statement!;
    expect([st.previousOutstanding, st.receivedToDate, st.currentBilling, st.totalPayable]).toEqual(["15000.00", "25000.00", "10000.00", "25000.00"]);
    // Paying the rest settles the first bill.
    await receipt({ soId: so.id, amount: "15000", allocations: [{ documentId: t.invoiceId, amount: "15000" }] });
    expect((await db.raBill.findUniqueOrThrow({ where: { id: b1.id } })).status).toBe("PAID");
    expect((await errorOf(prepareRaBillPayment(fx.roles.ac.actor, b1.id))).message).toMatch(/already fully paid/);
  });
});
