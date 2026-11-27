import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addMoney, cmpMoney, formatINR, pctOf } from "@/lib/money";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { dec2, isSuperAdmin, parseInput, requireSuperAdmin, projectRequiredScoped, projectScoped, requirePermission, transition } from "@/modules/commercial/core";
import { gstRateField, moneyField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { applyBillSettlement, applyInvoiceSettlement, lockBill, lockInvoice, outstandingOf } from "./settlement";

/**
 * Credit / debit notes. Supplier side (against a supplier bill): a credit note received from the
 * supplier or a debit note we raise on them (e.g. short supply, rate difference, returns) both
 * reduce what we owe. Client side: a credit note against an invoice reduces what the client owes.
 * DRAFT → APPROVED (applied to the document) → CANCELLED (reverses the adjustment).
 */

const optId = z.union([uuid, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

export const noteSchema = z.object({
  noteType: z.enum(["CREDIT", "DEBIT"]),
  partyRole: z.enum(["SUPPLIER", "CLIENT"]),
  supplierBillId: optId,
  clientInvoiceId: optId,
  noteDate: dateString,
  partyNoteRef: optionalText("Party reference", 50),
  reason: text("Reason", 500, 3),
  taxable: moneyField.refine((v) => Number(v) > 0, "Must be greater than zero."),
  gstRate: gstRateField,
});

const perms = (role: "SUPPLIER" | "CLIENT") => (role === "SUPPLIER" ? { view: "bills.view", manage: "bills.manage", approve: "bills.approve" } : { view: "invoice.view", manage: "invoice.manage", approve: "invoice.approve" }) as { view: PermissionKey; manage: PermissionKey; approve: PermissionKey };

function roleScope(actor: Actor): Prisma.AdjustmentNoteWhereInput {
  const roles = (["SUPPLIER", "CLIENT"] as const).filter((r) => can(actor, perms(r).view));
  return { partyRole: { in: roles.length ? [...roles] : ["SUPPLIER"] }, ...(roles.length ? {} : { id: "00000000-0000-0000-0000-000000000000" }) };
}

const scoped = (actor: Actor): Prisma.AdjustmentNoteWhereInput => ({ AND: [projectScoped(actor) as Prisma.AdjustmentNoteWhereInput, roleScope(actor)] });

async function targetOf(tx: Tx | typeof db, actor: Actor, data: { partyRole: "SUPPLIER" | "CLIENT"; supplierBillId: string | null; clientInvoiceId: string | null }) {
  if (data.partyRole === "SUPPLIER") {
    if (!data.supplierBillId) throw new ValidationError("Choose the supplier bill this note adjusts.", { supplierBillId: "Required." });
    const b = await tx.supplierBill.findFirst({ where: { AND: [{ id: data.supplierBillId }, projectScoped(actor) as Prisma.SupplierBillWhereInput] } });
    if (!b) throw new ValidationError("Supplier bill not found.", { supplierBillId: "Not found." });
    return { kind: "bill" as const, id: b.id, number: b.number, partyId: b.partyId, projectId: b.projectId, taxMode: b.taxMode, status: b.status, outstanding: outstandingOf(dec2(b.netPayable), dec2(b.paidAmount), dec2(b.adjustedAmount)), open: ["APPROVED", "PARTIALLY_PAID"].includes(b.status) };
  }
  if (!data.clientInvoiceId) throw new ValidationError("Choose the invoice this note adjusts.", { clientInvoiceId: "Required." });
  const inv = await tx.clientInvoice.findFirst({ where: { AND: [{ id: data.clientInvoiceId }, projectRequiredScoped(actor) as Prisma.ClientInvoiceWhereInput] } });
  if (!inv) throw new ValidationError("Invoice not found.", { clientInvoiceId: "Not found." });
  return { kind: "invoice" as const, id: inv.id, number: inv.number, partyId: inv.partyId, projectId: inv.projectId, taxMode: inv.taxMode, status: inv.status, outstanding: outstandingOf(dec2(inv.netReceivable), dec2(inv.receivedAmount), dec2(inv.adjustedAmount)), open: ["ISSUED", "PARTIALLY_PAID"].includes(inv.status) };
}

export async function createNote(actor: Actor, input: unknown) {
  const data = parseInput(noteSchema, input);
  requirePermission(actor, perms(data.partyRole).manage);
  if (data.partyRole === "CLIENT" && data.noteType === "DEBIT") throw new ValidationError("To charge a client more, raise a supplementary invoice. Client notes here are credit notes.", { noteType: "Use a credit note." });
  const t = await targetOf(db, actor, data);
  if (!t.open) throw new ValidationError(`${t.number} is not open (status ${t.status.replace(/_/g, " ").toLowerCase()}), so it cannot be adjusted.`);
  const taxAmount = pctOf(data.taxable, data.gstRate);
  const total = addMoney(data.taxable, taxAmount);
  if (cmpMoney(total, t.outstanding) > 0) throw new ValidationError(`The note (${formatINR(total)}) is more than the ${formatINR(t.outstanding)} still outstanding on ${t.number}.`, { taxable: "More than outstanding." });
  return db.$transaction(async (tx) => {
    const date = toDbDate(data.noteDate)!;
    const number = await nextDocNumber(tx, actor.organizationId, data.noteType === "CREDIT" ? "CN" : "DN", date);
    const note = await tx.adjustmentNote.create({
      data: { organizationId: actor.organizationId, number, noteType: data.noteType, partyRole: data.partyRole, partyId: t.partyId, projectId: t.projectId, supplierBillId: t.kind === "bill" ? t.id : null, clientInvoiceId: t.kind === "invoice" ? t.id : null, noteDate: date, partyNoteRef: data.partyNoteRef, reason: data.reason, taxMode: t.taxMode, taxable: data.taxable, gstRate: data.gstRate, taxAmount, total, createdById: actor.id },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "note.created", entityType: "adjustment_note", entityId: note.id, projectId: t.projectId, summary: `Drafted ${data.noteType === "CREDIT" ? "credit" : "debit"} note ${number} for ${formatINR(total)} against ${t.number} – ${data.reason}` }, tx);
    return note;
  });
}

async function loadScoped(actor: Actor, id: string) {
  const n = await db.adjustmentNote.findFirst({ where: { AND: [{ id }, scoped(actor)] } });
  if (!n) throw new NotFoundError("Note");
  return n;
}

export async function noteAction(actor: Actor, id: string, action: "approve" | "cancel", opts: { version: number; note?: string | null }) {
  const n = await loadScoped(actor, id);
  const p = perms(n.partyRole);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const total = dec2(n.total);
  const apply = async (tx: Tx, sign: "" | "-") => {
    if (n.supplierBillId) await applyBillSettlement(tx, n.supplierBillId, { adjusted: `${sign}${total}` });
    if (n.clientInvoiceId) await applyInvoiceSettlement(tx, n.clientInvoiceId, { adjusted: `${sign}${total}` });
  };
  const log = (tx: Tx, verb: string) => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `note.${action}`, entityType: "adjustment_note", entityId: id, projectId: n.projectId, summary: `${verb} note ${n.number} (${formatINR(total)})${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  if (action === "approve") {
    // A note corrects a finalized bill / invoice — an amendment, so only the Super Admin applies it.
    requireSuperAdmin(actor, "approve a credit / debit note");
    return db.$transaction(async (tx) => {
      if (n.supplierBillId) {
        const b = await lockBill(tx, n.supplierBillId);
        if (!["APPROVED", "PARTIALLY_PAID"].includes(b.status)) throw new ValidationError(`Bill ${b.number} is no longer open.`);
        if (cmpMoney(total, outstandingOf(dec2(b.netPayable), dec2(b.paidAmount), dec2(b.adjustedAmount))) > 0) throw new ValidationError(`The note is more than what is still outstanding on ${b.number}.`);
      }
      if (n.clientInvoiceId) {
        const inv = await lockInvoice(tx, n.clientInvoiceId);
        if (!["ISSUED", "PARTIALLY_PAID"].includes(inv.status)) throw new ValidationError(`Invoice ${inv.number} is no longer open.`);
        if (cmpMoney(total, outstandingOf(dec2(inv.netReceivable), dec2(inv.receivedAmount), dec2(inv.adjustedAmount))) > 0) throw new ValidationError(`The note is more than what is still outstanding on ${inv.number}.`);
      }
      await transition(tx.adjustmentNote, w, ["DRAFT"], { status: "APPROVED", approvedById: actor.id, approvedAt: new Date() }, "note");
      await apply(tx, "");
      await log(tx, "Approved and applied");
    });
  }
  if (!opts.note?.trim()) throw new ValidationError("Give a reason for cancelling.", { note: "Reason required." });
  if (n.status === "APPROVED") requireSuperAdmin(actor, "cancel an applied credit / debit note");
  else requirePermission(actor, p.manage);
  return db.$transaction(async (tx) => {
    await transition(tx.adjustmentNote, w, ["DRAFT", "APPROVED"], { status: "CANCELLED" }, "note");
    if (n.status === "APPROVED") await apply(tx, "-");
    await log(tx, "Cancelled");
  });
}

// ─────────────────────────── Queries ───────────────────────────

export const noteListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  partyRole: z.enum(["SUPPLIER", "CLIENT"]).optional().catch(undefined),
  status: z.enum(["DRAFT", "APPROVED", "CANCELLED"]).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listNotes(actor: Actor, raw: unknown) {
  if (!can(actor, "bills.view") && !can(actor, "invoice.view")) requirePermission(actor, "bills.view");
  const q = noteListQuerySchema.parse(raw ?? {});
  const where: Prisma.AdjustmentNoteWhereInput = {
    AND: [scoped(actor), q.partyRole ? { partyRole: q.partyRole } : {}, q.status ? { status: q.status } : {}, q.projectId ? { projectId: q.projectId } : {}, q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { reason: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }] } : {}],
  };
  const [total, rows, drafts] = await Promise.all([
    db.adjustmentNote.count({ where }),
    db.adjustmentNote.findMany({ where, orderBy: [{ noteDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { party: { select: { id: true, name: true } }, project: { select: { id: true, code: true } }, supplierBill: { select: { id: true, number: true } }, clientInvoice: { select: { id: true, number: true } } } }),
    db.adjustmentNote.count({ where: { AND: [scoped(actor), { status: "DRAFT" }] } }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, query: q, drafts, rows: rows.map((r) => ({ id: r.id, number: r.number, noteType: r.noteType, partyRole: r.partyRole, noteDate: r.noteDate.toISOString(), reason: r.reason, total: dec2(r.total), status: r.status, party: r.party, project: r.project, against: r.supplierBill ? { href: `/supplier-bills/${r.supplierBill.id}`, number: r.supplierBill.number } : r.clientInvoice ? { href: `/client-invoices/${r.clientInvoice.id}`, number: r.clientInvoice.number } : null })) };
}

export async function getNote(actor: Actor, id: string) {
  const n = await db.adjustmentNote.findFirst({
    where: { AND: [{ id }, scoped(actor)] },
    include: { party: { select: { id: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true } }, project: { select: { id: true, code: true, name: true } }, supplierBill: { select: { id: true, number: true, supplierInvoiceNo: true } }, clientInvoice: { select: { id: true, number: true } }, createdBy: { select: { fullName: true } }, approvedBy: { select: { fullName: true } } },
  });
  if (!n) throw new NotFoundError("Note");
  const p = perms(n.partyRole);
  return {
    note: { ...n, taxable: dec2(n.taxable), gstRate: dec2(n.gstRate), taxAmount: dec2(n.taxAmount), total: dec2(n.total) },
    can: {
      approve: n.status === "DRAFT" && isSuperAdmin(actor),
      approveBlockedReason: n.status === "DRAFT" && !isSuperAdmin(actor) ? "A credit / debit note changes a finalized bill or invoice, so the Super Admin applies it." : null,
      cancel: n.status !== "CANCELLED" && (n.status === "APPROVED" ? isSuperAdmin(actor) : can(actor, p.manage)),
    },
  };
}

export async function noteAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  const n = await db.adjustmentNote.findFirst({ where: { AND: [{ id }, scoped(actor)] }, select: { number: true, projectId: true, status: true, partyRole: true } });
  if (!n) return null;
  return { projectId: n.projectId, label: n.number, canView: true, canUpload: can(actor, perms(n.partyRole).manage), locked: n.status !== "DRAFT" };
}

/** Open documents a note can be raised against (for the note form). */
export async function noteTargets(actor: Actor, projectId?: string | null) {
  const inProject = projectId ? { projectId } : {};
  const [bills, invoices] = await Promise.all([
    can(actor, "bills.manage") ? db.supplierBill.findMany({ where: { AND: [projectScoped(actor) as Prisma.SupplierBillWhereInput, { status: { in: ["APPROVED", "PARTIALLY_PAID"] } }, inProject] }, orderBy: { invoiceDate: "desc" }, take: 500, select: { id: true, number: true, supplierInvoiceNo: true, netPayable: true, paidAmount: true, adjustedAmount: true, taxMode: true, party: { select: { name: true } }, project: { select: { code: true } } } }) : [],
    can(actor, "invoice.manage") ? db.clientInvoice.findMany({ where: { AND: [projectRequiredScoped(actor) as Prisma.ClientInvoiceWhereInput, { status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, inProject] }, orderBy: { invoiceDate: "desc" }, take: 500, select: { id: true, number: true, netReceivable: true, receivedAmount: true, adjustedAmount: true, taxMode: true, party: { select: { name: true } }, project: { select: { code: true } } } }) : [],
  ]);
  return {
    bills: bills.map((b) => ({ id: b.id, label: `${b.number} · ${b.party.name} · inv ${b.supplierInvoiceNo}`, project: b.project?.code ?? null, outstanding: outstandingOf(dec2(b.netPayable), dec2(b.paidAmount), dec2(b.adjustedAmount)), taxMode: b.taxMode })),
    invoices: invoices.map((i) => ({ id: i.id, label: `${i.number} · ${i.party.name}`, project: i.project.code, outstanding: outstandingOf(dec2(i.netReceivable), dec2(i.receivedAmount), dec2(i.adjustedAmount)), taxMode: i.taxMode })),
  };
}
