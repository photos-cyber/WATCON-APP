"use server";

import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { clientPoAction, createClientPo, setMilestoneStatus, updateClientPo, type CpoAction } from "./client-po";
import { clientInvoiceAction, createClientInvoice, updateClientInvoice, type InvoiceAction } from "./invoice";
import { certifyRaBill, createRaBill, raBillAction, updateRaBill, type RaAction } from "./ra-bill";
import { generateSoRunningBill } from "./so-running-bill";
import { acceptRaBillAndInvoice, prepareRaBillPayment } from "./quick-bill";
import { createSalesOrder, decideSoAmendment, requestSoAmendment, salesOrderAction, updateSalesOrder, withdrawSoAmendment, type SoAction } from "./sales-order";

const P = ["/client-pos", "/sales-orders", "/running-bills", "/client-invoices", "/projects", "/material-planning", "/approvals", "/dashboard"];
type Opts = { version: number; note?: string | null };

// Client POs
export async function createClientPoAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createClientPo(a, input)).id }), P);
}
export async function updateClientPoAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await updateClientPo(a, String(id), Number(version), input);
    return { id };
  }, P);
}
export async function clientPoActionAction(id: string, action: CpoAction, opts: Opts) {
  return runAction(async (a) => {
    await clientPoAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null });
  }, P);
}
export async function setMilestoneStatusAction(id: string, status: "PENDING" | "BILLED" | "RECEIVED") {
  return runAction(async (a) => {
    await setMilestoneStatus(a, String(id), status);
  }, P);
}

// Sales orders
/** `confirm: true` = "Save & confirm order" in one click (the draft is kept if confirming fails). */
async function confirmAfterSave(a: Parameters<typeof salesOrderAction>[0], id: string) {
  const { version } = await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { version: true } });
  try {
    await salesOrderAction(a, id, "submit", { version });
    return { confirmed: true, confirmError: null as string | null };
  } catch (e) {
    return { confirmed: false, confirmError: e instanceof Error ? e.message : "Could not confirm the order." };
  }
}
export async function createSalesOrderAction(input: unknown, opts?: { confirm?: boolean }) {
  return runAction(async (a) => {
    const id = (await createSalesOrder(a, input)).id;
    return { id, ...(opts?.confirm ? await confirmAfterSave(a, id) : { confirmed: false, confirmError: null }) };
  }, P);
}
export async function updateSalesOrderAction(id: string, version: number, input: unknown, opts?: { confirm?: boolean }) {
  return runAction(async (a) => {
    await updateSalesOrder(a, String(id), Number(version), input);
    return { id, ...(opts?.confirm ? await confirmAfterSave(a, String(id)) : { confirmed: false, confirmError: null }) };
  }, P);
}
export async function salesOrderActionAction(id: string, action: SoAction, opts: Opts) {
  return runAction(async (a) => {
    await salesOrderAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null });
  }, P);
}
export async function requestSoAmendmentAction(soId: string, input: unknown) {
  return runAction(async (a) => ({ id: (await requestSoAmendment(a, String(soId), input)).id }), P);
}
export async function withdrawSoAmendmentAction(requestId: string) {
  return runAction(async (a) => {
    await withdrawSoAmendment(a, String(requestId));
  }, P);
}
export async function decideSoAmendmentAction(requestId: string, decision: "approve" | "reject", note: string | null) {
  return runAction(async (a) => decideSoAmendment(a, String(requestId), decision === "approve" ? "approve" : "reject", note), P);
}

// Running bills
/** Generate the next cumulative running bill for a sales order, or refresh (consolidate) its draft. */
export async function generateSoRunningBillAction(input: unknown) {
  return runAction(async (a) => generateSoRunningBill(a, input), P);
}
export async function createRaBillAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createRaBill(a, input)).id }), P);
}
export async function updateRaBillAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await updateRaBill(a, String(id), Number(version), input);
    return { id };
  }, P);
}
export async function raBillActionAction(id: string, action: RaAction, opts: Opts) {
  return runAction(async (a) => {
    await raBillAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null });
  }, P);
}
export async function certifyRaBillAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await certifyRaBill(a, String(id), Number(version), input);
  }, P);
}
/** "Client accepted — invoice now": certify as claimed + create + issue the invoice. */
export async function acceptRaBillAndInvoiceAction(id: string, input: unknown) {
  return runAction(async (a) => acceptRaBillAndInvoice(a, String(id), input), [...P, "/payments", "/accounts"]);
}
/** "Record client payment" on a running bill: makes sure its invoice exists and is issued, returns where to pay. */
export async function prepareRaBillPaymentAction(id: string) {
  return runAction(async (a) => prepareRaBillPayment(a, String(id)), [...P, "/payments", "/accounts"]);
}

// Client invoices
export async function createClientInvoiceAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createClientInvoice(a, input)).id }), P);
}
export async function updateClientInvoiceAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await updateClientInvoice(a, String(id), Number(version), input);
  }, P);
}
export async function clientInvoiceActionAction(id: string, action: InvoiceAction, opts: Opts) {
  return runAction(async (a) => clientInvoiceAction(a, String(id), action === "issue" ? "issue" : "cancel", { version: Number(opts.version), note: opts.note ?? null }), P);
}
