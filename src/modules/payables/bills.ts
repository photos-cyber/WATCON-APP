import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ForbiddenError, NotFoundError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { GSTIN_RE, TDS_SECTIONS } from "@/lib/gst";
import { addQty, cmpMoney, cmpQty, minQty, pctOf, subMoney, subQty, taxModeFor, type TaxMode } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { assertProjectUsable, dec2, dec3, dec4, getCommercialSettings, parseInput, projectScoped, requireAnyPermission, requirePermission, transition } from "@/modules/commercial/core";
import { gstRateField, optMoney, optPct, priceDocument, qtyField, rateField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { startOfToday } from "@/modules/tasks/rules";
import { billableQty, invoiceKeyOf, matchBill, type GrnLineRef, type MatchException, type MatchMode, type PoLineRef } from "./match";
import { outstandingOf } from "./settlement";

/**
 * Supplier bills (purchase invoices).
 *   DRAFT → PENDING_APPROVAL → APPROVED → PARTIALLY_PAID → PAID;  REJECTED → edit → DRAFT;  CANCELLED.
 * Every bill belongs to one project. Bills against a PO are matched line-wise (2-way: ordered,
 * 3-way: received & accepted) and only approval moves the PO / GRN billed counters, under row locks.
 */

const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
const optId = z.union([uuid, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
const OPEN_PO = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"];

const billLineSchema = z.object({
  poLineId: optId,
  grnLineId: optId,
  itemBrandId: optId,
  description: text("Description", 300),
  hsnCode: optionalText("HSN", 10),
  unit: optionalText("Unit", 20),
  quantity: qtyField,
  rate: rateField,
  discountPct: optPct,
  gstRate: gstRateField,
});

export const billSchema = z.object({
  poId: optId,
  projectId: optId,
  partyId: optId,
  supplierInvoiceNo: text("Supplier invoice number", 50),
  invoiceDate: dateString,
  dueDate: optDate,
  supplierGstin: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (v ? v.trim().toUpperCase() : null))
    .pipe(z.union([z.null(), z.string().regex(GSTIN_RE, "Enter a valid 15-character GSTIN.")])),
  charges: optMoney,
  chargesGstRate: optPct,
  roundToRupee: z.boolean().default(false),
  tdsSection: z.union([z.enum(TDS_SECTIONS), z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
  tdsRate: optPct,
  remarks: optionalText("Remarks", 1000),
  lines: z.array(billLineSchema).min(1, "Add at least one line.").max(200),
});
export type BillInput = z.input<typeof billSchema>;

/** Stored in supplier_bills.exceptions. `grnApplied` records exactly what approval added to GRN lines. */
type ExceptionsJson = { list: MatchException[]; grnApplied?: Record<string, string> };
export const exceptionsOf = (j: Prisma.JsonValue | null): ExceptionsJson => {
  if (j && typeof j === "object" && !Array.isArray(j) && Array.isArray((j as { list?: unknown }).list)) return j as unknown as ExceptionsJson;
  return { list: [] };
};

async function lockIds(tx: Tx, table: "po_lines" | "grn_lines", ids: string[]) {
  if (!ids.length) return;
  const sorted = [...new Set(ids)].sort();
  if (table === "po_lines") await tx.$queryRaw`SELECT id FROM po_lines WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM grn_lines WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
}

/** PO + GRN counters used for matching (current DB values; lock first when deciding). */
async function matchRefs(tx: Tx | typeof db, poId: string) {
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true } });
  const grnLines = await tx.grnLine.findMany({ where: { grn: { poId, status: "POSTED" } }, include: { grn: { select: { number: true } } } });
  const poLines: PoLineRef[] = po.lines.map((l) => ({ id: l.id, rate: dec4(l.rate), quantity: dec3(l.quantity), acceptedQty: dec3(l.acceptedQty), billedQty: dec3(l.billedQty), unit: l.unit }));
  const grns: GrnLineRef[] = grnLines.map((g) => ({ id: g.id, poLineId: g.poLineId, acceptedQty: dec3(g.acceptedQty), billedQty: dec3(g.billedQty), grnNumber: g.grn.number }));
  return { po, poLines, grnLines: grns };
}

const stateOfGstin = (g: string | null) => (g ? g.slice(0, 2) : null);

async function buildBill(tx: Tx, actor: Actor, data: z.output<typeof billSchema>) {
  const settings = await getCommercialSettings(actor.organizationId, tx);
  let projectId = data.projectId;
  let partyId = data.partyId;
  let po: Awaited<ReturnType<typeof matchRefs>> | null = null;
  let generalStock = false;
  if (data.poId) {
    const visible = await tx.purchaseOrder.findFirst({ where: { AND: [{ id: data.poId }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, select: { id: true, status: true, partyId: true, projectId: true, number: true } });
    if (!visible) throw new ValidationError("Choose a purchase order you can see.", { poId: "Purchase order not found." });
    if (!OPEN_PO.includes(visible.status)) throw new ValidationError(`${visible.number} is not approved yet, so it cannot be billed.`, { poId: "PO not approved." });
    if (partyId && partyId !== visible.partyId) throw new ValidationError("The supplier must be the one on the purchase order.", { partyId: "Different from the PO supplier." });
    partyId = visible.partyId;
    if (projectId && visible.projectId && projectId !== visible.projectId) throw new ValidationError(`${visible.number} belongs to a different project.`, { poId: "PO of another project." });
    if (!visible.projectId && projectId) throw new ValidationError(`${visible.number} is a general-stock / combined order, so its bill is not charged to a project.`, { projectId: "General-stock PO." });
    // A bill for a general-stock (or combined) PO is a warehouse purchase, not a project cost: the cost
    // reaches projects only when material is issued to them.
    generalStock = !visible.projectId;
    projectId = visible.projectId ?? projectId;
    po = await matchRefs(tx, visible.id);
  }
  if (!projectId && !generalStock) throw new ValidationError("Select the project this bill is for.", { projectId: "Select the project this is for." });
  if (!partyId) throw new ValidationError("Select the supplier.", { partyId: "Select the supplier." });
  if (projectId) await assertProjectUsable(actor, projectId, tx);
  const party = await tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } });
  if (!party || !party.isSupplier) throw new ValidationError("Choose a supplier.", { partyId: "Not a supplier." });
  if (party.status !== "ACTIVE") throw new ValidationError("This supplier is inactive.", { partyId: "Inactive supplier." });

  const mode: TaxMode = taxModeFor(settings.stateCode, stateOfGstin(data.supplierGstin) ?? party.stateCode);
  const poLineMap = new Map((po?.po.lines ?? []).map((l) => [l.id, l]));
  const grnMap = new Map((po?.grnLines ?? []).map((g) => [g.id, g]));
  data.lines.forEach((l, i) => {
    if (l.poLineId && !poLineMap.has(l.poLineId)) throw new ValidationError(`Line ${i + 1} does not belong to the selected purchase order.`, { [`lines.${i}.poLineId`]: "Not on this PO." });
    if (l.grnLineId) {
      const g = grnMap.get(l.grnLineId);
      if (!g || g.poLineId !== l.poLineId) throw new ValidationError(`Line ${i + 1}: the site receipt line does not match this PO line.`, { [`lines.${i}.grnLineId`]: "Wrong receipt line." });
    }
  });
  const ibIds = [...new Set(data.lines.map((l) => l.itemBrandId ?? (l.poLineId ? poLineMap.get(l.poLineId)!.itemBrandId : null)).filter(Boolean) as string[])];
  if (ibIds.length) {
    const found = await tx.itemBrand.count({ where: { id: { in: ibIds }, organizationId: actor.organizationId } });
    if (found !== ibIds.length) throw new ValidationError("An item on the bill was not found.");
  }
  const priced = priceDocument(data.lines, mode, { charges: data.charges, chargesGstRate: data.chargesGstRate, roundToRupee: data.roundToRupee });
  const tdsAmount = data.tdsSection && Number(data.tdsRate) > 0 ? pctOf(priced.totals.taxable, data.tdsRate) : "0.00";
  const netPayable = subMoney(priced.totals.total, tdsAmount);
  if (cmpMoney(netPayable, "0") < 0) throw new ValidationError("TDS cannot exceed the bill total.", { tdsRate: "Too high." });

  const lines = priced.lines.map((l, i) => {
    const pl = l.poLineId ? poLineMap.get(l.poLineId) : undefined;
    return {
      lineNo: i + 1,
      poLineId: l.poLineId,
      grnLineId: l.grnLineId,
      itemBrandId: l.itemBrandId ?? pl?.itemBrandId ?? null,
      description: l.description,
      hsnCode: l.hsnCode ?? pl?.hsnCode ?? null,
      unit: l.unit ?? pl?.unit ?? null,
      quantity: l.quantity,
      rate: l.rate,
      discountPct: l.discountPct,
      gstRate: l.gstRate,
      taxable: l.amounts.taxable,
      taxAmount: l.amounts.tax,
      total: l.amounts.total,
    };
  });
  const match = matchBill({
    mode: settings.billMatchMode,
    rateTolerancePct: settings.rateTolerancePct,
    billTaxMode: mode,
    poTaxMode: po?.po.taxMode ?? null,
    supplierGstin: data.supplierGstin,
    partyGstin: party.gstin,
    hasPo: !!po,
    lines: lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity, rate: l.rate, poLineId: l.poLineId, grnLineId: l.grnLineId })),
    poLines: po?.poLines ?? [],
    grnLines: po?.grnLines ?? [],
  });
  const invoiceDate = toDbDate(data.invoiceDate)!;
  let dueDate = toDbDate(data.dueDate);
  if (!dueDate && party.paymentTermsDays !== null) {
    dueDate = new Date(invoiceDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + party.paymentTermsDays);
  }
  const header = {
    partyId: party.id,
    projectId,
    poId: po?.po.id ?? null,
    supplierInvoiceNo: data.supplierInvoiceNo,
    invoiceKey: invoiceKeyOf(data.supplierInvoiceNo),
    invoiceDate,
    dueDate,
    supplierGstin: data.supplierGstin ?? party.gstin,
    taxMode: mode,
    taxable: priced.totals.taxable,
    cgst: priced.totals.cgst,
    sgst: priced.totals.sgst,
    igst: priced.totals.igst,
    charges: priced.totals.charges,
    chargesGstRate: data.chargesGstRate,
    roundOff: priced.totals.roundOff,
    total: priced.totals.total,
    tdsSection: data.tdsSection,
    tdsRate: data.tdsSection ? data.tdsRate : null,
    tdsAmount,
    netPayable,
    matchStatus: match.status,
    exceptions: { list: match.exceptions } as Prisma.InputJsonValue,
    remarks: data.remarks,
  };
  if (!header.invoiceKey) throw new ValidationError("Enter the supplier's invoice number.", { supplierInvoiceNo: "Required." });
  return { header, lines, party };
}

async function assertNotDuplicate(tx: Tx, organizationId: string, partyId: string, invoiceKey: string, exceptId?: string) {
  const dup = await tx.supplierBill.findFirst({ where: { organizationId, partyId, invoiceKey, status: { not: "CANCELLED" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { number: true, supplierInvoiceNo: true } });
  if (dup) throw new ValidationError(`This supplier invoice is already entered as ${dup.number} (invoice ${dup.supplierInvoiceNo}). Duplicate bills are not allowed.`, { supplierInvoiceNo: `Already entered as ${dup.number}.` });
}

function duplicateGuard(e: unknown): never {
  if (isUniqueViolation(e)) throw new ValidationError("This supplier invoice number is already entered for this supplier. Duplicate bills are not allowed.", { supplierInvoiceNo: "Already entered." });
  throw e;
}

export async function createBill(actor: Actor, input: unknown) {
  requirePermission(actor, "bills.manage");
  const data = parseInput(billSchema, input);
  return db
    .$transaction(async (tx) => {
      const { header, lines, party } = await buildBill(tx, actor, data);
      await assertNotDuplicate(tx, actor.organizationId, header.partyId, header.invoiceKey);
      const number = await nextDocNumber(tx, actor.organizationId, "SB", startOfToday());
      const bill = await tx.supplierBill.create({ data: { organizationId: actor.organizationId, number, ...header, createdById: actor.id, lines: { create: lines } } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "bill.created", entityType: "supplier_bill", entityId: bill.id, projectId: bill.projectId, summary: `Entered supplier bill ${number} – ${party.name} invoice ${data.supplierInvoiceNo} – ₹${header.total}${header.matchStatus === "EXCEPTION" ? " (match exceptions)" : ""}` }, tx);
      return bill;
    })
    .catch(duplicateGuard);
}

async function loadScoped(actor: Actor, id: string, client: Tx | typeof db = db) {
  const b = await client.supplierBill.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.SupplierBillWhereInput] }, include: { lines: true } });
  if (!b) throw new NotFoundError("Supplier bill");
  return b;
}

export async function updateBill(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "bills.manage");
  const data = parseInput(billSchema, input);
  const before = await loadScoped(actor, id);
  if (!["DRAFT", "REJECTED"].includes(before.status)) throw new ValidationError("Only draft or rejected bills can be edited.");
  return db
    .$transaction(async (tx) => {
      const { header, lines } = await buildBill(tx, actor, data);
      await assertNotDuplicate(tx, actor.organizationId, header.partyId, header.invoiceKey, id);
      await transition(tx.supplierBill, { id, organizationId: actor.organizationId, version }, ["DRAFT", "REJECTED"], { ...header, status: "DRAFT", statusNote: null, overrideReason: null }, "supplier bill");
      await tx.supplierBillLine.deleteMany({ where: { billId: id } });
      await tx.supplierBillLine.createMany({ data: lines.map((l) => ({ ...l, billId: id })) });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "bill.updated", entityType: "supplier_bill", entityId: id, projectId: header.projectId, summary: `Edited supplier bill ${before.number} – ₹${header.total}` }, tx);
    })
    .catch(duplicateGuard);
}

/** Re-runs the match against current counters (for submit) — or locked counters (inside approval). */
async function rematch(tx: Tx, bill: Awaited<ReturnType<typeof loadScoped>>, lock: boolean) {
  const settings = await getCommercialSettings(bill.organizationId, tx);
  const party = await tx.party.findUniqueOrThrow({ where: { id: bill.partyId }, select: { gstin: true } });
  if (!bill.poId) return { settings, ...matchBill({ mode: settings.billMatchMode, rateTolerancePct: settings.rateTolerancePct, billTaxMode: bill.taxMode, supplierGstin: bill.supplierGstin, partyGstin: party.gstin, hasPo: false, lines: [], poLines: [], grnLines: [] }), refs: null };
  if (lock) {
    await lockIds(tx, "po_lines", bill.lines.map((l) => l.poLineId).filter(Boolean) as string[]);
    await lockIds(tx, "grn_lines", bill.lines.map((l) => l.grnLineId).filter(Boolean) as string[]);
  }
  const refs = await matchRefs(tx, bill.poId);
  const r = matchBill({
    mode: settings.billMatchMode as MatchMode,
    rateTolerancePct: settings.rateTolerancePct,
    billTaxMode: bill.taxMode,
    poTaxMode: refs.po.taxMode,
    supplierGstin: bill.supplierGstin,
    partyGstin: party.gstin,
    hasPo: true,
    lines: bill.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: dec3(l.quantity), rate: dec4(l.rate), poLineId: l.poLineId, grnLineId: l.grnLineId })),
    poLines: refs.poLines,
    grnLines: refs.grnLines,
  });
  return { settings, ...r, refs };
}

/** Adds (+1) or removes (−1) this bill's quantities on PO / GRN lines. Rows must already be locked. */
async function applyBilled(tx: Tx, bill: Awaited<ReturnType<typeof loadScoped>>, sign: 1 | -1) {
  const ex = exceptionsOf(bill.exceptions);
  const grnApplied: Record<string, string> = {};
  for (const l of bill.lines) {
    const q = dec3(l.quantity);
    if (l.poLineId) {
      const pl = await tx.poLine.findUniqueOrThrow({ where: { id: l.poLineId } });
      const next = sign === 1 ? addQty(dec3(pl.billedQty), q) : subQty(dec3(pl.billedQty), q);
      await tx.poLine.update({ where: { id: l.poLineId }, data: { billedQty: cmpQty(next, "0") < 0 ? "0" : next } });
    }
    if (l.grnLineId) {
      const gl = await tx.grnLine.findUniqueOrThrow({ where: { id: l.grnLineId } });
      if (sign === 1) {
        // An approved override may bill above the receipt; the GRN line only records what was received.
        const room = subQty(dec3(gl.acceptedQty), dec3(gl.billedQty));
        const add = cmpQty(room, "0") > 0 ? minQty(q, room) : "0";
        grnApplied[l.grnLineId] = addQty(grnApplied[l.grnLineId] ?? "0", add);
        await tx.grnLine.update({ where: { id: l.grnLineId }, data: { billedQty: addQty(dec3(gl.billedQty), add) } });
      } else {
        const take = ex.grnApplied?.[l.grnLineId] ?? q;
        if (ex.grnApplied) delete ex.grnApplied[l.grnLineId];
        const next = subQty(dec3(gl.billedQty), take);
        await tx.grnLine.update({ where: { id: l.grnLineId }, data: { billedQty: cmpQty(next, "0") < 0 ? "0" : next } });
      }
    }
  }
  return grnApplied;
}

export type BillAction = "submit" | "approve" | "reject" | "cancel";

export async function billAction(actor: Actor, id: string, action: BillAction, opts: { version: number; note?: string | null; override?: boolean }) {
  const bill = await loadScoped(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string, extra = "") => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `bill.${action}`, entityType: "supplier_bill", entityId: id, projectId: bill.projectId, summary: `${verb} supplier bill ${bill.number}${extra}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new ValidationError(msg, { note: msg });
  };
  switch (action) {
    case "submit": {
      // Simplified workflow: a bill that matches its PO / receipts is approved for payment in one step.
      // Only a bill with match exceptions (e.g. billed above received) waits for an override.
      requireAnyPermission(actor, ["bills.manage", "bills.approve"]);
      const override = !!opts.override && can(actor, "bills.override_match");
      if (opts.override && !override) throw new ForbiddenError("You do not have permission to override match exceptions.");
      if (override) need(opts.note?.trim(), "Give the reason for accepting the bill despite the exceptions.");
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${id}::uuid FOR UPDATE`;
        const fresh = await loadScoped(actor, id, tx);
        const m = await rematch(tx, fresh, true);
        const now = new Date();
        if (m.exceptions.length && !override) {
          await transition(tx.supplierBill, w, ["DRAFT", "REJECTED"], { status: "PENDING_APPROVAL", submittedById: actor.id, submittedAt: now, statusNote: null, matchStatus: m.status, exceptions: { list: m.exceptions } as Prisma.InputJsonValue }, "supplier bill");
          await log(tx, "Submitted", ` (₹${dec2(bill.total)}) — ${m.exceptions.length} match exception(s) need an override`);
          return { approved: false, exceptions: m.exceptions.map((e) => e.message) };
        }
        const grnApplied = await applyBilled(tx, fresh, 1);
        await transition(tx.supplierBill, w, ["DRAFT", "REJECTED"], { status: "APPROVED", submittedById: actor.id, submittedAt: now, approvedById: actor.id, approvedAt: now, matchStatus: m.status, exceptions: { list: m.exceptions, grnApplied } as Prisma.InputJsonValue, overrideReason: override && m.exceptions.length ? opts.note : null, statusNote: null }, "supplier bill");
        await log(tx, override && m.exceptions.length ? "Finalized with override" : "Finalized", ` (₹${dec2(fresh.total)})`);
        return { approved: true, exceptions: [] as string[] };
      });
    }
    case "reject":
      requireAnyPermission(actor, ["bills.manage", "bills.approve"]);
      need(opts.note, "Give a reason for rejecting.");
      return db.$transaction(async (tx) => {
        await transition(tx.supplierBill, w, ["PENDING_APPROVAL"], { status: "REJECTED", statusNote: opts.note }, "supplier bill");
        await log(tx, "Rejected");
      });
    case "approve":
      // Legacy pending bills, and bills held for match exceptions.
      requireAnyPermission(actor, ["bills.manage", "bills.approve"]);
      if (opts.override) {
        requirePermission(actor, "bills.override_match", "You do not have permission to override match exceptions.");
        need(opts.note?.trim(), "Give the reason for approving despite the exceptions.");
      }
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${id}::uuid FOR UPDATE`;
        const fresh = await loadScoped(actor, id, tx);
        if (fresh.status !== "PENDING_APPROVAL" || fresh.version !== opts.version) throw new ValidationError("This bill was changed by someone else or is no longer pending approval. Reload and try again.");
        const m = await rematch(tx, fresh, true);
        if (m.exceptions.length && !opts.override) {
          throw new ValidationError(`This bill does not match the purchase order / receipts: ${m.exceptions.map((e) => e.message).join(" ")} Reject it, or approve with an override and a reason.`);
        }
        const grnApplied = await applyBilled(tx, fresh, 1);
        await transition(tx.supplierBill, w, ["PENDING_APPROVAL"], { status: "APPROVED", approvedById: actor.id, approvedAt: new Date(), matchStatus: m.status, exceptions: { list: m.exceptions, grnApplied } as Prisma.InputJsonValue, overrideReason: opts.override && m.exceptions.length ? opts.note : null }, "supplier bill");
        await log(tx, opts.override && m.exceptions.length ? "Approved with override" : "Approved", ` (₹${dec2(fresh.total)})`);
      });
    case "cancel": {
      if (bill.status === "APPROVED") requirePermission(actor, "bills.approve", "You do not have permission to cancel a finalized supplier bill.");
      else requireAnyPermission(actor, ["bills.manage", "bills.approve"]);
      need(opts.note, "Give a reason for cancelling.");
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${id}::uuid FOR UPDATE`;
        const fresh = await loadScoped(actor, id, tx);
        if (cmpMoney(dec2(fresh.paidAmount), "0") > 0) throw new ValidationError("Payments are allocated to this bill. Reverse those allocations first.");
        if (cmpMoney(dec2(fresh.adjustedAmount), "0") > 0) throw new ValidationError("Approved credit/debit notes exist against this bill. Cancel them first.");
        if (fresh.status === "APPROVED") {
          await lockIds(tx, "po_lines", fresh.lines.map((l) => l.poLineId).filter(Boolean) as string[]);
          await lockIds(tx, "grn_lines", fresh.lines.map((l) => l.grnLineId).filter(Boolean) as string[]);
          await applyBilled(tx, fresh, -1);
        }
        await transition(tx.supplierBill, w, ["DRAFT", "PENDING_APPROVAL", "REJECTED", "APPROVED"], { status: "CANCELLED", statusNote: opts.note }, "supplier bill");
        await log(tx, "Cancelled");
      });
    }
  }
}

// ─────────────────────────── Queries ───────────────────────────

const billInclude = {
  project: { select: { id: true, code: true, name: true } },
  party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true } },
  po: { select: { id: true, number: true, status: true, taxMode: true, total: true } },
  createdBy: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  lines: {
    orderBy: { lineNo: "asc" as const },
    include: {
      poLine: { select: { id: true, lineNo: true, rate: true, quantity: true, acceptedQty: true, billedQty: true, unit: true } },
      grnLine: { select: { id: true, acceptedQty: true, billedQty: true, grn: { select: { id: true, number: true } } } },
      itemBrand: { select: { item: { select: { name: true, unit: true } }, brand: { select: { name: true } } } },
    },
  },
  allocations: { orderBy: { allocatedAt: "desc" as const }, include: { payment: { select: { id: true, number: true, paymentDate: true, mode: true, reference: true, status: true } }, allocatedBy: { select: { fullName: true } }, reversedBy: { select: { fullName: true } } } },
  adjustmentNotes: { orderBy: { createdAt: "desc" as const }, select: { id: true, number: true, noteType: true, status: true, total: true, noteDate: true, reason: true } },
} satisfies Prisma.SupplierBillInclude;

export async function getBill(actor: Actor, id: string) {
  requirePermission(actor, "bills.view");
  const b = await db.supplierBill.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.SupplierBillWhereInput] }, include: billInclude });
  if (!b) throw new NotFoundError("Supplier bill");
  const manager = can(actor, "bills.manage") || can(actor, "bills.approve");
  const ex = exceptionsOf(b.exceptions);
  const outstanding = outstandingOf(dec2(b.netPayable), dec2(b.paidAmount), dec2(b.adjustedAmount));
  const payable = ["APPROVED", "PARTIALLY_PAID"].includes(b.status);
  const overdue = payable && !!b.dueDate && b.dueDate < startOfToday();
  return {
    bill: {
      ...b,
      taxable: dec2(b.taxable),
      cgst: dec2(b.cgst),
      sgst: dec2(b.sgst),
      igst: dec2(b.igst),
      charges: dec2(b.charges),
      roundOff: dec2(b.roundOff),
      total: dec2(b.total),
      tdsRate: b.tdsRate ? dec2(b.tdsRate) : null,
      tdsAmount: dec2(b.tdsAmount),
      netPayable: dec2(b.netPayable),
      paidAmount: dec2(b.paidAmount),
      adjustedAmount: dec2(b.adjustedAmount),
      chargesGstRate: dec2(b.chargesGstRate),
      po: b.po ? { ...b.po, total: dec2(b.po.total) } : null,
      exceptionList: ex.list,
      lines: b.lines.map((l) => ({
        ...l,
        quantity: dec3(l.quantity),
        rate: dec4(l.rate),
        discountPct: dec2(l.discountPct),
        gstRate: dec2(l.gstRate),
        taxable: dec2(l.taxable),
        taxAmount: dec2(l.taxAmount),
        total: dec2(l.total),
        poLine: l.poLine ? { ...l.poLine, rate: dec4(l.poLine.rate), quantity: dec3(l.poLine.quantity), acceptedQty: dec3(l.poLine.acceptedQty), billedQty: dec3(l.poLine.billedQty) } : null,
        grnLine: l.grnLine ? { ...l.grnLine, acceptedQty: dec3(l.grnLine.acceptedQty), billedQty: dec3(l.grnLine.billedQty) } : null,
      })),
      allocations: b.allocations.map((a) => ({ ...a, amount: dec2(a.amount) })),
      adjustmentNotes: b.adjustmentNotes.map((n) => ({ ...n, total: dec2(n.total) })),
    },
    outstanding,
    overdue,
    can: {
      edit: can(actor, "bills.manage") && ["DRAFT", "REJECTED"].includes(b.status),
      submit: can(actor, "bills.manage") && ["DRAFT", "REJECTED"].includes(b.status),
      approve: b.status === "PENDING_APPROVAL" && manager,
      override: ["PENDING_APPROVAL", "DRAFT", "REJECTED"].includes(b.status) && manager && can(actor, "bills.override_match"),
      approveBlockedReason: null as string | null,
      cancel: (b.status === "APPROVED" ? can(actor, "bills.approve") : manager) && ["DRAFT", "PENDING_APPROVAL", "REJECTED", "APPROVED"].includes(b.status) && cmpMoney(dec2(b.paidAmount), "0") === 0 && cmpMoney(dec2(b.adjustedAmount), "0") === 0,
      requestChange: !can(actor, "bills.approve") && manager && ["APPROVED", "PARTIALLY_PAID", "PAID"].includes(b.status),
      pay: can(actor, "payments.manage") && payable && cmpMoney(outstanding, "0") > 0,
      note: can(actor, "bills.manage") && payable && cmpMoney(outstanding, "0") > 0,
    },
  };
}

export const billListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  partyId: uuid.optional().catch(undefined),
  view: z.enum(["exceptions", "overdue", "unpaid", "approval"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listBills(actor: Actor, raw: unknown) {
  requirePermission(actor, "bills.view");
  const q = billListQuerySchema.parse(raw ?? {});
  const today = startOfToday();
  const base: Prisma.SupplierBillWhereInput = { AND: [projectScoped(actor) as Prisma.SupplierBillWhereInput, q.projectId ? { projectId: q.projectId } : {}, q.partyId ? { partyId: q.partyId } : {}] };
  const views: Record<string, Prisma.SupplierBillWhereInput> = {
    exceptions: { matchStatus: "EXCEPTION", status: { in: ["DRAFT", "PENDING_APPROVAL", "REJECTED"] } },
    overdue: { status: { in: ["APPROVED", "PARTIALLY_PAID"] }, dueDate: { lt: today } },
    unpaid: { status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
    approval: { status: "PENDING_APPROVAL" },
  };
  const where: Prisma.SupplierBillWhereInput = {
    AND: [
      base,
      q.status ? { status: q.status as Prisma.EnumBillStatusFilter["equals"] } : {},
      q.view ? views[q.view]! : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { supplierInvoiceNo: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }, { po: { number: { contains: q.q, mode: "insensitive" } } }] } : {},
    ],
  };
  const [total, rows, byStatus, exceptions, overdue, unpaid] = await Promise.all([
    db.supplierBill.count({ where }),
    db.supplierBill.findMany({ where, orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { id: true, name: true } }, po: { select: { id: true, number: true } } } }),
    db.supplierBill.groupBy({ by: ["status"], where: base, _count: true }),
    db.supplierBill.count({ where: { AND: [base, views.exceptions!] } }),
    db.supplierBill.aggregate({ where: { AND: [base, views.overdue!] }, _count: true, _sum: { netPayable: true, paidAmount: true, adjustedAmount: true } }),
    db.supplierBill.aggregate({ where: { AND: [base, views.unpaid!] }, _sum: { netPayable: true, paidAmount: true, adjustedAmount: true } }),
  ]);
  const owed = (s: { netPayable: Prisma.Decimal | null; paidAmount: Prisma.Decimal | null; adjustedAmount: Prisma.Decimal | null }) => outstandingOf(dec2(s.netPayable), dec2(s.paidAmount), dec2(s.adjustedAmount));
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    query: q,
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      supplierInvoiceNo: r.supplierInvoiceNo,
      invoiceDate: r.invoiceDate.toISOString(),
      dueDate: r.dueDate?.toISOString() ?? null,
      status: r.status,
      matchStatus: r.matchStatus,
      total: dec2(r.total),
      outstanding: ["APPROVED", "PARTIALLY_PAID"].includes(r.status) ? outstandingOf(dec2(r.netPayable), dec2(r.paidAmount), dec2(r.adjustedAmount)) : "0.00",
      overdue: ["APPROVED", "PARTIALLY_PAID"].includes(r.status) && !!r.dueDate && r.dueDate < today,
      party: r.party,
      project: r.project,
      po: r.po,
    })),
    byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number>,
    exceptions,
    overdueCount: overdue._count,
    overdueValue: owed(overdue._sum),
    unpaidValue: owed(unpaid._sum),
  };
}

export async function billAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "bills.view")) return null;
  const b = await db.supplierBill.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.SupplierBillWhereInput] }, select: { number: true, projectId: true, status: true, supplierInvoiceNo: true } });
  if (!b) return null;
  return { projectId: b.projectId, label: `${b.number} (${b.supplierInvoiceNo})`, canView: true, canUpload: can(actor, "bills.manage") || can(actor, "bills.approve"), locked: !["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(b.status) };
}

/** Purchase orders with something left to bill, for the bill form's PO picker. */
export async function billablePoOptions(actor: Actor) {
  requirePermission(actor, "bills.manage");
  const settings = await getCommercialSettings(actor.organizationId);
  const pos = await db.purchaseOrder.findMany({
    where: { AND: [projectScoped(actor) as Prisma.PurchaseOrderWhereInput, { status: { in: OPEN_PO as Prisma.EnumPoStatusFilter["in"] } }] },
    orderBy: { orderDate: "desc" },
    take: 500,
    select: { id: true, number: true, orderDate: true, total: true, projectId: true, party: { select: { name: true } }, project: { select: { code: true } }, lines: { select: { quantity: true, acceptedQty: true, billedQty: true } } },
  });
  return pos
    .filter((p) => p.lines.some((l) => cmpQty(settings.billMatchMode === "THREE_WAY" ? dec3(l.acceptedQty) : dec3(l.quantity), dec3(l.billedQty)) > 0))
    .map((p) => ({ id: p.id, number: p.number, supplier: p.party.name, projectId: p.projectId, project: p.project?.code ?? null, total: dec2(p.total), orderDate: p.orderDate.toISOString() }));
}

/** Prefill for a bill against a PO: unbilled receipt lines (3-way) or unbilled order lines (2-way), plus live counters for the match preview. */
export async function billPrefillFromPo(actor: Actor, poId: string) {
  requirePermission(actor, "bills.manage");
  const visible = await db.purchaseOrder.findFirst({ where: { AND: [{ id: poId }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, include: { party: { select: { id: true, name: true, gstin: true, stateCode: true, tdsSection: true, tdsRate: true, paymentTermsDays: true } }, project: { select: { id: true, code: true, name: true } }, lines: { orderBy: { lineNo: "asc" }, include: { itemBrand: { select: { item: { select: { name: true } }, brand: { select: { name: true } } } } } } } });
  if (!visible) throw new NotFoundError("Purchase order");
  if (!OPEN_PO.includes(visible.status)) throw new ForbiddenError(`${visible.number} is not approved yet, so it cannot be billed.`);
  const settings = await getCommercialSettings(actor.organizationId);
  const refs = await matchRefs(db, poId);
  const grnByPoLine = new Map<string, (typeof refs.grnLines)[number][]>();
  for (const g of refs.grnLines) if (g.poLineId) grnByPoLine.set(g.poLineId, [...(grnByPoLine.get(g.poLineId) ?? []), g]);
  const lines: { poLineId: string; grnLineId: string | null; itemBrandId: string; description: string; hsnCode: string | null; unit: string; quantity: string; rate: string; discountPct: string; gstRate: string; note: string }[] = [];
  for (const pl of visible.lines) {
    const name = `${pl.itemBrand.item.name} – ${pl.itemBrand.brand.name}`;
    const base = { poLineId: pl.id, itemBrandId: pl.itemBrandId, hsnCode: pl.hsnCode, unit: pl.unit, rate: dec4(pl.rate), discountPct: dec2(pl.discountPct), gstRate: String(Number(pl.gstRate)) };
    if (settings.billMatchMode === "THREE_WAY") {
      for (const g of grnByPoLine.get(pl.id) ?? []) {
        const q = billableQty("THREE_WAY", refs.poLines.find((p) => p.id === pl.id)!, g);
        if (cmpQty(q, "0") > 0) lines.push({ ...base, grnLineId: g.id, description: name, quantity: q, note: `${g.grnNumber}: accepted ${g.acceptedQty}, already billed ${g.billedQty}` });
      }
    } else {
      const q = billableQty("TWO_WAY", refs.poLines.find((p) => p.id === pl.id)!);
      if (cmpQty(q, "0") > 0) lines.push({ ...base, grnLineId: null, description: name, quantity: q, note: `Ordered ${dec3(pl.quantity)}, already billed ${dec3(pl.billedQty)}` });
    }
  }
  return {
    po: { id: visible.id, number: visible.number, taxMode: visible.taxMode, total: dec2(visible.total) },
    project: visible.project,
    party: { ...visible.party, tdsRate: visible.party.tdsRate ? dec2(visible.party.tdsRate) : null },
    mode: settings.billMatchMode,
    rateTolerancePct: settings.rateTolerancePct,
    companyState: settings.stateCode,
    lines,
    poLines: refs.poLines,
    grnLines: refs.grnLines,
    charges: dec2(visible.charges),
    chargesGstRate: dec2(visible.chargesGstRate),
  };
}

/** Open (approved, unpaid) bills of a supplier, oldest due first — for the payment form. */
export async function outstandingBills(actor: Actor, partyId: string, projectId?: string | null, opts: { generalStock?: boolean } = {}) {
  requirePermission(actor, "payments.view");
  const rows = await db.supplierBill.findMany({
    where: { AND: [projectScoped(actor) as Prisma.SupplierBillWhereInput, { partyId, status: { in: ["APPROVED", "PARTIALLY_PAID"] } }, projectId ? { projectId } : opts.generalStock ? { projectId: null } : {}] },
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { invoiceDate: "asc" }],
    select: { id: true, number: true, supplierInvoiceNo: true, invoiceDate: true, dueDate: true, netPayable: true, paidAmount: true, adjustedAmount: true, project: { select: { code: true } } },
  });
  return rows.map((r) => ({ id: r.id, number: r.number, ref: r.supplierInvoiceNo, date: r.invoiceDate.toISOString(), dueDate: r.dueDate?.toISOString() ?? null, net: dec2(r.netPayable), outstanding: outstandingOf(dec2(r.netPayable), dec2(r.paidAmount), dec2(r.adjustedAmount)), project: r.project?.code ?? null })).filter((r) => cmpMoney(r.outstanding, "0") > 0);
}


