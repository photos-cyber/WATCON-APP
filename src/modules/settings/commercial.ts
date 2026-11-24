import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { DOC_TYPES, DOC_TYPE_KEYS, type DocType } from "@/lib/doc-numbering";
import { ValidationError } from "@/lib/errors";
import { GSTIN_RE, GST_STATES, PAN_RE, gstinChecksumValid } from "@/lib/gst";
import { EDITABLE_ROLE_KEYS, ROLE_LABELS, type Actor } from "@/lib/permissions/definitions";
import { getCommercialSettings, parseInput, requirePermission } from "@/modules/commercial/core";

const pct = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim() || "0")
  .pipe(z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "0–99.99 %"));

const settingsSchema = z
  .object({
    gstin: z.string().trim().toUpperCase().optional().nullable().transform((v) => (v ? v : null)),
    pan: z.string().trim().toUpperCase().optional().nullable().transform((v) => (v ? v : null)),
    stateCode: z.string().trim().optional().nullable().transform((v) => (v ? v : null)).refine((v) => v === null || v in GST_STATES, "Choose a valid state."),
    enforceSegregation: z.boolean(),
    allowReceiptOnUnapprovedPo: z.boolean(),
    billMatchMode: z.enum(["TWO_WAY", "THREE_WAY"]),
    receiptTolerancePct: pct,
    rateTolerancePct: pct,
    poTerms: z.string().trim().max(5000).optional().nullable().transform((v) => (v ? v : null)),
    advanceDocument: z.enum(["PROFORMA", "TAX_INVOICE"]).optional().default("PROFORMA"),
  })
  .superRefine((v, ctx) => {
    if (v.gstin && (!GSTIN_RE.test(v.gstin) || !gstinChecksumValid(v.gstin))) ctx.addIssue({ code: "custom", path: ["gstin"], message: "Enter a valid GSTIN." });
    if (v.gstin && v.stateCode && v.gstin.slice(0, 2) !== v.stateCode) ctx.addIssue({ code: "custom", path: ["stateCode"], message: "State must match the GSTIN." });
    if (v.pan && !PAN_RE.test(v.pan)) ctx.addIssue({ code: "custom", path: ["pan"], message: "PAN format is AAAAA9999A." });
  });

export async function getCommercialAdmin(actor: Actor) {
  requirePermission(actor, "settings.commercial");
  const [settings, series, limits] = await Promise.all([
    getCommercialSettings(actor.organizationId),
    db.documentSeries.findMany({ where: { organizationId: actor.organizationId } }),
    db.approvalLimit.findMany({ where: { organizationId: actor.organizationId } }),
  ]);
  return {
    settings,
    series: DOC_TYPE_KEYS.map((t) => {
      const s = series.find((x) => x.docType === t);
      return { docType: t, label: DOC_TYPES[t].label, prefix: s?.prefix ?? DOC_TYPES[t].prefix, width: s?.width ?? 4, includeFiscalYear: s?.includeFiscalYear ?? true };
    }),
    limits: limits.map((l) => ({ roleKey: l.roleKey, docType: l.docType, maxAmount: l.maxAmount.toFixed(2) })),
    roles: EDITABLE_ROLE_KEYS.map((k) => ({ key: k, label: ROLE_LABELS[k] })),
    approvalDocTypes: (["PR", "PO", "SB", "PAY", "CPO", "SO", "RAB", "INV"] as DocType[]).map((t) => ({ key: t, label: DOC_TYPES[t].label })),
  };
}

export async function updateCommercialSettings(actor: Actor, input: unknown) {
  requirePermission(actor, "settings.commercial");
  const data = parseInput(settingsSchema, input);
  const resolved = { ...data, stateCode: data.stateCode ?? (data.gstin ? data.gstin.slice(0, 2) : null), pan: data.pan ?? (data.gstin ? data.gstin.slice(2, 12) : null) };
  await db.$transaction(async (tx) => {
    await tx.orgSettings.upsert({ where: { organizationId: actor.organizationId }, create: { organizationId: actor.organizationId, ...resolved }, update: resolved });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "settings.commercial_updated", entityType: "settings", summary: "Updated commercial settings", metadata: resolved }, tx);
  });
}

const seriesSchema = z.object({
  docType: z.enum(DOC_TYPE_KEYS as [DocType, ...DocType[]]),
  prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/, "1–12 letters, digits or hyphens."),
  width: z.coerce.number().int().min(3).max(8),
  includeFiscalYear: z.boolean(),
});

export async function updateSeries(actor: Actor, input: unknown) {
  requirePermission(actor, "settings.commercial");
  const data = parseInput(seriesSchema, input);
  const clash = await db.documentSeries.findFirst({ where: { organizationId: actor.organizationId, prefix: data.prefix, docType: { not: data.docType } } });
  const defaultClash = DOC_TYPE_KEYS.some((t) => t !== data.docType && DOC_TYPES[t].prefix === data.prefix && !clash);
  if (clash || defaultClash) throw new ValidationError("Another document type already uses this prefix.", { prefix: "Prefix already in use." });
  await db.$transaction(async (tx) => {
    await tx.documentSeries.upsert({ where: { organizationId_docType: { organizationId: actor.organizationId, docType: data.docType } }, create: { organizationId: actor.organizationId, ...data }, update: data });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "settings.series_updated", entityType: "settings", summary: `Numbering for ${DOC_TYPES[data.docType].label}: ${data.prefix}${data.includeFiscalYear ? "/FY" : ""}/${"0".repeat(data.width)}` }, tx);
  });
}

const limitSchema = z.object({
  roleKey: z.enum(EDITABLE_ROLE_KEYS as [string, ...string[]]),
  docType: z.enum(DOC_TYPE_KEYS as [DocType, ...DocType[]]),
  maxAmount: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.union([z.literal(""), z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, "Enter an amount.")])),
});

/** Empty amount removes the ceiling (unlimited for holders of the approve permission). */
export async function setApprovalLimit(actor: Actor, input: unknown) {
  requirePermission(actor, "settings.commercial");
  const data = parseInput(limitSchema, input);
  const roleKey = data.roleKey as (typeof EDITABLE_ROLE_KEYS)[number];
  const where = { organizationId_roleKey_docType: { organizationId: actor.organizationId, roleKey, docType: data.docType } };
  await db.$transaction(async (tx) => {
    if (data.maxAmount === "") await tx.approvalLimit.deleteMany({ where: { organizationId: actor.organizationId, roleKey, docType: data.docType } });
    else await tx.approvalLimit.upsert({ where, create: { organizationId: actor.organizationId, roleKey, docType: data.docType, maxAmount: data.maxAmount }, update: { maxAmount: data.maxAmount } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "settings.approval_limit", entityType: "settings", summary: `${ROLE_LABELS[roleKey]} approval limit for ${DOC_TYPES[data.docType].label}: ${data.maxAmount === "" ? "no limit" : `₹${data.maxAmount}`}` }, tx);
  });
}
