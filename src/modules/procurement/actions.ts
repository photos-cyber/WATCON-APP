"use server";

import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { createPoFromPlanning, createRfqFromPlanning } from "@/modules/planning/ordering";
import { saveRequirement, setGeneralPurchaseQty, setPlanningAttributes, setRequirementStatus } from "@/modules/planning/service";
import { createPo, poAction, updatePo, type PoAction } from "./po";
import { createPr, createPrFromMrp, prAction, updatePr, type PrAction } from "./pr";
import { addRfqSuppliers, convertQuotationToPo, createPosFromAward, createRfq, markRfqSupplierShared, proposeAward, recordQuotation, rfqAction, type RfqAction } from "./rfq";

const P = ["/material-planning", "/purchase-requisitions", "/rate-enquiries", "/purchase-orders", "/projects", "/site-receipts", "/approvals", "/dashboard"];
type Opts = { version: number; note?: string | null; via?: string | null };

// Material planning
export async function saveRequirementAction(input: unknown) {
  return runAction(async (a) => ({ id: (await saveRequirement(a, input)).id }), P);
}
export async function setRequirementStatusAction(id: string, status: "OPEN" | "CLOSED" | "CANCELLED") {
  return runAction(async (a) => {
    await setRequirementStatus(a, String(id), status === "OPEN" || status === "CLOSED" ? status : "CANCELLED");
  }, P);
}
export async function setPlanningAttributesAction(itemBrandId: string, input: unknown) {
  return runAction(async (a) => {
    await setPlanningAttributes(a, String(itemBrandId), input);
  }, [...P, "/items"]);
}
export async function setGeneralPurchaseQtyAction(input: unknown) {
  return runAction(async (a) => {
    await setGeneralPurchaseQty(a, input);
  }, P);
}
export async function createPoFromPlanningAction(input: unknown, opts?: { finalize?: boolean }) {
  return runAction(async (a) => {
    const po = await createPoFromPlanning(a, input);
    return { ...po, ...(opts?.finalize ? await finalizeAfterSave(a, po.id) : { finalized: false, finalizeError: null }) };
  }, P);
}
export async function createRfqFromPlanningAction(input: unknown) {
  return runAction(async (a) => createRfqFromPlanning(a, input), P);
}
export async function createPrFromMrpAction(input: unknown) {
  return runAction(async (a) => {
    const pr = await createPrFromMrp(a, input);
    return { id: pr.id, number: pr.number };
  }, P);
}

// Requisitions
export async function createPrAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createPr(a, input)).id }), P);
}
export async function updatePrAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await updatePr(a, String(id), Number(version), input);
    return { id };
  }, P);
}
export async function prActionAction(id: string, action: PrAction, opts: Opts) {
  return runAction(async (a) => {
    await prAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null });
  }, P);
}

// RFQ
export async function createRfqAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createRfq(a, input)).id }), P);
}
export async function rfqActionAction(id: string, action: RfqAction, opts: Opts) {
  return runAction(async (a) => {
    await rfqAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null, via: opts.via ?? null });
  }, P);
}
export async function markRfqSupplierSharedAction(rfqId: string, partyId: string, via: string) {
  return runAction(async (a) => {
    await markRfqSupplierShared(a, String(rfqId), String(partyId), String(via));
  }, P);
}
export async function addRfqSuppliersAction(id: string, input: unknown) {
  return runAction(async (a) => addRfqSuppliers(a, String(id), input), P);
}
export async function recordQuotationAction(input: unknown) {
  return runAction(async (a) => ({ id: (await recordQuotation(a, input)).id }), P);
}
export async function proposeAwardAction(rfqId: string, input: unknown) {
  return runAction(async (a) => {
    await proposeAward(a, String(rfqId), input);
  }, P);
}
export async function convertQuotationToPoAction(input: unknown) {
  return runAction(async (a) => convertQuotationToPo(a, input), P);
}
export async function createPosFromAwardAction(rfqId: string) {
  return runAction(async (a) => createPosFromAward(a, String(rfqId)), P);
}

// Purchase orders
/** `finalize: true` = "Save & finalize PO" in one click (the draft is kept if finalizing fails). */
async function finalizeAfterSave(a: Parameters<typeof poAction>[0], id: string) {
  const { version } = await db.purchaseOrder.findUniqueOrThrow({ where: { id }, select: { version: true } });
  try {
    await poAction(a, id, "finalize", { version });
    return { finalized: true, finalizeError: null as string | null };
  } catch (e) {
    return { finalized: false, finalizeError: e instanceof Error ? e.message : "Could not finalize the PO." };
  }
}
export async function createPoAction(input: unknown, opts?: { finalize?: boolean }) {
  return runAction(async (a) => {
    const id = (await createPo(a, input)).id;
    return { id, ...(opts?.finalize ? await finalizeAfterSave(a, id) : { finalized: false, finalizeError: null }) };
  }, P);
}
export async function updatePoAction(id: string, version: number, input: unknown, opts?: { finalize?: boolean }) {
  return runAction(async (a) => {
    await updatePo(a, String(id), Number(version), input);
    return { id, ...(opts?.finalize ? await finalizeAfterSave(a, String(id)) : { finalized: false, finalizeError: null }) };
  }, P);
}
export async function poActionAction(id: string, action: PoAction, opts: Opts) {
  return runAction(async (a) => {
    const r = await poAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null, via: opts.via ?? null });
    return r ?? null;
  }, P);
}
