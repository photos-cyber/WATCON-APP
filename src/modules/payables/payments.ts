import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { addMoney, cmpMoney, formatINR, subMoney } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { assertCanApprove, assertProjectUsable, dec2, isSuperAdmin, parseInput, projectRequiredScoped, projectScoped, requirePermission, requireSuperAdmin } from "@/modules/commercial/core";
import { storeEvidenceTx } from "@/modules/documents/attachments";
import { moneyField, optMoney, optionalProjectIdField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { applyBillSettlement, applyInvoiceSettlement, lockBill, lockInvoice, lockPayment, outstandingOf } from "./settlement";

/**
 * Supplier payments (OUT) and client receipts (IN). A payment is posted once; what is not
 * allocated to bills / invoices is an advance that can be allocated later. Allocations are
 * reversed (never deleted); cancelling a payment reverses all of its allocations.
 */

export const PAYMENT_MODES = ["BANK_TRANSFER", "CHEQUE", "UPI", "CASH", "CARD", "OTHER"] as const;
export const PAYMENT_MODE_LABELS: Record<(typeof PAYMENT_MODES)[number], string> = { BANK_TRANSFER: "Bank transfer (NEFT/RTGS/IMPS)", CHEQUE: "Cheque", UPI: "UPI", CASH: "Cash", CARD: "Card", OTHER: "Other" };

const allocationSchema = z.object({ documentId: uuid, amount: moneyField.refine((v) => Number(v) > 0, "Must be greater than zero.") });

export const paymentSchema = z.object({
  direction: z.enum(["OUT", "IN"]),
  partyId: uuid,
  /** Client receipts always have a project; supplier payments for general-stock purchases may not. */
  projectId: optionalProjectIdField,
  /** Supplier payments: the purchase order this is paid against (an advance until bills are settled). */
  poId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  /** Client receipts: the sales order this is received against (an advance on that order until set against its invoices). */
  soId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  paymentDate: dateString,
  mode: z.enum(PAYMENT_MODES),
  reference: optionalText("Reference", 100),
  bankAccount: optionalText("Bank account", 100),
  amount: optMoney,
  tdsAmount: optMoney,
  remarks: optionalText("Remarks", 1000),
  idempotencyKey: z.string().trim().min(8).max(100),
  allocations: z.array(allocationSchema).max(200).default([]),
});
export type PaymentInput = z.input<typeof paymentSchema>;

type PaymentRow = Awaited<ReturnType<typeof lockPayment>>;
/** Advance still held: received (+ TDS) − allocated to invoices / bills − refunded to the client. */
const unallocatedOf = (p: Pick<PaymentRow, "amount" | "tdsAmount" | "allocatedAmount" | "refundedAmount">) => subMoney(subMoney(addMoney(dec2(p.amount), dec2(p.tdsAmount)), dec2(p.allocatedAmount)), dec2(p.refundedAmount));

/** Allocates part of a payment to one bill (OUT) or invoice (IN). Locks payment, then the document. */
async function allocateTx(tx: Tx, actor: Actor, paymentId: string, documentId: string, amount: string) {
  const p = await lockPayment(tx, paymentId);
  if (p.status !== "POSTED") throw new ValidationError("This payment is cancelled.");
  if (p.refundOfId) throw new ValidationError("A refund cannot be allocated to documents.");
  const free = unallocatedOf(p);
  if (cmpMoney(amount, free) > 0) throw new ValidationError(`Only ${formatINR(free)} of this ${p.direction === "OUT" ? "payment" : "receipt"} is unallocated.`, { amount: `Maximum ${formatINR(free)}.` });
  let label: string;
  if (p.direction === "OUT") {
    const visible = await tx.supplierBill.findFirst({ where: { AND: [{ id: documentId }, projectScoped(actor) as Prisma.SupplierBillWhereInput] }, select: { id: true } });
    if (!visible) throw new ValidationError("Supplier bill not found.");
    const b = await lockBill(tx, documentId);
    if (b.partyId !== p.partyId) throw new ValidationError(`Bill ${b.number} belongs to a different supplier.`);
    if (b.projectId !== p.projectId) throw new ValidationError(`Bill ${b.number} belongs to a different project. A payment can only settle bills of its own project.`);
    if (p.poId && b.poId && p.poId !== b.poId) throw new ValidationError(`This payment was made against another purchase order; bill ${b.number} is for a different PO.`);
    if (!["APPROVED", "PARTIALLY_PAID"].includes(b.status)) throw new ValidationError(`Bill ${b.number} is not approved for payment (or is already paid).`);
    const due = outstandingOf(dec2(b.netPayable), dec2(b.paidAmount), dec2(b.adjustedAmount));
    if (cmpMoney(amount, due) > 0) throw new ValidationError(`Bill ${b.number} has only ${formatINR(due)} outstanding.`, { amount: `Maximum ${formatINR(due)}.` });
    await tx.paymentAllocation.create({ data: { organizationId: actor.organizationId, paymentId, supplierBillId: b.id, amount, allocatedById: actor.id } });
    await applyBillSettlement(tx, b.id, { paid: amount });
    label = b.number;
  } else {
    const visible = await tx.clientInvoice.findFirst({ where: { AND: [{ id: documentId }, projectRequiredScoped(actor) as Prisma.ClientInvoiceWhereInput] }, select: { id: true } });
    if (!visible) throw new ValidationError("Client invoice not found.");
    const inv = await lockInvoice(tx, documentId);
    if (inv.partyId !== p.partyId) throw new ValidationError(`Invoice ${inv.number} belongs to a different client.`);
    if (inv.projectId !== p.projectId) throw new ValidationError(`Invoice ${inv.number} belongs to a different project. A receipt can only settle invoices of its own project.`);
    if (p.soId && inv.soId !== p.soId) throw new ValidationError(`This receipt was received against another sales order; invoice ${inv.number} is not on that order.`);
    if (!["ISSUED", "PARTIALLY_PAID"].includes(inv.status)) throw new ValidationError(`Invoice ${inv.number} is not issued (or is already paid).`);
    const due = outstandingOf(dec2(inv.netReceivable), dec2(inv.receivedAmount), dec2(inv.adjustedAmount));
    if (cmpMoney(amount, due) > 0) throw new ValidationError(`Invoice ${inv.number} has only ${formatINR(due)} outstanding.`, { amount: `Maximum ${formatINR(due)}.` });
    await tx.paymentAllocation.create({ data: { organizationId: actor.organizationId, paymentId, clientInvoiceId: inv.id, amount, allocatedById: actor.id } });
    await applyInvoiceSettlement(tx, inv.id, { received: amount });
    label = inv.number;
  }
  await tx.payment.update({ where: { id: paymentId }, data: { allocatedAmount: addMoney(dec2(p.allocatedAmount), amount), version: { increment: 1 } } });
  return label;
}

export type ProofFile = { fileName: string; bytes: Uint8Array };

/**
 * Records a supplier payment or client receipt, with optional supporting proof (bank advice, cheque
 * photo, UTR screenshot) stored in the same transaction. A repeated submit (same idempotency key)
 * returns the original payment — never a second one.
 */
export async function createPayment(actor: Actor, input: unknown, proof?: ProofFile | null) {
  requirePermission(actor, "payments.manage");
  const data = parseInput(paymentSchema, input);
  const existing = await db.payment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: data.idempotencyKey } } });
  if (existing) return existing;
  if (data.direction === "OUT" && cmpMoney(data.tdsAmount, "0") > 0) throw new ValidationError("TDS on supplier payments is deducted on the bill, not here.", { tdsAmount: "Not used for supplier payments." });
  const gross = addMoney(data.amount, data.tdsAmount);
  if (cmpMoney(gross, "0") <= 0) throw new ValidationError("Enter the amount.", { amount: "Must be greater than zero." });
  const allocated = addMoney(...data.allocations.map((a) => a.amount));
  if (cmpMoney(allocated, gross) > 0) throw new ValidationError(`You have allocated ${formatINR(allocated)}, more than the ${formatINR(gross)} ${data.direction === "OUT" ? "paid" : "received"}.`, { allocations: "Allocated more than the amount." });
  if (new Set(data.allocations.map((a) => a.documentId)).size !== data.allocations.length) throw new ValidationError("Each document can appear only once.", { allocations: "Duplicate document." });
  const party = await db.party.findFirst({ where: { id: data.partyId, organizationId: actor.organizationId } });
  if (!party || (data.direction === "OUT" ? !party.isSupplier : !party.isClient)) throw new ValidationError(data.direction === "OUT" ? "Choose a supplier." : "Choose a client.", { partyId: "Wrong party type." });
  let projectId = data.projectId;
  if (data.poId) {
    if (data.direction !== "OUT") throw new ValidationError("Only supplier payments are made against a purchase order.", { poId: "Supplier payments only." });
    const po = await db.purchaseOrder.findFirst({ where: { AND: [{ id: data.poId }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, select: { number: true, partyId: true, projectId: true, status: true } });
    if (!po) throw new ValidationError("Purchase order not found.", { poId: "Not found." });
    if (po.partyId !== party.id) throw new ValidationError(`${po.number} is with a different supplier.`, { poId: "Different supplier." });
    if (["DRAFT", "PENDING_APPROVAL", "REJECTED", "CANCELLED"].includes(po.status)) throw new ValidationError(`${po.number} is not approved, so nothing can be paid against it yet.`, { poId: "PO not approved." });
    if (projectId && projectId !== po.projectId) throw new ValidationError(`${po.number} belongs to ${po.projectId ? "another project" : "general stock"}.`, { projectId: "Different from the PO." });
    projectId = po.projectId;
  }
  if (data.soId) {
    if (data.direction !== "IN") throw new ValidationError("Only client receipts are recorded against a sales order.", { soId: "Client receipts only." });
    const so = await db.salesOrder.findFirst({ where: { AND: [{ id: data.soId }, projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput] }, select: { number: true, partyId: true, projectId: true, status: true } });
    if (!so) throw new ValidationError("Sales order not found.", { soId: "Not found." });
    if (so.partyId !== party.id) throw new ValidationError(`${so.number} is with a different client.`, { soId: "Different client." });
    if (!["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"].includes(so.status)) throw new ValidationError(`${so.number} is not confirmed, so nothing can be received against it yet.`, { soId: "Order not confirmed." });
    if (projectId && projectId !== so.projectId) throw new ValidationError(`${so.number} belongs to another project.`, { projectId: "Different from the sales order." });
    projectId = so.projectId;
  }
  if (data.direction === "IN" && !projectId) throw new ValidationError("Select the project this receipt is for.", { projectId: "Select the project this is for." });
  if (data.direction === "OUT" && !projectId && !data.poId) throw new ValidationError("Select the project, or pay against a general-stock purchase order.", { projectId: "Select the project this is for." });
  if (projectId) await assertProjectUsable(actor, projectId);
  try {
    return await db.$transaction(async (tx) => {
      const date = toDbDate(data.paymentDate)!;
      const number = await nextDocNumber(tx, actor.organizationId, data.direction === "OUT" ? "PAY" : "RCPT", date);
      const p = await tx.payment.create({
        data: { organizationId: actor.organizationId, number, direction: data.direction, partyId: party.id, projectId, poId: data.poId, soId: data.soId, paymentDate: date, mode: data.mode, reference: data.reference, bankAccount: data.bankAccount, amount: data.amount, tdsAmount: data.tdsAmount, remarks: data.remarks, idempotencyKey: data.idempotencyKey, createdById: actor.id },
      });
      const labels: string[] = [];
      for (const a of data.allocations) labels.push(await allocateTx(tx, actor, p.id, a.documentId, a.amount));
      if (proof) await storeEvidenceTx(tx, actor, { entityType: "payment", entityId: p.id, projectId, label: number, category: "PAYMENT_PROOF", description: data.reference ? `Ref ${data.reference}` : null, fileName: proof.fileName, bytes: proof.bytes });
      const advance = subMoney(gross, allocated);
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: data.direction === "OUT" ? "payment.made" : "payment.received", entityType: "payment", entityId: p.id, projectId, summary: `${data.direction === "OUT" ? "Paid" : "Received"} ${formatINR(gross)} ${data.direction === "OUT" ? "to" : "from"} ${party.name} (${number})${labels.length ? ` against ${labels.join(", ")}` : ""}${cmpMoney(advance, "0") > 0 ? ` · advance ${formatINR(advance)}` : ""}` }, tx);
      return tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await db.payment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: data.idempotencyKey } } });
      if (again) return again;
    }
    throw e;
  }
}

async function loadScoped(actor: Actor, id: string) {
  const p = await db.payment.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PaymentWhereInput] } });
  if (!p) throw new NotFoundError("Payment");
  return p;
}

export async function allocatePayment(actor: Actor, paymentId: string, input: unknown) {
  requirePermission(actor, "payments.manage");
  const data = parseInput(allocationSchema, input);
  const p = await loadScoped(actor, paymentId);
  return db.$transaction(async (tx) => {
    const label = await allocateTx(tx, actor, p.id, data.documentId, data.amount);
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "payment.allocated", entityType: "payment", entityId: p.id, projectId: p.projectId, summary: `Allocated ${formatINR(data.amount)} of ${p.number} to ${label}` }, tx);
  });
}

async function reverseTx(tx: Tx, actor: Actor, allocationId: string, reason: string) {
  const a = await tx.paymentAllocation.findUniqueOrThrow({ where: { id: allocationId } });
  const p = await lockPayment(tx, a.paymentId);
  const res = await tx.paymentAllocation.updateMany({ where: { id: allocationId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: actor.id, reverseReason: reason } });
  if (res.count !== 1) throw new ConflictError("This allocation was already reversed.");
  const amt = dec2(a.amount);
  if (a.supplierBillId) await applyBillSettlement(tx, a.supplierBillId, { paid: `-${amt}` });
  if (a.clientInvoiceId) await applyInvoiceSettlement(tx, a.clientInvoiceId, { received: `-${amt}` });
  await tx.payment.update({ where: { id: p.id }, data: { allocatedAmount: subMoney(dec2(p.allocatedAmount), amt), version: { increment: 1 } } });
  return amt;
}

export async function reverseAllocation(actor: Actor, allocationId: string, reason: string | null | undefined) {
  requirePermission(actor, "payments.manage");
  requireSuperAdmin(actor, "reverse a payment allocation");
  if (!reason?.trim()) throw new ValidationError("Give a reason for reversing.", { note: "Reason required." });
  const a = await db.paymentAllocation.findFirst({ where: { id: allocationId, organizationId: actor.organizationId }, include: { payment: { select: { id: true } } } });
  if (!a) throw new NotFoundError("Allocation");
  const p = await loadScoped(actor, a.payment.id);
  return db.$transaction(async (tx) => {
    const amt = await reverseTx(tx, actor, allocationId, reason.trim());
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "payment.allocation_reversed", entityType: "payment", entityId: p.id, projectId: p.projectId, summary: `Reversed allocation of ${formatINR(amt)} on ${p.number} – ${reason.trim()}` }, tx);
  });
}

export async function cancelPayment(actor: Actor, id: string, version: number, reason: string | null | undefined) {
  requirePermission(actor, "payments.manage");
  requireSuperAdmin(actor, "cancel a recorded payment");
  if (!reason?.trim()) throw new ValidationError("Give a reason for cancelling.", { note: "Reason required." });
  const p = await loadScoped(actor, id);
  return db.$transaction(async (tx) => {
    const locked = await lockPayment(tx, id);
    if (locked.status !== "POSTED" || locked.version !== version) throw new ConflictError("This payment was changed by someone else or is already cancelled. Reload and try again.");
    if (await tx.payment.count({ where: { refundOfId: id, status: "POSTED" } })) throw new ValidationError("Part of this receipt was refunded. Cancel the refund first.");
    if (locked.refundOfId) {
      const orig = await lockPayment(tx, locked.refundOfId);
      await tx.payment.update({ where: { id: orig.id }, data: { refundedAmount: subMoney(dec2(orig.refundedAmount), dec2(locked.amount)), version: { increment: 1 } } });
    }
    const active = await tx.paymentAllocation.findMany({ where: { paymentId: id, reversedAt: null } });
    for (const a of active) await reverseTx(tx, actor, a.id, `Payment cancelled: ${reason.trim()}`);
    await tx.payment.update({ where: { id }, data: { status: "CANCELLED", cancelledById: actor.id, cancelledAt: new Date(), cancelReason: reason.trim(), version: { increment: 1 } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "payment.cancelled", entityType: "payment", entityId: id, projectId: p.projectId, summary: `Cancelled ${p.number} (${formatINR(addMoney(dec2(p.amount), dec2(p.tdsAmount)))})${active.length ? `, reversed ${active.length} allocation(s)` : ""} – ${reason.trim()}` }, tx);
  });
}

// ─────────────────────────── Refunds ───────────────────────────

export const refundSchema = z.object({
  amount: moneyField.refine((v) => Number(v) > 0, "Must be greater than zero."),
  paymentDate: dateString,
  mode: z.enum(PAYMENT_MODES),
  reference: optionalText("Reference", 100),
  reason: z.string().trim().min(5, "Explain why the advance is refunded.").max(500),
  idempotencyKey: z.string().trim().min(8).max(100),
});

/**
 * Authorised refund of a client's unallocated advance: an approver (invoice approval right, not the
 * person who recorded the receipt unless Super Admin, within the approval limit for REFUND) pays part
 * of it back. Recorded as an OUT payment linked to the receipt; the receipt's advance goes down by the
 * same amount, under a row lock. Cancelling the refund restores the advance.
 */
export async function refundClientAdvance(actor: Actor, receiptId: string, input: unknown) {
  requirePermission(actor, "payments.manage");
  const data = parseInput(refundSchema, input);
  const r = await loadScoped(actor, receiptId);
  if (r.direction !== "IN" || r.refundOfId) throw new ValidationError("Only a client receipt's advance can be refunded.");
  await assertCanApprove(actor, { permission: "invoice.approve", docType: "REFUND", amount: data.amount, createdById: r.createdById, what: "client refund" });
  const existing = await db.payment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: data.idempotencyKey } } });
  if (existing) return existing;
  try {
    return await db.$transaction(async (tx) => {
      const p = await lockPayment(tx, receiptId);
      if (p.status !== "POSTED") throw new ValidationError("This receipt is cancelled.");
      const free = unallocatedOf(p);
      if (cmpMoney(data.amount, free) > 0) throw new ValidationError(`Only ${formatINR(free)} of this receipt is unallocated advance.`, { amount: `Maximum ${formatINR(free)}.` });
      const date = toDbDate(data.paymentDate)!;
      const number = await nextDocNumber(tx, actor.organizationId, "RFND", date);
      const refund = await tx.payment.create({ data: { organizationId: actor.organizationId, number, direction: "OUT", partyId: p.partyId, projectId: p.projectId, paymentDate: date, mode: data.mode, reference: data.reference, amount: data.amount, remarks: data.reason, idempotencyKey: data.idempotencyKey, refundOfId: p.id, createdById: actor.id } });
      await tx.payment.update({ where: { id: p.id }, data: { refundedAmount: addMoney(dec2(p.refundedAmount), data.amount), version: { increment: 1 } } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "payment.refunded", entityType: "payment", entityId: p.id, projectId: p.projectId, summary: `Refunded ${formatINR(data.amount)} of advance on ${p.number} (${number}) – ${data.reason}` }, tx);
      return refund;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await db.payment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: data.idempotencyKey } } });
      if (again) return again;
    }
    throw e;
  }
}

// ─────────────────────────── Queries ───────────────────────────

export const paymentListQuerySchema = z.object({
  direction: z.enum(["OUT", "IN"]).catch("OUT").default("OUT"),
  q: z.string().trim().max(100).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  partyId: uuid.optional().catch(undefined),
  advances: z.enum(["1"]).optional().catch(undefined),
  status: z.enum(["POSTED", "CANCELLED"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listPayments(actor: Actor, raw: unknown) {
  requirePermission(actor, "payments.view");
  const q = paymentListQuerySchema.parse(raw ?? {});
  const base: Prisma.PaymentWhereInput = { AND: [projectScoped(actor) as Prisma.PaymentWhereInput, { direction: q.direction }, q.projectId ? { projectId: q.projectId } : {}, q.partyId ? { partyId: q.partyId } : {}] };
  const where: Prisma.PaymentWhereInput = {
    AND: [base, q.status ? { status: q.status } : {}, q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { reference: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }] } : {}],
  };
  const rows = await db.payment.findMany({ where, orderBy: [{ paymentDate: "desc" }, { createdAt: "desc" }], take: 2000, include: { party: { select: { id: true, name: true } }, project: { select: { id: true, code: true } } } });
  const mapped = rows.map((r) => ({ id: r.id, number: r.number, direction: r.direction, paymentDate: r.paymentDate.toISOString(), mode: r.mode, reference: r.reference, amount: dec2(r.amount), tdsAmount: dec2(r.tdsAmount), gross: addMoney(dec2(r.amount), dec2(r.tdsAmount)), allocated: dec2(r.allocatedAmount), unallocated: r.status === "POSTED" && !r.refundOfId ? unallocatedOf(r) : "0.00", isRefund: !!r.refundOfId, status: r.status, party: r.party, project: r.project }));
  const filtered = q.advances ? mapped.filter((r) => cmpMoney(r.unallocated, "0") > 0) : mapped;
  const totals = await db.payment.aggregate({ where: { AND: [base, { status: "POSTED", refundOfId: null }] }, _sum: { amount: true, tdsAmount: true, allocatedAmount: true, refundedAmount: true }, _count: true });
  const advance = subMoney(subMoney(addMoney(dec2(totals._sum.amount), dec2(totals._sum.tdsAmount)), dec2(totals._sum.allocatedAmount)), dec2(totals._sum.refundedAmount));
  const advanceCount = mapped.filter((r) => cmpMoney(r.unallocated, "0") > 0).length;
  return {
    total: filtered.length,
    page: q.page,
    pageSize: q.pageSize,
    query: q,
    rows: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
    summary: { count: totals._count, gross: addMoney(dec2(totals._sum.amount), dec2(totals._sum.tdsAmount)), advance, advanceCount },
  };
}

export async function getPayment(actor: Actor, id: string) {
  requirePermission(actor, "payments.view");
  const p = await db.payment.findFirst({
    where: { AND: [{ id }, projectScoped(actor) as Prisma.PaymentWhereInput] },
    include: {
      party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true } },
      project: { select: { id: true, code: true, name: true } },
      createdBy: { select: { fullName: true } },
      cancelledBy: { select: { fullName: true } },
      refundOf: { select: { id: true, number: true } },
      po: { select: { id: true, number: true } },
      refunds: { select: { id: true, number: true, amount: true, status: true, paymentDate: true }, orderBy: { createdAt: "asc" } },
      allocations: { orderBy: { allocatedAt: "asc" }, include: { supplierBill: { select: { id: true, number: true, supplierInvoiceNo: true } }, clientInvoice: { select: { id: true, number: true } }, allocatedBy: { select: { fullName: true } }, reversedBy: { select: { fullName: true } } } },
    },
  });
  if (!p) throw new NotFoundError("Payment");
  const unallocated = p.status === "POSTED" && !p.refundOfId ? unallocatedOf(p) : "0.00";
  return {
    payment: { ...p, amount: dec2(p.amount), tdsAmount: dec2(p.tdsAmount), allocatedAmount: dec2(p.allocatedAmount), refundedAmount: dec2(p.refundedAmount), gross: addMoney(dec2(p.amount), dec2(p.tdsAmount)), allocations: p.allocations.map((a) => ({ ...a, amount: dec2(a.amount) })), refunds: p.refunds.map((r) => ({ ...r, amount: dec2(r.amount) })) },
    unallocated,
    can: {
      allocate: can(actor, "payments.manage") && p.status === "POSTED" && !p.refundOfId && cmpMoney(unallocated, "0") > 0,
      refund: can(actor, "payments.manage") && can(actor, "invoice.approve") && p.direction === "IN" && p.status === "POSTED" && cmpMoney(unallocated, "0") > 0,
      reverse: can(actor, "payments.manage") && isSuperAdmin(actor) && p.status === "POSTED",
      cancel: can(actor, "payments.manage") && isSuperAdmin(actor) && p.status === "POSTED",
      requestChange: can(actor, "payments.manage") && !isSuperAdmin(actor) && p.status === "POSTED",
    },
  };
}

export async function paymentAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "payments.view")) return null;
  const p = await db.payment.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PaymentWhereInput] }, select: { number: true, projectId: true, status: true } });
  if (!p) return null;
  return { projectId: p.projectId, label: p.number, canView: true, canUpload: can(actor, "payments.manage"), locked: p.status === "CANCELLED" };
}

/** Open (issued, unpaid) invoices of a client, oldest due first — for the receipt form. */
export async function outstandingInvoices(actor: Actor, partyId: string, projectId?: string | null, soId?: string | null) {
  requirePermission(actor, "payments.view");
  const rows = await db.clientInvoice.findMany({
    where: { AND: [projectRequiredScoped(actor) as Prisma.ClientInvoiceWhereInput, { partyId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, projectId ? { projectId } : {}, soId ? { soId } : {}] },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { invoiceDate: "asc" }],
    select: { id: true, number: true, invoiceDate: true, dueDate: true, netReceivable: true, receivedAmount: true, adjustedAmount: true, project: { select: { code: true } } },
  });
  return rows.map((r) => ({ id: r.id, number: r.number, ref: null as string | null, date: r.invoiceDate.toISOString(), dueDate: r.dueDate?.toISOString() ?? null, net: dec2(r.netReceivable), outstanding: outstandingOf(dec2(r.netReceivable), dec2(r.receivedAmount), dec2(r.adjustedAmount)), project: r.project.code })).filter((r) => cmpMoney(r.outstanding, "0") > 0);
}

/** Party + project of the bill / invoice a payment form was opened from (null when not visible). */
export async function paymentDefaultsFor(actor: Actor, direction: "OUT" | "IN", documentId: string) {
  requirePermission(actor, "payments.manage");
  return direction === "OUT"
    ? db.supplierBill.findFirst({ where: { AND: [{ id: documentId }, projectScoped(actor) as Prisma.SupplierBillWhereInput] }, select: { partyId: true, projectId: true } })
    : db.clientInvoice.findFirst({ where: { AND: [{ id: documentId }, projectRequiredScoped(actor) as Prisma.ClientInvoiceWhereInput] }, select: { partyId: true, projectId: true } });
}
