"use server";

import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { billAction, billPrefillFromPo, createBill, updateBill, type BillAction } from "./bills";
import { createNote, noteAction } from "./notes";
import { allocatePayment, cancelPayment, createPayment, reverseAllocation, refundClientAdvance } from "./payments";

const P = ["/supplier-bills", "/payments", "/notes", "/purchase-orders", "/projects", "/approvals", "/dashboard", "/client-invoices", "/running-bills"];
type Opts = { version: number; note?: string | null; override?: boolean };

/** "Save & finalize": finalize right after the save; if that fails the draft stays and the reason is returned. */
async function finalizeBillAfterSave(a: Parameters<typeof billAction>[0], id: string) {
  const { version } = await db.supplierBill.findUniqueOrThrow({ where: { id }, select: { version: true } });
  try {
    const r = (await billAction(a, id, "submit", { version })) as { approved?: boolean; exceptions?: string[] } | undefined;
    return { finalized: r?.approved !== false, held: r?.approved === false ? (r.exceptions ?? []) : null, finalizeError: null as string | null };
  } catch (e) {
    return { finalized: false, held: null, finalizeError: e instanceof Error ? e.message : "Could not finalize the bill." };
  }
}
export async function createBillAction(input: unknown, opts?: { finalize?: boolean }) {
  return runAction(async (a) => {
    const id = (await createBill(a, input)).id;
    return { id, ...(opts?.finalize ? await finalizeBillAfterSave(a, id) : { finalized: false, held: null, finalizeError: null }) };
  }, P);
}
export async function updateBillAction(id: string, version: number, input: unknown, opts?: { finalize?: boolean }) {
  return runAction(async (a) => {
    await updateBill(a, String(id), Number(version), input);
    return { id, ...(opts?.finalize ? await finalizeBillAfterSave(a, String(id)) : { finalized: false, held: null, finalizeError: null }) };
  }, P);
}
export async function billActionAction(id: string, action: BillAction, opts: Opts) {
  const allowed: BillAction[] = ["submit", "approve", "reject", "cancel"];
  return runAction(async (a) => {
    if (!allowed.includes(action)) throw new Error("Unknown action");
    const r = await billAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null, override: opts.override === true });
    return r && typeof r === "object" && "approved" in r ? r : null;
  }, P);
}
export async function billPrefillAction(poId: string) {
  return runAction(async (a) => billPrefillFromPo(a, String(poId)));
}

/** `proof` (optional FormData with a `file`) is stored with the payment in the same transaction. */
export async function createPaymentAction(input: unknown, proof?: FormData | null) {
  return runAction(async (a) => {
    const file = proof?.get("file");
    const p = file instanceof File && file.size > 0 ? { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
    return { id: (await createPayment(a, input, p)).id };
  }, P);
}
export async function refundClientAdvanceAction(receiptId: string, input: unknown) {
  return runAction(async (a) => ({ id: (await refundClientAdvance(a, String(receiptId), input)).id }), P);
}
export async function allocatePaymentAction(paymentId: string, input: unknown) {
  return runAction(async (a) => {
    await allocatePayment(a, String(paymentId), input);
  }, P);
}
export async function reverseAllocationAction(allocationId: string, reason: string) {
  return runAction(async (a) => {
    await reverseAllocation(a, String(allocationId), reason ? String(reason) : null);
  }, P);
}
export async function cancelPaymentAction(id: string, version: number, reason: string) {
  return runAction(async (a) => {
    await cancelPayment(a, String(id), Number(version), reason ? String(reason) : null);
  }, P);
}

export async function createNoteAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createNote(a, input)).id }), P);
}
export async function noteActionAction(id: string, action: "approve" | "cancel", opts: Opts) {
  return runAction(async (a) => {
    await noteAction(a, String(id), action === "approve" ? "approve" : "cancel", { version: Number(opts.version), note: opts.note ?? null });
  }, P);
}
