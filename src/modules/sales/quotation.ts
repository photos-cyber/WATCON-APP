import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { sendMailReported } from "@/lib/mail";
import { formatINR, taxModeFor } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { approvalHint, assertCanApprove, assertProjectUsable, dec2, dec3, dec4, getCommercialSettings, parseInput, projectRequiredScoped, requirePermission, transition } from "@/modules/commercial/core";
import { computeMilestones, milestonesSchema, validateSchedule, type MilestoneInput } from "@/modules/commercial/payment-terms";
import { gstRateField, optPct, projectIdField, qtyField, rateField } from "@/modules/commercial/pricing";
import { priceDocument } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { todayString } from "@/modules/inventory/serialize";
import { createSalesOrderTx } from "./sales-order";
import { loadClient, optDate } from "./shared";

/**
 * Client quotations.
 *   DRAFT → PENDING_APPROVAL → APPROVED → SENT → ACCEPTED → CONVERTED (sales order)
 *                     ↘ back to DRAFT (approval rejected)      ↘ REJECTED (by client)
 *   APPROVED / SENT / REJECTED can be revised: the current version is snapshotted, revision + 1,
 *   back to DRAFT. "Viewed" and "Expired" are derived (viewedAt, validUntil).
 * Acceptance is either verified by the client (secure link + one-time code emailed to the client's
 * address on file) or recorded by staff with a note (and evidence attached). Both keep IP / time /
 * revision and a frozen snapshot of exactly what was accepted. Conversion to a sales order is
 * idempotent (row lock + unique converted_so_id) and uses the accepted values.
 */

const lineSchema = z.object({
  itemBrandId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  description: text("Description", 500, 1),
  brand: optionalText("Brand", 120),
  hsnSac: optionalText("HSN/SAC", 10),
  unit: text("Unit", 20, 1),
  quantity: qtyField,
  rate: rateField,
  discountPct: optPct,
  gstRate: gstRateField,
});

export const quotationSchema = z.object({
  projectId: projectIdField,
  partyId: uuid,
  subject: optionalText("Subject", 200),
  quoteDate: dateString,
  validUntil: optDate,
  deliveryTerms: optionalText("Delivery terms", 1000),
  paymentTermsText: optionalText("Additional payment terms", 1000),
  terms: optionalText("Terms & conditions", 5000),
  notes: optionalText("Notes", 2000),
  lines: z.array(lineSchema).min(1, "Add at least one item or service.").max(300),
  milestones: milestonesSchema.min(1, "Add at least one payment milestone."),
});
type QuotationData = z.output<typeof quotationSchema>;

const EDITABLE = ["DRAFT"] as const;
const scoped = (actor: Actor) => projectRequiredScoped(actor) as Prisma.ClientQuotationWhereInput;

const include = {
  project: { select: { id: true, code: true, name: true, siteAddress: true } },
  party: { select: { id: true, code: true, name: true, legalName: true, gstin: true, stateCode: true, address: true, city: true, pincode: true, phone: true, email: true, whatsappNumber: true, contactPerson: true } },
  lines: { orderBy: { lineNo: "asc" as const }, include: { itemBrand: { select: { id: true, item: { select: { code: true, name: true } }, brand: { select: { name: true } } } } } },
  milestones: { orderBy: { sortOrder: "asc" as const } },
  revisions: { orderBy: { revision: "desc" as const } },
  createdBy: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  convertedSo: { select: { id: true, number: true, status: true } },
} satisfies Prisma.ClientQuotationInclude;

async function loadScoped(actor: Actor, id: string, client: Tx | typeof db = db) {
  const q = await client.clientQuotation.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: { lines: true, milestones: { orderBy: { sortOrder: "asc" } } } });
  if (!q) throw new NotFoundError("Quotation");
  return q;
}

/** Validates, prices and builds the schedule. Totals and milestone amounts are computed server-side. */
async function build(tx: Tx, actor: Actor, data: QuotationData) {
  const party = await loadClient(tx, actor, data.partyId);
  const settings = await getCommercialSettings(actor.organizationId, tx);
  if (!party.stateCode) throw new ValidationError(`Set the state on ${party.name} first — it decides CGST + SGST or IGST.`, { partyId: "Client has no state." });
  const mode = taxModeFor(settings.stateCode, party.stateCode);
  const ibIds = data.lines.flatMap((l) => (l.itemBrandId ? [l.itemBrandId] : []));
  if (ibIds.length) {
    const found = await tx.itemBrand.count({ where: { id: { in: ibIds }, organizationId: actor.organizationId } });
    if (found !== new Set(ibIds).size) throw new ValidationError("An item no longer exists.");
  }
  const priced = priceDocument(data.lines, mode, { roundToRupee: true });
  const t = priced.totals;
  const errors = validateSchedule(t.total, data.milestones as MilestoneInput[]);
  if (errors.length) throw new ValidationError(errors[0]!, { milestones: errors.join(" ") });
  const schedule = computeMilestones(t.total, data.milestones as MilestoneInput[]);
  if (data.validUntil && data.validUntil < data.quoteDate) throw new ValidationError("Valid-until must be on or after the quotation date.", { validUntil: "Before the quotation date." });
  return {
    party,
    header: {
      projectId: data.projectId,
      partyId: data.partyId,
      subject: data.subject,
      quoteDate: toDbDate(data.quoteDate)!,
      validUntil: toDbDate(data.validUntil),
      deliveryTerms: data.deliveryTerms,
      paymentTermsText: data.paymentTermsText,
      terms: data.terms,
      notes: data.notes,
      taxMode: mode,
      placeOfSupply: party.stateCode,
      taxable: t.taxable,
      taxAmount: t.tax,
      roundOff: t.roundOff,
      total: t.total,
    },
    lines: priced.lines.map((l, i) => ({ lineNo: i + 1, itemBrandId: l.itemBrandId, description: l.description, brand: l.brand, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax, total: l.amounts.total })),
    milestones: schedule.rows.map((m, i) => ({ organizationId: actor.organizationId, sortOrder: i, label: m.label, basis: m.basis, percent: m.percent, amount: m.amount, trigger: m.trigger, dueDate: toDbDate(m.dueDate ?? null), days: m.days ?? null, note: m.note ?? null })),
  };
}

export async function createQuotation(actor: Actor, input: unknown) {
  requirePermission(actor, "so.manage");
  const data = parseInput(quotationSchema, input);
  const project = await assertProjectUsable(actor, data.projectId);
  return db.$transaction(async (tx) => {
    const { header, lines, milestones, party } = await build(tx, actor, data);
    const number = await nextDocNumber(tx, actor.organizationId, "QT", header.quoteDate);
    const q = await tx.clientQuotation.create({ data: { organizationId: actor.organizationId, number, ...header, createdById: actor.id, lines: { create: lines }, milestones: { create: milestones } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "quotation.created", entityType: "client_quotation", entityId: q.id, projectId: q.projectId, summary: `Created quotation ${number} for ${party.name} (${project.code}) – ${formatINR(header.total)}` }, tx);
    return q;
  });
}

export async function updateQuotation(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "so.manage");
  const data = parseInput(quotationSchema, input);
  const before = await loadScoped(actor, id);
  if (!(EDITABLE as readonly string[]).includes(before.status)) throw new ValidationError("Only draft quotations can be edited. Use “Revise” to change a sent quotation.");
  if (data.projectId !== before.projectId) throw new ValidationError("A quotation cannot move to another project.", { projectId: "Cannot change." });
  return db.$transaction(async (tx) => {
    const { header, lines, milestones } = await build(tx, actor, data);
    await transition(tx.clientQuotation, { id, organizationId: actor.organizationId, version }, EDITABLE, { ...header, statusNote: null }, "quotation");
    await tx.clientQuotationLine.deleteMany({ where: { quotationId: id } });
    await tx.clientQuotationLine.createMany({ data: lines.map((l) => ({ ...l, quotationId: id })) });
    await tx.paymentMilestone.deleteMany({ where: { quotationId: id } });
    await tx.paymentMilestone.createMany({ data: milestones.map((m) => ({ ...m, quotationId: id })) });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "quotation.updated", entityType: "client_quotation", entityId: id, projectId: before.projectId, summary: `Edited quotation ${before.number} – ${formatINR(header.total)}` }, tx);
  });
}

/** New draft with the same content (new number, today's date). */
export async function duplicateQuotation(actor: Actor, id: string) {
  requirePermission(actor, "so.manage");
  const q = await loadScoped(actor, id);
  return createQuotation(actor, { ...formValues(q), quoteDate: todayString(), validUntil: null });
}

/** Values in the shape of `quotationSchema` (used for edit forms and duplication). */
export function formValues(q: Awaited<ReturnType<typeof loadScoped>>) {
  return {
    projectId: q.projectId,
    partyId: q.partyId,
    subject: q.subject,
    quoteDate: q.quoteDate.toISOString().slice(0, 10),
    validUntil: q.validUntil?.toISOString().slice(0, 10) ?? null,
    deliveryTerms: q.deliveryTerms,
    paymentTermsText: q.paymentTermsText,
    terms: q.terms,
    notes: q.notes,
    lines: q.lines.sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ itemBrandId: l.itemBrandId, description: l.description, brand: l.brand, hsnSac: l.hsnSac, unit: l.unit, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate) })),
    milestones: q.milestones.map((m) => ({ label: m.label, basis: m.basis as "PERCENT" | "AMOUNT", value: m.basis === "AMOUNT" ? dec2(m.amount) : (m.percent?.toFixed(4).replace(/\.?0+$/, "") ?? "0"), trigger: m.trigger as MilestoneInput["trigger"], dueDate: m.dueDate?.toISOString().slice(0, 10) ?? null, days: m.days, note: m.note })),
  };
}

function snapshotOf(q: Awaited<ReturnType<typeof loadScoped>>) {
  return {
    number: q.number,
    revision: q.revision,
    quoteDate: q.quoteDate.toISOString().slice(0, 10),
    validUntil: q.validUntil?.toISOString().slice(0, 10) ?? null,
    taxMode: q.taxMode,
    taxable: dec2(q.taxable),
    taxAmount: dec2(q.taxAmount),
    roundOff: dec2(q.roundOff),
    total: dec2(q.total),
    deliveryTerms: q.deliveryTerms,
    paymentTermsText: q.paymentTermsText,
    terms: q.terms,
    lines: q.lines.sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ lineNo: l.lineNo, itemBrandId: l.itemBrandId, description: l.description, brand: l.brand, hsnSac: l.hsnSac, unit: l.unit, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), taxable: dec2(l.taxable), taxAmount: dec2(l.taxAmount), total: dec2(l.total) })),
    milestones: q.milestones.map((m) => ({ label: m.label, basis: m.basis, percent: m.percent?.toFixed(4).replace(/\.?0+$/, "") ?? null, amount: dec2(m.amount), trigger: m.trigger, dueDate: m.dueDate?.toISOString().slice(0, 10) ?? null, days: m.days, note: m.note })),
  };
}
export type QuotationSnapshot = ReturnType<typeof snapshotOf>;

// ─────────────────────────── Workflow ───────────────────────────

export type QuotationAction = "submit" | "approve" | "reject_approval" | "mark_sent" | "revise" | "cancel" | "client_rejected";

export async function quotationAction(actor: Actor, id: string, action: QuotationAction, opts: { version: number; note?: string | null; via?: string | null }) {
  const q = await loadScoped(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string, extra = "") => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `quotation.${action}`, entityType: "client_quotation", entityId: id, projectId: q.projectId, summary: `${verb} quotation ${q.number}${q.revision ? ` (rev ${q.revision})` : ""}${extra}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const need = (v: string | null | undefined, msg: string) => {
    if (!v?.trim()) throw new ValidationError(msg, { note: "Required." });
  };
  switch (action) {
    case "submit":
      requirePermission(actor, "so.manage");
      return db.$transaction(async (tx) => {
        await transition(tx.clientQuotation, w, EDITABLE, { status: "PENDING_APPROVAL", submittedById: actor.id, submittedAt: new Date(), statusNote: null }, "quotation");
        await log(tx, "Submitted for approval", ` (${formatINR(dec2(q.total))})`);
      });
    case "approve":
    case "reject_approval":
      await assertCanApprove(actor, { permission: "so.approve", docType: "SO", amount: dec2(q.total), createdById: q.createdById, submittedById: q.submittedById, what: "quotation" });
      if (action === "reject_approval") need(opts.note, "Give a reason so the quotation can be corrected.");
      return db.$transaction(async (tx) => {
        if (action === "approve") await transition(tx.clientQuotation, w, ["PENDING_APPROVAL"], { status: "APPROVED", approvedById: actor.id, approvedAt: new Date(), statusNote: null }, "quotation");
        else await transition(tx.clientQuotation, w, ["PENDING_APPROVAL"], { status: "DRAFT", statusNote: opts.note }, "quotation");
        await log(tx, action === "approve" ? "Approved" : "Returned for correction");
      });
    case "mark_sent":
      requirePermission(actor, "so.manage");
      return db.$transaction(async (tx) => {
        await transition(tx.clientQuotation, w, ["APPROVED", "SENT"], { status: "SENT", sentAt: q.sentAt ?? new Date(), sentVia: opts.via ?? q.sentVia ?? "manual" }, "quotation");
        await log(tx, "Marked as sent to the client", opts.via ? ` via ${opts.via}` : "");
      });
    case "revise":
      requirePermission(actor, "so.manage");
      need(opts.note, "Give a reason for the revision.");
      return db.$transaction(async (tx) => {
        await tx.clientQuotationRevision.create({ data: { quotationId: id, revision: q.revision, snapshot: snapshotOf(q) as Prisma.InputJsonValue, reason: opts.note, createdById: actor.id } });
        await transition(tx.clientQuotation, w, ["APPROVED", "SENT", "REJECTED"], { status: "DRAFT", revision: q.revision + 1, statusNote: null, approvedById: null, approvedAt: null, submittedById: null, submittedAt: null, viewedAt: null, rejectedAt: null, rejectionReason: null, otpHash: null, otpExpiresAt: null, otpAttempts: 0 }, "quotation");
        await log(tx, "Opened revision", ` ${q.revision + 1}`);
      });
    case "client_rejected":
      requirePermission(actor, "so.manage");
      need(opts.note, "Record the client's reason.");
      return db.$transaction(async (tx) => {
        await transition(tx.clientQuotation, w, ["APPROVED", "SENT"], { status: "REJECTED", rejectedAt: new Date(), rejectionReason: opts.note }, "quotation");
        await log(tx, "Recorded client rejection of");
      });
    case "cancel":
      requirePermission(actor, "so.manage");
      need(opts.note, "Give a reason for cancelling.");
      return db.$transaction(async (tx) => {
        await transition(tx.clientQuotation, w, ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "REJECTED"], { status: "CANCELLED", statusNote: opts.note }, "quotation");
        await log(tx, "Cancelled");
      });
  }
}

const acceptSchema = z.object({ acceptedByName: text("Accepted by", 120, 2), acceptedByRole: optionalText("Designation", 120), acceptedByEmail: z.string().trim().email("Enter a valid email.").max(160).optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)), note: text("How was it accepted (e.g. signed copy, email of 12 Nov)", 1000, 5) });

/** Staff record a client's acceptance received outside the link (signed copy, email, PO letter). */
export async function recordAcceptance(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "so.approve", "Recording a client acceptance needs sales-order approval rights.");
  const data = parseInput(acceptSchema, input);
  const q = await loadScoped(actor, id);
  return db.$transaction(async (tx) => {
    await transition(tx.clientQuotation, { id, organizationId: actor.organizationId, version }, ["APPROVED", "SENT"], { status: "ACCEPTED", acceptedAt: new Date(), acceptanceMethod: "RECORDED_BY_STAFF", acceptedByName: data.acceptedByName, acceptedByRole: data.acceptedByRole, acceptedByEmail: data.acceptedByEmail, acceptanceNote: data.note, acceptedRevision: q.revision, acceptedSnapshot: snapshotOf(q) as Prisma.InputJsonValue, otpHash: null }, "quotation");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "quotation.accepted", entityType: "client_quotation", entityId: id, projectId: q.projectId, summary: `Recorded client acceptance of ${q.number} (rev ${q.revision}) by ${data.acceptedByName} – ${data.note}` }, tx);
  });
}

// ─────────────────────────── Conversion ───────────────────────────

/**
 * Accepted quotation → draft sales order with the ACCEPTED values and payment schedule.
 * Idempotent: the quotation row is locked and an existing conversion is returned as-is.
 */
export async function convertToSalesOrder(actor: Actor, id: string) {
  requirePermission(actor, "so.manage");
  const q = await loadScoped(actor, id);
  const project = await assertProjectUsable(actor, q.projectId);
  return db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ status: string; converted_so_id: string | null }[]>`SELECT status::text, converted_so_id::text FROM client_quotations WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked?.converted_so_id) return { soId: locked.converted_so_id, created: false };
    if (locked?.status !== "ACCEPTED") throw new ValidationError("Only an accepted quotation can be converted to a sales order.");
    const snap = (q.acceptedSnapshot ?? snapshotOf(q)) as QuotationSnapshot;
    const so = await createSalesOrderTx(
      tx,
      actor,
      {
        projectId: q.projectId,
        partyId: q.partyId,
        orderDate: todayString(),
        deliveryAddress: project.siteAddress ?? null,
        paymentTerms: snap.milestones.map((m) => `${m.basis === "PERCENT" ? `${m.percent}%` : `₹${m.amount}`} ${m.label}`).join("; ").slice(0, 500) || null,
        billingSchedule: snap.paymentTermsText,
        deliverySchedule: snap.deliveryTerms,
        notes: `From quotation ${q.number}${snap.revision ? ` rev ${snap.revision}` : ""}, accepted ${q.acceptedAt ? formatDate(q.acceptedAt) : ""}.`,
        lines: snap.lines.map((l) => ({ itemBrandId: l.itemBrandId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate })),
      },
      project.code,
      ` (from quotation ${q.number})`,
    );
    // Same schedule, re-based on the order total (identical unless rounding differs).
    const schedule = computeMilestones(so.total.toFixed(2), snap.milestones.map((m) => ({ label: m.label, basis: m.basis === "AMOUNT" ? "AMOUNT" : "PERCENT", value: m.basis === "AMOUNT" ? m.amount : (m.percent ?? "0"), trigger: m.trigger as MilestoneInput["trigger"], dueDate: m.dueDate, days: m.days, note: m.note })));
    await tx.paymentMilestone.createMany({ data: schedule.rows.map((m, i) => ({ organizationId: actor.organizationId, soId: so.id, sortOrder: i, label: m.label, basis: m.basis, percent: m.percent, amount: m.amount, trigger: m.trigger, dueDate: toDbDate(m.dueDate ?? null), days: m.days ?? null, note: m.note ?? null })) });
    await tx.clientQuotation.update({ where: { id }, data: { status: "CONVERTED", convertedSoId: so.id, convertedAt: new Date(), version: { increment: 1 } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "quotation.converted", entityType: "client_quotation", entityId: id, projectId: q.projectId, summary: `Converted quotation ${q.number} into sales order ${so.number}` }, tx);
    return { soId: so.id, created: true };
  });
}

// ─────────────────────────── Sharing ───────────────────────────

export function quotationLink(token: string) {
  return `${env().APP_URL.replace(/\/$/, "")}/client-quote/${token}`;
}

/** Emails the quotation link to the client; reports success only when the mail server accepted it. */
export async function emailQuotation(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "so.manage");
  const data = parseInput(z.object({ to: z.string().trim().email("Enter a valid email."), message: optionalText("Message", 2000) }), input);
  const q = await db.clientQuotation.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: { party: { select: { name: true } }, organization: { select: { name: true, legalName: true } } } });
  if (!q) throw new NotFoundError("Quotation");
  if (!["APPROVED", "SENT"].includes(q.status)) throw new ValidationError("Only an approved quotation can be sent to the client.");
  const company = q.organization.legalName || q.organization.name;
  const res = await sendMailReported({
    to: data.to,
    subject: `Quotation ${q.number} from ${company}`,
    text: `${data.message ? `${data.message}\n\n` : `Dear ${q.party.name},\n\nPlease find our quotation ${q.number}${q.subject ? ` – ${q.subject}` : ""} for ${formatINR(dec2(q.total))}.\n\n`}View, download and accept it here (secure link${q.validUntil ? `, valid until ${formatDate(q.validUntil)}` : ""}):\n${quotationLink(q.accessToken)}\n\nRegards,\n${company}`,
  });
  if (!res.delivered) return res;
  await db.$transaction(async (tx) => {
    await tx.clientQuotation.update({ where: { id }, data: { status: "SENT", sentAt: q.sentAt ?? new Date(), sentVia: "email", version: { increment: 1 } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "quotation.emailed", entityType: "client_quotation", entityId: id, projectId: q.projectId, summary: `Emailed quotation ${q.number} to ${data.to} (accepted by the mail server)` }, tx);
  });
  return res;
}

// ─────────────────────────── Client link (public) ───────────────────────────

const tokenOk = (t: string) => /^[a-f0-9]{64}$/.test(t);
const hashCode = (code: string, salt: string) => createHash("sha256").update(`${salt}:${code}`).digest("hex");
const maskEmail = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, c: string) => `${a}${"•".repeat(Math.min(b.length, 6))}${c}`);
const isExpired = (q: { validUntil: Date | null }) => !!q.validUntil && q.validUntil.toISOString().slice(0, 10) < todayString();

async function findByToken(token: string) {
  if (!tokenOk(token)) return null;
  return db.clientQuotation.findUnique({ where: { accessToken: token }, include: { ...include, revisions: false, organization: { select: { name: true, legalName: true, address: true, phone: true, email: true } } } });
}

export async function getPublicQuotation(token: string) {
  const q = await findByToken(token);
  if (!q || ["DRAFT", "PENDING_APPROVAL", "CANCELLED"].includes(q.status)) return null;
  if (!q.viewedAt && q.status === "SENT") await db.clientQuotation.update({ where: { id: q.id }, data: { viewedAt: new Date() } });
  return {
    q,
    expired: isExpired(q),
    canRespond: ["APPROVED", "SENT"].includes(q.status) && !isExpired(q),
    emailOnFile: q.party.email ? maskEmail(q.party.email) : null,
  };
}

/** Sends a 6-digit code to the client's email ON FILE (never an address typed on the page). */
export async function requestAcceptanceCode(token: string) {
  const q = await findByToken(token);
  if (!q || !["APPROVED", "SENT"].includes(q.status) || isExpired(q)) throw new ValidationError("This quotation can no longer be accepted online.");
  if (!q.party.email) throw new ValidationError("We have no email address on file for your company. Please confirm acceptance with our team directly.");
  if (q.otpExpiresAt && q.otpExpiresAt.getTime() - 14 * 60_000 > Date.now()) throw new ValidationError("A code was sent less than a minute ago. Please check your inbox.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.clientQuotation.update({ where: { id: q.id }, data: { otpHash: hashCode(code, q.id), otpExpiresAt: new Date(Date.now() + 15 * 60_000), otpAttempts: 0 } });
  const company = q.organization.legalName || q.organization.name;
  const res = await sendMailReported({ to: q.party.email, subject: `Your code to accept quotation ${q.number}`, text: `Your one-time code to accept quotation ${q.number} from ${company} is: ${code}\n\nIt is valid for 15 minutes. If you did not request it, ignore this email.` });
  if (!res.delivered) throw new ValidationError("We could not send the verification email right now. Please confirm acceptance with our team directly.");
  return { sentTo: maskEmail(q.party.email) };
}

const publicAcceptSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code."), name: text("Your name", 120, 2), role: optionalText("Designation", 120), note: optionalText("Remarks", 1000) });

export async function acceptViaLink(token: string, input: unknown, meta: { ip: string | null; userAgent: string | null }) {
  const data = parseInput(publicAcceptSchema, input);
  const q0 = await findByToken(token);
  if (!q0) throw new NotFoundError("Quotation");
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM client_quotations WHERE id = ${q0.id}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundError("Quotation");
    const q = await tx.clientQuotation.findUniqueOrThrow({ where: { id: q0.id }, include: { lines: true, milestones: { orderBy: { sortOrder: "asc" } }, party: { select: { email: true, name: true } } } });
    if (!["APPROVED", "SENT"].includes(q.status) || isExpired(q)) throw new ValidationError("This quotation can no longer be accepted online.");
    if (!q.otpHash || !q.otpExpiresAt || q.otpExpiresAt < new Date()) throw new ValidationError("The code has expired. Request a new one.");
    if (q.otpAttempts >= 5) throw new ValidationError("Too many wrong attempts. Request a new code.");
    const ok = timingSafeEqual(Buffer.from(hashCode(data.code, q.id)), Buffer.from(q.otpHash));
    if (!ok) {
      await tx.clientQuotation.update({ where: { id: q.id }, data: { otpAttempts: { increment: 1 } } });
      throw new ConflictError("That code is not correct.");
    }
    await tx.clientQuotation.update({
      where: { id: q.id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptanceMethod: "CLIENT_LINK_OTP", acceptedByName: data.name, acceptedByRole: data.role, acceptedByEmail: q.party.email, acceptanceNote: data.note, acceptedIp: meta.ip?.slice(0, 64) ?? null, acceptedAgent: meta.userAgent?.slice(0, 300) ?? null, acceptedRevision: q.revision, acceptedSnapshot: snapshotOf(q) as Prisma.InputJsonValue, otpHash: null, otpExpiresAt: null, version: { increment: 1 } },
    });
    await writeAudit({ organizationId: q.organizationId, actorId: null, action: "quotation.accepted", entityType: "client_quotation", entityId: q.id, projectId: q.projectId, summary: `Client accepted ${q.number} (rev ${q.revision}) online — ${data.name}${data.role ? `, ${data.role}` : ""}; verified by code sent to ${q.party.email}; IP ${meta.ip ?? "unknown"}` }, tx);
    await notifyOwner(tx, q, `${q.party.name} accepted quotation ${q.number}`);
    return { accepted: true };
  });
}

export async function rejectViaLink(token: string, input: unknown, meta: { ip: string | null }) {
  const data = parseInput(z.object({ name: text("Your name", 120, 2), reason: text("Reason", 1000, 3) }), input);
  const q = await findByToken(token);
  if (!q || !["APPROVED", "SENT"].includes(q.status)) throw new ValidationError("This quotation can no longer be answered online.");
  await db.$transaction(async (tx) => {
    await tx.clientQuotation.update({ where: { id: q.id }, data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: `${data.reason} — ${data.name}`, version: { increment: 1 } } });
    await writeAudit({ organizationId: q.organizationId, actorId: null, action: "quotation.client_rejected", entityType: "client_quotation", entityId: q.id, projectId: q.projectId, summary: `Client declined ${q.number} online — ${data.name}: ${data.reason} (IP ${meta.ip ?? "unknown"})` }, tx);
    await notifyOwner(tx, q, `${q.party.name} declined quotation ${q.number}`);
  });
}

async function notifyOwner(tx: Tx, q: { id: string; createdById: string; number: string }, title: string) {
  await tx.notification.create({ data: { userId: q.createdById, type: "quotation", title, link: `/quotations/${q.id}` } });
}

// ─────────────────────────── Read ───────────────────────────

export type DisplayStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "SENT" | "VIEWED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CONVERTED" | "CANCELLED";

export function displayStatus(q: { status: string; viewedAt: Date | null; validUntil: Date | null }): DisplayStatus {
  if (["APPROVED", "SENT"].includes(q.status) && isExpired(q)) return "EXPIRED";
  if (q.status === "SENT" && q.viewedAt) return "VIEWED";
  return q.status as DisplayStatus;
}

export async function getQuotation(actor: Actor, id: string) {
  requirePermission(actor, "so.view");
  const q = await db.clientQuotation.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include });
  if (!q) throw new NotFoundError("Quotation");
  const settings = await getCommercialSettings(actor.organizationId);
  const hint = approvalHint(actor, "so.approve", q, settings.enforceSegregation);
  const manage = can(actor, "so.manage");
  const expired = isExpired(q);
  return {
    q: {
      ...q,
      taxable: dec2(q.taxable),
      taxAmount: dec2(q.taxAmount),
      roundOff: dec2(q.roundOff),
      total: dec2(q.total),
      lines: q.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), taxable: dec2(l.taxable), taxAmount: dec2(l.taxAmount), total: dec2(l.total) })),
      milestones: q.milestones.map((m) => ({ ...m, percent: m.percent?.toFixed(4).replace(/\.?0+$/, "") ?? null, amount: dec2(m.amount), dueDate: m.dueDate?.toISOString().slice(0, 10) ?? null })),
    },
    displayStatus: displayStatus(q),
    expired,
    link: manage ? quotationLink(q.accessToken) : null,
    can: {
      edit: manage && q.status === "DRAFT",
      submit: manage && q.status === "DRAFT",
      approve: q.status === "PENDING_APPROVAL" && hint.canApprove,
      approveBlockedReason: q.status === "PENDING_APPROVAL" ? hint.reason : null,
      share: manage && ["APPROVED", "SENT"].includes(q.status),
      markSent: manage && q.status === "APPROVED",
      revise: manage && ["APPROVED", "SENT", "REJECTED"].includes(q.status),
      recordAcceptance: can(actor, "so.approve") && ["APPROVED", "SENT"].includes(q.status),
      recordRejection: manage && ["APPROVED", "SENT"].includes(q.status),
      convert: manage && q.status === "ACCEPTED",
      duplicate: manage,
      cancel: manage && ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "REJECTED"].includes(q.status),
    },
  };
}

const listSchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: z.string().uuid().optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).catch(20).default(20),
});

export async function listQuotations(actor: Actor, raw: unknown) {
  requirePermission(actor, "so.view");
  const p = listSchema.parse(raw ?? {});
  const today = toDbDate(todayString())!;
  const and: Prisma.ClientQuotationWhereInput[] = [scoped(actor)];
  if (p.projectId) and.push({ projectId: p.projectId });
  if (p.q) and.push({ OR: [{ number: { contains: p.q, mode: "insensitive" } }, { subject: { contains: p.q, mode: "insensitive" } }, { party: { name: { contains: p.q, mode: "insensitive" } } }] });
  const open: Prisma.ClientQuotationWhereInput = { status: { in: ["APPROVED", "SENT"] } };
  switch (p.status) {
    case "EXPIRED":
      and.push({ ...open, validUntil: { lt: today } });
      break;
    case "VIEWED":
      and.push({ status: "SENT", viewedAt: { not: null }, OR: [{ validUntil: null }, { validUntil: { gte: today } }] });
      break;
    case "SENT":
      and.push({ status: "SENT", viewedAt: null, OR: [{ validUntil: null }, { validUntil: { gte: today } }] });
      break;
    case undefined:
    case "":
    case "ALL":
      break;
    default:
      and.push({ status: p.status as never });
  }
  const where = { AND: and };
  const [rows, total, counts] = await Promise.all([
    db.clientQuotation.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p.page - 1) * p.pageSize, take: p.pageSize, include: { party: { select: { name: true } }, project: { select: { id: true, code: true } } } }),
    db.clientQuotation.count({ where }),
    db.clientQuotation.groupBy({ by: ["status"], where: { AND: [scoped(actor), ...(p.projectId ? [{ projectId: p.projectId }] : [])] }, _count: { _all: true } }),
  ]);
  return {
    rows: rows.map((r) => ({ id: r.id, number: r.number, revision: r.revision, subject: r.subject, party: r.party.name, project: r.project, quoteDate: r.quoteDate.toISOString(), validUntil: r.validUntil?.toISOString() ?? null, total: dec2(r.total), status: displayStatus(r) })),
    total,
    page: p.page,
    pageSize: p.pageSize,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Record<string, number>,
  };
}

export async function quotationAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "so.view")) return null;
  const r = await db.clientQuotation.findFirst({ where: { AND: [{ id }, scoped(actor)] }, select: { number: true, projectId: true, status: true } });
  if (!r) return null;
  return { projectId: r.projectId, label: r.number, canView: true, canUpload: can(actor, "so.manage") || can(actor, "so.approve"), locked: ["CONVERTED", "CANCELLED"].includes(r.status) };
}

export { loadScoped as loadQuotationScoped };

/** Organisation payment templates (built-ins live in code). */
export async function listPaymentTemplates(actor: Actor) {
  const rows = await db.paymentTermTemplate.findMany({ where: { organizationId: actor.organizationId }, orderBy: { name: "asc" }, take: 100 });
  return rows.map((r) => ({ id: r.id, name: r.name, milestones: (Array.isArray(r.milestones) ? r.milestones : []) as MilestoneInput[] }));
}
