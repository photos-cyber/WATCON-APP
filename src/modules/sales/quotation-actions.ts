"use server";

import { runAction } from "@/lib/actions";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { milestonesSchema } from "@/modules/commercial/payment-terms";
import { parseInput } from "@/modules/commercial/core";
import { z } from "zod";
import { createMilestoneInvoice, markMilestoneAchieved, setSoMilestones } from "./milestone-billing";
import { convertToSalesOrder, createQuotation, duplicateQuotation, emailQuotation, quotationAction, recordAcceptance, updateQuotation, type QuotationAction } from "./quotation";

const P = ["/quotations", "/sales-orders", "/client-invoices", "/projects", "/approvals", "/dashboard"];

export async function createQuotationAction(input: unknown) {
  return runAction(async (a) => ({ id: (await createQuotation(a, input)).id }), P);
}
export async function updateQuotationAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await updateQuotation(a, String(id), Number(version), input);
    return { id };
  }, P);
}
export async function duplicateQuotationAction(id: string) {
  return runAction(async (a) => ({ id: (await duplicateQuotation(a, String(id))).id }), P);
}
export async function quotationActionAction(id: string, action: QuotationAction, opts: { version: number; note?: string | null; via?: string | null }) {
  return runAction(async (a) => {
    await quotationAction(a, String(id), action, { version: Number(opts.version), note: opts.note ?? null, via: opts.via ?? null });
  }, P);
}
export async function recordAcceptanceAction(id: string, version: number, input: unknown) {
  return runAction(async (a) => {
    await recordAcceptance(a, String(id), Number(version), input);
  }, P);
}
export async function convertQuotationAction(id: string) {
  return runAction(async (a) => convertToSalesOrder(a, String(id)), P);
}
export async function emailQuotationAction(id: string, input: unknown) {
  return runAction(async (a) => emailQuotation(a, String(id), input), P);
}

// Sales-order payment schedule & milestone billing
export async function setSoMilestonesAction(soId: string, input: unknown) {
  return runAction(async (a) => {
    await setSoMilestones(a, String(soId), input);
  }, P);
}
export async function markMilestoneAchievedAction(milestoneId: string, note: string | null) {
  return runAction(async (a) => {
    await markMilestoneAchieved(a, String(milestoneId), note ? String(note) : null);
  }, P);
}
export async function createMilestoneInvoiceAction(input: unknown) {
  return runAction(async (a) => createMilestoneInvoice(a, input), P);
}

// Reusable payment templates (organisation-wide)
const templateSchema = z.object({ name: z.string().trim().min(2, "Name the template.").max(80), milestones: milestonesSchema.min(1) });
export async function savePaymentTemplateAction(input: unknown) {
  return runAction(async (a) => {
    if (!a.permissions.includes("so.manage") && a.role !== "SUPER_ADMIN") throw new ValidationError("You cannot save templates.");
    const data = parseInput(templateSchema, input);
    const t = await db.paymentTermTemplate.upsert({ where: { organizationId_name: { organizationId: a.organizationId, name: data.name } }, create: { organizationId: a.organizationId, name: data.name, milestones: data.milestones }, update: { milestones: data.milestones } });
    return { id: t.id, name: t.name };
  }, P);
}
