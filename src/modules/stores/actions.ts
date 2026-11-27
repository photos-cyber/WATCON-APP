"use server";

import { runAction } from "@/lib/actions";
import { issueMaterialToSite } from "./site-issue";
import { challanAction, createChallan } from "./challan";
import { createGrn, grnAction, postGrn, updateGrn } from "./grn";

const P = ["/site-receipts", "/challans", "/purchase-orders", "/stock", "/material-planning", "/projects", "/approvals", "/dashboard"];

export async function createGrnAction(input: unknown) {
  return runAction(async (a) => createGrn(a, input), P);
}
export async function updateGrnAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await updateGrn(a, String(id), Number(version), input);
    return { id };
  }, P);
}
export async function postGrnAction(id: string, version: number) {
  return runAction(async (a) => {
    await postGrn(a, String(id), Number(version));
  }, P);
}
export async function grnActionAction(id: string, action: "submit" | "reject" | "cancel" | "reverse", opts: { version: number; note?: string | null }) {
  return runAction(async (a) => {
    await grnAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null });
  }, P);
}
export async function createChallanAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createChallan(a, input)).id }), P);
}
export async function challanActionAction(id: string, action: "dispatch" | "deliver" | "cancel" | "close_discrepancy", opts: { version: number; note?: string | null; resolution?: "RETURN" | "WRITE_OFF"; deliveredDate?: string | null; receiverName?: string | null }) {
  return runAction(async (a) => {
    await challanAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null, resolution: opts.resolution, deliveredDate: opts.deliveredDate ?? null, receiverName: opts.receiverName ?? null });
  }, P);
}

export async function issueMaterialToSiteAction(input: unknown) {
  return runAction(async (a) => issueMaterialToSite(a, input), ["/challans", "/site-receipts", "/stock", "/projects", "/material-planning"]);
}
