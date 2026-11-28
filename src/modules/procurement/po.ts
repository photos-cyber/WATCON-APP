import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addQty, cmpMoney, cmpQty, pctOf, subQty, taxModeFor } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { assertProjectUsable, dec2, dec3, dec4, getCommercialSettings, parseInput, projectScoped, requireAnyPermission, requirePermission, transition } from "@/modules/commercial/core";
import { gstRateField, optMoney, optPct, priceDocument, optionalProjectIdField, qtyField, rateField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { ensureSiteLocation, ensureSystemLocations } from "@/modules/inventory/engine";
import { assertAllocations } from "@/modules/planning/allocation";
import { refreshPrOrderStatus } from "./pr";
import { advanceProjectStatus } from "@/modules/projects/lifecycle";

/**
 * Purchase orders.
 *   DRAFT → PENDING_APPROVAL → APPROVED → SENT → ACKNOWLEDGED → PARTIALLY_RECEIVED → FULLY_RECEIVED → CLOSED
 *   Rejected POs return to editing; cancellation only before any receipt; short-close after.
 *   Amendment of an approved PO snapshots the current version (po_revisions) and needs re-approval;
 *   received / billed quantities are preserved and a line can never drop below them.
 */

const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
const optId = uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null));

const poLineSchema = z.object({
  id: optId,
  itemBrandId: uuid,
  description: optionalText("Description", 300),
  quantity: qtyField,
  rate: rateField,
  discountPct: optPct,
  gstRate: gstRateField,
  prLineId: optId,
  quotationLineId: optId,
  /** Planning requirement this line is allocated to (project or general inventory). */
  requirementId: optId,
});

export const poSchema = z.object({
  projectId: optionalProjectIdField,
  partyId: uuid,
  deliveryLocationId: optId,
  deliveryAddress: optionalText("Delivery address", 500),
  orderDate: dateString,
  expectedDate: optDate,
  paymentTerms: optionalText("Payment terms", 500),
  advanceAmount: optMoney,
  /** Structured supplier terms (from the awarded quotation, or entered on the PO). */
  advancePct: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.null(), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Percent.").refine((v) => Number(v) <= 100, "Max 100%.")])),
  creditDays: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().int().min(0).max(365)])),
  warranty: optionalText("Warranty", 300),
  paymentMilestones: z.unknown().optional(),
  terms: optionalText("Terms", 5000),
  internalRemarks: optionalText("Internal remarks", 1000),
  charges: optMoney,
  chargesGstRate: optPct,
  roundToRupee: z.boolean().default(true),
  rfqId: optId,
  prId: optId,
  lines: z.array(poLineSchema).min(1, "Add at least one line.").max(200),
});
export type PoInput = z.input<typeof poSchema>;

const OPEN_FOR_RECEIPT = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] as const;
const AMENDABLE = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] as const;

export const poInclude = {
  project: { select: { id: true, code: true, name: true } },
  party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true } },
  deliveryLocation: { select: { id: true, name: true, address: true, type: true } },
  createdBy: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  rfq: { select: { id: true, number: true } },
  pr: { select: { id: true, number: true } },
  lines: { orderBy: { lineNo: "asc" as const }, include: { itemBrand: { select: { id: true, item: { select: { id: true, code: true, name: true, unit: true, hsnCode: true } }, brand: { select: { id: true, name: true } } } }, requirement: { select: { id: true, project: { select: { id: true, code: true } } } } } },
  revisions: { orderBy: { revision: "desc" as const }, include: { createdBy: { select: { fullName: true } } } },
  grns: { select: { id: true, number: true, status: true, receiptDate: true }, orderBy: { createdAt: "desc" as const } },
  bills: { select: { id: true, number: true, supplierInvoiceNo: true, status: true, total: true, paidAmount: true, netPayable: true, adjustedAmount: true }, orderBy: { createdAt: "desc" as const } },
  payments: { where: { status: "POSTED" }, select: { id: true, number: true, amount: true, allocatedAmount: true, paymentDate: true }, orderBy: { paymentDate: "asc" as const } },
} satisfies Prisma.PurchaseOrderInclude;

async function loadScoped(actor: Actor, id: string, client: Tx | typeof db = db) {
  const po = await client.purchaseOrder.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, include: { lines: true } });
  if (!po) throw new NotFoundError("Purchase order");
  return po;
}

/** Prices and validates the lines; returns header totals and line rows ready to persist. */
async function buildPo(tx: Tx, actor: Actor, data: z.output<typeof poSchema>) {
  const party = await tx.party.findFirst({ where: { id: data.partyId, organizationId: actor.organizationId } });
  if (!party || !party.isSupplier) throw new ValidationError("Choose a supplier.", { partyId: "Not a supplier." });
  if (party.status !== "ACTIVE") throw new ValidationError("This supplier is inactive.", { partyId: "Inactive supplier." });
  const settings = await getCommercialSettings(actor.organizationId, tx);
  const mode = taxModeFor(settings.stateCode, party.stateCode);
  const ibs = await tx.itemBrand.findMany({ where: { id: { in: [...new Set(data.lines.map((l) => l.itemBrandId))] }, organizationId: actor.organizationId }, include: { item: { select: { unit: true, hsnCode: true, status: true, name: true } }, brand: { select: { status: true } } } });
  const map = new Map(ibs.map((i) => [i.id, i]));
  data.lines.forEach((l, i) => {
    const ib = map.get(l.itemBrandId);
    if (!ib) throw new ValidationError("Item–brand not found.", { [`lines.${i}.itemBrandId`]: "Not found." });
    if (ib.item.status !== "ACTIVE" || ib.brand.status !== "ACTIVE") throw new ValidationError(`${ib.item.name} is inactive.`, { [`lines.${i}.itemBrandId`]: "Inactive item or brand." });
  });
  const priced = priceDocument(data.lines, mode, { charges: data.charges, chargesGstRate: data.chargesGstRate, roundToRupee: data.roundToRupee });
  let locationId = data.deliveryLocationId;
  if (locationId) {
    const loc = await tx.stockLocation.findFirst({ where: { id: locationId, organizationId: actor.organizationId, status: "ACTIVE", type: { in: ["WAREHOUSE", "SITE"] } } });
    if (!loc) throw new ValidationError("Choose an active delivery location.", { deliveryLocationId: "Invalid location." });
    if (loc.type === "SITE" && loc.projectId !== data.projectId) throw new ValidationError("Deliveries to a project site must be raised for that project.", { deliveryLocationId: "Site belongs to another project." });
  } else {
    locationId = data.projectId ? await ensureSiteLocation(tx, actor.organizationId, data.projectId) : (await ensureSystemLocations(tx, actor.organizationId)).WAREHOUSE;
  }
  const header = {
    projectId: data.projectId,
    partyId: party.id,
    deliveryLocationId: locationId,
    deliveryAddress: data.deliveryAddress,
    orderDate: toDbDate(data.orderDate)!,
    expectedDate: toDbDate(data.expectedDate),
    paymentTerms: data.paymentTerms ?? (party.paymentTermsDays !== null ? `${party.paymentTermsDays} days from invoice` : null),
    // An advance % from the supplier's terms sets the advance amount unless one was entered.
    advanceAmount: cmpMoney(data.advanceAmount, "0") === 0 && data.advancePct ? pctOf(priced.totals.total, data.advancePct) : data.advanceAmount,
    advancePct: data.advancePct,
    creditDays: data.creditDays ?? party.paymentTermsDays ?? null,
    warranty: data.warranty,
    paymentMilestones: Array.isArray(data.paymentMilestones) ? (data.paymentMilestones as Prisma.InputJsonValue) : undefined,
    terms: data.terms ?? settings.poTerms,
    internalRemarks: data.internalRemarks,
    taxMode: mode,
    placeOfSupply: settings.stateCode,
    taxable: priced.totals.taxable,
    discountTotal: priced.totals.discount,
    cgst: priced.totals.cgst,
    sgst: priced.totals.sgst,
    igst: priced.totals.igst,
    charges: priced.totals.charges,
    chargesGstRate: data.chargesGstRate,
    roundOff: priced.totals.roundOff,
    total: priced.totals.total,
    rfqId: data.rfqId,
    prId: data.prId,
  };
  const lines = priced.lines.map((l, i) => {
    const ib = map.get(l.itemBrandId)!;
    return { id: l.id, lineNo: i + 1, itemBrandId: l.itemBrandId, itemId: ib.itemId, description: l.description, hsnCode: ib.item.hsnCode, unit: ib.item.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax, total: l.amounts.total, prLineId: l.prLineId, quotationLineId: l.quotationLineId, requirementId: l.requirementId };
  });
  if (Number(data.advanceAmount) > Number(priced.totals.total)) throw new ValidationError("Advance cannot exceed the order value.", { advanceAmount: "More than the PO total." });
  return { header, lines, party };
}

/** Adjusts PR ordered quantities by delta (+ on order, − on cancel/short-close); never above the requisitioned quantity. */
async function applyPrOrdered(tx: Tx, deltas: Map<string, string>) {
  const prIds = new Set<string>();
  for (const [prLineId, delta] of deltas) {
    if (cmpQty(delta, "0") === 0) continue;
    const [line] = await tx.$queryRaw<{ quantity: string; ordered_qty: string; pr_id: string }[]>`SELECT quantity::text, ordered_qty::text, pr_id::text FROM pr_lines WHERE id = ${prLineId}::uuid FOR UPDATE`;
    if (!line) throw new ValidationError("A linked requisition line no longer exists.");
    const next = addQty(line.ordered_qty, delta);
    if (cmpQty(next, line.quantity) > 0) throw new ValidationError(`This order would exceed the requisitioned quantity (${line.quantity}, already ordered ${line.ordered_qty}). Reduce the quantity or raise a new requisition.`);
    if (cmpQty(next, "0") < 0) continue;
    await tx.prLine.update({ where: { id: prLineId }, data: { orderedQty: next } });
    prIds.add(line.pr_id);
  }
  for (const id of prIds) await refreshPrOrderStatus(tx, id);
}

async function assertPrLinesUsable(tx: Tx, actor: Actor, lines: { prLineId: string | null; requirementId: string | null }[]) {
  const ids = lines.map((l) => l.prLineId).filter(Boolean) as string[];
  if (!ids.length) return;
  const rows = await tx.prLine.findMany({ where: { id: { in: ids } }, select: { id: true, requirementId: true, pr: { select: { organizationId: true, status: true, number: true } } } });
  if (rows.length !== new Set(ids).size || rows.some((r) => r.pr.organizationId !== actor.organizationId)) throw new ValidationError("A linked requisition line was not found.");
  const bad = rows.find((r) => !["APPROVED", "PARTIALLY_ORDERED", "ORDERED"].includes(r.pr.status));
  if (bad) throw new ValidationError(`Requisition ${bad.pr.number} is not approved.`);
  // A line ordered from a requisition line is allocated to the requisition line's requirement.
  const req = new Map(rows.map((r) => [r.id, r.requirementId]));
  for (const l of lines) if (l.prLineId) l.requirementId = req.get(l.prLineId) ?? null;
}

export async function createPo(actor: Actor, input: unknown, existingTx?: Tx) {
  requirePermission(actor, "po.create");
  const data = parseInput(poSchema, input);
  const project = data.projectId ? await assertProjectUsable(actor, data.projectId) : null;
  const create = async (tx: Tx) => {
    const { header, lines, party } = await buildPo(tx, actor, data);
    await assertPrLinesUsable(tx, actor, lines);
    await assertAllocations(tx, actor.organizationId, { projectId: header.projectId, label: "This purchase order" }, lines);
    const number = await nextDocNumber(tx, actor.organizationId, "PO", header.orderDate);
    const po = await tx.purchaseOrder.create({ data: { organizationId: actor.organizationId, number, ...header, createdById: actor.id, lines: { create: lines.map(({ id: _id, ...l }) => l) } } });
    await applyPrOrdered(tx, new Map(lines.filter((l) => l.prLineId).map((l) => [l.prLineId!, l.quantity])));
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "po.created", entityType: "purchase_order", entityId: po.id, projectId: po.projectId, summary: `Created PO ${number} for ${party.name}${project ? ` (${project.code})` : " (central store)"} – ₹${header.total}` }, tx);
    return po;
  };
  return existingTx ? create(existingTx) : db.$transaction(create);
}

/** Edits a draft / rejected PO, or an amendment draft (revision > 0). Lines are matched by id so receipt history is kept. */
export async function updatePo(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "po.create");
  const data = parseInput(poSchema, input);
  const before = await loadScoped(actor, id);
  if (!["DRAFT", "REJECTED"].includes(before.status)) throw new ValidationError("Only draft or rejected purchase orders can be edited. Use Amend for approved orders.");
  if (data.projectId) await assertProjectUsable(actor, data.projectId);
  if (before.revision > 0 && (data.partyId !== before.partyId || data.projectId !== before.projectId)) throw new ValidationError("Supplier and project cannot change in an amendment. Cancel / short-close and raise a new PO.");
  return db.$transaction(async (tx) => {
    const { header, lines } = await buildPo(tx, actor, data);
    const existing = new Map(before.lines.map((l) => [l.id, l]));
    // Keep a line's planning allocation when the form does not send it back.
    for (const l of lines) if (!l.requirementId && l.id) l.requirementId = existing.get(l.id)?.requirementId ?? null;
    await assertPrLinesUsable(tx, actor, lines);
    await assertAllocations(tx, actor.organizationId, { projectId: header.projectId, label: "This purchase order" }, lines, { poId: id });
    const kept = new Set<string>();
    const prDelta = new Map<string, string>();
    const bump = (k: string | null, d: string) => k && prDelta.set(k, addQty(prDelta.get(k) ?? "0", d));
    // Park current lines on temporary numbers so the final order can follow the form without unique clashes.
    for (const old of before.lines) await tx.poLine.update({ where: { id: old.id }, data: { lineNo: 5000 + old.lineNo } });
    for (const l of lines) {
      const old = l.id ? existing.get(l.id) : undefined;
      if (l.id && !old) throw new ValidationError("A line does not belong to this purchase order.");
      const { id: _id, ...rest } = l;
      if (old) {
        kept.add(old.id);
        const floor = cmpQty(dec3(old.receivedQty), dec3(old.billedQty)) >= 0 ? dec3(old.receivedQty) : dec3(old.billedQty);
        if (cmpQty(l.quantity, floor) < 0) throw new ValidationError(`Line ${l.lineNo}: quantity cannot be below what was already received / billed (${floor}).`, { [`lines.${l.lineNo - 1}.quantity`]: `Minimum ${floor}.` });
        if (old.itemBrandId !== l.itemBrandId && (cmpQty(dec3(old.receivedQty), "0") > 0 || cmpQty(dec3(old.billedQty), "0") > 0)) throw new ValidationError(`Line ${l.lineNo}: the item of a received or billed line cannot change.`);
        bump(old.prLineId, `-${dec3(old.quantity)}`);
        bump(l.prLineId, l.quantity);
        await tx.poLine.update({ where: { id: old.id }, data: rest });
      } else {
        bump(l.prLineId, l.quantity);
        await tx.poLine.create({ data: { ...rest, poId: id } });
      }
    }
    for (const old of before.lines) {
      if (kept.has(old.id)) continue;
      if (cmpQty(dec3(old.receivedQty), "0") > 0 || cmpQty(dec3(old.billedQty), "0") > 0) throw new ValidationError(`Line ${old.lineNo} has receipts or bills and cannot be removed.`);
      bump(old.prLineId, `-${dec3(old.quantity)}`);
      await tx.poLine.delete({ where: { id: old.id } });
    }
    await transition(tx.purchaseOrder, { id, organizationId: actor.organizationId, version }, ["DRAFT", "REJECTED"], { ...header, status: "DRAFT", statusNote: null }, "purchase order");
    await applyPrOrdered(tx, prDelta);
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "po.updated", entityType: "purchase_order", entityId: id, projectId: header.projectId, summary: `Edited PO ${before.number}${before.revision ? ` (amendment ${before.revision})` : ""} – ₹${header.total}` }, tx);
  });
}

export type PoAction = "finalize" | "submit" | "approve" | "reject" | "send" | "acknowledge" | "amend" | "cancel" | "close";

export async function poAction(actor: Actor, id: string, action: PoAction, opts: { version: number; note?: string | null; via?: string | null }) {
  const po = await loadScoped(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string, extra = "") => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `po.${action}`, entityType: "purchase_order", entityId: id, projectId: po.projectId, summary: `${verb} PO ${po.number}${extra}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new ValidationError(msg, { note: msg });
  };

  switch (action) {
    case "finalize":
    case "submit": {
      // Simplified workflow: finalizing a PO approves it in one step for any po.create user —
      // no second approver, no separation of duties, no amount limit. "submit" is kept as an alias.
      requireAnyPermission(actor, ["po.create", "po.approve"]);
      return db.$transaction(async (tx) => {
        const now = new Date();
        // A re-finalized amendment keeps its receipt progress.
        const anyReceived = po.lines.some((l) => cmpQty(dec3(l.receivedQty), "0") > 0);
        const fully = po.lines.every((l) => cmpQty(dec3(l.acceptedQty), dec3(l.quantity)) >= 0);
        const status = anyReceived ? (fully ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED") : "APPROVED";
        await transition(tx.purchaseOrder, w, ["DRAFT", "REJECTED"], { status, submittedById: actor.id, submittedAt: now, approvedById: actor.id, approvedAt: now, statusNote: null }, "purchase order");
        await log(tx, "Finalized", ` (₹${dec2(po.total)})`);
        await advanceProjectStatus(tx, po.projectId, actor.id);
        return { approved: true };
      });
    }
    case "approve":
    case "reject": {
      // Only for POs left waiting under the old two-step approval.
      requireAnyPermission(actor, ["po.create", "po.approve"]);
      if (action === "reject") need(opts.note, "Give a reason for rejecting.");
      return db.$transaction(async (tx) => {
        const anyReceived = po.lines.some((l) => cmpQty(dec3(l.receivedQty), "0") > 0);
        const fully = po.lines.every((l) => cmpQty(dec3(l.acceptedQty), dec3(l.quantity)) >= 0);
        const status = action === "reject" ? "REJECTED" : anyReceived ? (fully ? "FULLY_RECEIVED" : "PARTIALLY_RECEIVED") : "APPROVED";
        await transition(tx.purchaseOrder, w, ["PENDING_APPROVAL"], action === "approve" ? { status, approvedById: actor.id, approvedAt: new Date() } : { status, statusNote: opts.note }, "purchase order");
        await log(tx, action === "approve" ? "Approved" : "Rejected", action === "approve" ? ` (₹${dec2(po.total)})` : "");
        if (action === "approve") await advanceProjectStatus(tx, po.projectId, actor.id);
      });
    }
    case "send":
      requirePermission(actor, "po.create");
      return db.$transaction(async (tx) => {
        await transition(tx.purchaseOrder, w, ["APPROVED"], { status: "SENT", sentAt: new Date() }, "purchase order");
        await log(tx, "Marked sent", opts.via ? ` via ${opts.via}` : "");
      });
    case "acknowledge":
      requirePermission(actor, "po.create");
      return db.$transaction(async (tx) => {
        await transition(tx.purchaseOrder, w, ["SENT", "APPROVED"], { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgementRef: opts.note ?? null }, "purchase order");
        await log(tx, "Recorded supplier acknowledgement for");
      });
    case "amend":
      requirePermission(actor, "po.approve", "You do not have permission to amend a finalized purchase order.");
      need(opts.note, "Give the reason for the amendment.");
      return db.$transaction(async (tx) => {
        const full = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
        await tx.poRevision.create({ data: { poId: id, revision: full.revision, snapshot: JSON.parse(JSON.stringify(full)) as Prisma.InputJsonValue, reason: opts.note!, createdById: actor.id } });
        await transition(tx.purchaseOrder, w, AMENDABLE, { status: "DRAFT", revision: { increment: 1 }, approvedById: null, approvedAt: null, submittedById: null, submittedAt: null, statusNote: `Amendment ${full.revision + 1}: ${opts.note}` }, "purchase order");
        await log(tx, "Opened amendment", ` ${full.revision + 1} of`);
      });
    case "cancel": {
      if (["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(po.status)) requireAnyPermission(actor, ["po.create", "po.cancel"]);
      else requirePermission(actor, "po.cancel", "You do not have permission to cancel a finalized purchase order.");
      need(opts.note, "Give a reason for cancelling.");
      if (po.lines.some((l) => cmpQty(dec3(l.receivedQty), "0") > 0)) throw new ValidationError("Material has already been received against this PO, so it cannot be cancelled. Use Short-close to stop further deliveries.");
      if (po.lines.some((l) => cmpQty(dec3(l.billedQty), "0") > 0)) throw new ValidationError("Supplier bills exist against this PO. Cancel those bills first.");
      const pendingGrns = await db.grn.count({ where: { poId: id, status: { in: ["DRAFT", "SUBMITTED"] } } });
      if (pendingGrns) throw new ValidationError("There are site receipts in progress for this PO. Reject or cancel them first.");
      return db.$transaction(async (tx) => {
        await transition(tx.purchaseOrder, w, ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT", "ACKNOWLEDGED"], { status: "CANCELLED", statusNote: opts.note, closedAt: new Date() }, "purchase order");
        await applyPrOrdered(tx, new Map(po.lines.filter((l) => l.prLineId).map((l) => [l.prLineId!, `-${dec3(l.quantity)}`])));
        await log(tx, "Cancelled");
      });
    }
    case "close": {
      requirePermission(actor, "po.cancel", "You do not have permission to short-close a purchase order.");
      need(opts.note, "Give a reason for closing.");
      return db.$transaction(async (tx) => {
        await transition(tx.purchaseOrder, w, ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED"], { status: "CLOSED", statusNote: opts.note, closedAt: new Date() }, "purchase order");
        // Unreceived quantity is released back to the requisition so it can be re-ordered.
        await applyPrOrdered(tx, new Map(po.lines.filter((l) => l.prLineId && cmpQty(dec3(l.quantity), dec3(l.acceptedQty)) > 0).map((l) => [l.prLineId!, `-${subQty(dec3(l.quantity), dec3(l.acceptedQty))}`])));
        await log(tx, "Short-closed");
      });
    }
  }
}

/** Called by GRN posting / reversal: derives the receipt status from line counters. */
export async function refreshPoReceiptStatus(tx: Tx, poId: string) {
  const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } });
  if (!po || !["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "PENDING_APPROVAL"].includes(po.status)) return;
  if (po.status === "PENDING_APPROVAL") return;
  const any = po.lines.some((l) => cmpQty(dec3(l.receivedQty), "0") > 0);
  const full = po.lines.every((l) => cmpQty(dec3(l.acceptedQty), dec3(l.quantity)) >= 0);
  const status = full ? "FULLY_RECEIVED" : any ? "PARTIALLY_RECEIVED" : po.sentAt ? (po.acknowledgedAt ? "ACKNOWLEDGED" : "SENT") : "APPROVED";
  if (status !== po.status) await tx.purchaseOrder.update({ where: { id: poId }, data: { status, version: { increment: 1 } } });
}

export function isOpenForReceipt(status: string, allowUnapproved: boolean) {
  return (OPEN_FOR_RECEIPT as readonly string[]).includes(status) || (allowUnapproved && status === "PENDING_APPROVAL");
}

// ─────────────────────────── Queries ───────────────────────────

export async function getPo(actor: Actor, id: string) {
  requirePermission(actor, "po.view");
  const po = await db.purchaseOrder.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, include: poInclude });
  if (!po) throw new NotFoundError("Purchase order");
  const settings = await getCommercialSettings(actor.organizationId);
  const anyReceived = po.lines.some((l) => cmpQty(dec3(l.receivedQty), "0") > 0);
  const paid = po.bills.filter((b) => b.status !== "CANCELLED").reduce((a, b) => a + Number(b.paidAmount), 0);
  // Financial position (workflow: PO drives the supplier side). The PO is a commitment, not a payable;
  // only finalized supplier bills are liabilities. Each rupee once: bill payments + unallocated PO advance.
  const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
  const lineShare = (l: (typeof po.lines)[number], q: number) => (Number(l.quantity) > 0 ? (Number(l.total) * Math.min(q, Number(l.quantity))) / Number(l.quantity) : 0);
  const receivedValue = po.lines.reduce((a, l) => a + lineShare(l, Number(l.acceptedQty)), 0);
  const pendingValue = po.lines.reduce((a, l) => a + lineShare(l, Math.max(0, Number(l.quantity) - Number(l.acceptedQty))), 0);
  const finalBills = po.bills.filter((b) => ["APPROVED", "PARTIALLY_PAID", "PAID"].includes(b.status));
  const billed = finalBills.reduce((a, b) => a + Number(b.total), 0);
  const billPaid = finalBills.reduce((a, b) => a + Number(b.paidAmount), 0);
  const billAdjusted = finalBills.reduce((a, b) => a + Number(b.adjustedAmount), 0);
  const outstanding = finalBills.reduce((a, b) => a + Math.max(0, Number(b.netPayable) - Number(b.paidAmount) - Number(b.adjustedAmount)), 0);
  const advance = po.payments.reduce((a, p) => a + Number(p.amount) - Number(p.allocatedAmount), 0);
  const financial = po.status === "CANCELLED" || ["DRAFT", "PENDING_APPROVAL", "REJECTED"].includes(po.status)
    ? null
    : {
        poValue: dec2(po.total),
        receivedValue: r2(receivedValue),
        pendingValue: r2(pendingValue),
        billed: r2(billed),
        paid: r2(billPaid + advance),
        advance: r2(advance),
        outstanding: r2(outstanding),
        unbilledCommitment: r2(Math.max(0, Number(po.total) - billed)),
        remainingPayment: r2(Math.max(0, Number(po.total) - billPaid - billAdjusted - advance)),
        heldBills: po.bills.filter((b) => b.status === "PENDING_APPROVAL").length,
      };
  return {
    financial,
    po: {
      ...po,
      total: dec2(po.total),
      taxable: dec2(po.taxable),
      cgst: dec2(po.cgst),
      sgst: dec2(po.sgst),
      igst: dec2(po.igst),
      charges: dec2(po.charges),
      roundOff: dec2(po.roundOff),
      discountTotal: dec2(po.discountTotal),
      advanceAmount: dec2(po.advanceAmount),
      lines: po.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), taxable: dec2(l.taxable), taxAmount: dec2(l.taxAmount), total: dec2(l.total), receivedQty: dec3(l.receivedQty), acceptedQty: dec3(l.acceptedQty), rejectedQty: dec3(l.rejectedQty), returnedQty: dec3(l.returnedQty), billedQty: dec3(l.billedQty), pendingQty: cmpQty(dec3(l.quantity), dec3(l.acceptedQty)) > 0 ? subQty(dec3(l.quantity), dec3(l.acceptedQty)) : "0" })),
      bills: po.bills.map((b) => ({ ...b, total: dec2(b.total), paidAmount: dec2(b.paidAmount) })),
      payments: po.payments.map((p) => ({ ...p, amount: dec2(p.amount), unallocated: (Number(p.amount) - Number(p.allocatedAmount)).toFixed(2) })),
    },
    paidToDate: paid.toFixed(2),
    /** Paid against this PO but not yet set against its bills (supplier advance). */
    advanceOnPo: po.payments.reduce((a, p) => a + Number(p.amount) - Number(p.allocatedAmount), 0).toFixed(2),
    can: {
      edit: can(actor, "po.create") && ["DRAFT", "REJECTED"].includes(po.status),
      submit: can(actor, "po.create") && ["DRAFT", "REJECTED"].includes(po.status),
      finalize: can(actor, "po.create") && ["DRAFT", "REJECTED"].includes(po.status),
      /** Finalize always makes the PO final in one step (simplified workflow). */
      finalizeApproves: can(actor, "po.create") && ["DRAFT", "REJECTED"].includes(po.status),
      approve: po.status === "PENDING_APPROVAL" && (can(actor, "po.create") || can(actor, "po.approve")),
      approveBlockedReason: null as string | null,
      send: can(actor, "po.create") && po.status === "APPROVED",
      acknowledge: can(actor, "po.create") && ["SENT", "APPROVED"].includes(po.status),
      amend: can(actor, "po.approve") && (AMENDABLE as readonly string[]).includes(po.status),
      cancel: !anyReceived && (["DRAFT", "PENDING_APPROVAL", "REJECTED"].includes(po.status) ? can(actor, "po.create") || can(actor, "po.cancel") : can(actor, "po.cancel") && ["APPROVED", "SENT", "ACKNOWLEDGED"].includes(po.status)),
      close: can(actor, "po.cancel") && ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED"].includes(po.status),
      /** Finalized: users who cannot amend / cancel it themselves ask the Super Admin. */
      requestChange: !can(actor, "po.approve") && can(actor, "po.create") && !["DRAFT", "REJECTED", "CANCELLED", "CLOSED"].includes(po.status),
      receive: can(actor, "grn.create") && isOpenForReceipt(po.status, settings.allowReceiptOnUnapprovedPo),
      bill: can(actor, "bills.manage") && ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"].includes(po.status),
      pay: can(actor, "payments.manage") && !["DRAFT", "PENDING_APPROVAL", "REJECTED", "CANCELLED"].includes(po.status),
    },
  };
}

export const poListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  partyId: uuid.optional().catch(undefined),
  pending: z.enum(["1"]).optional().catch(undefined),
  from: dateString.optional().catch(undefined),
  to: dateString.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export function poWhere(actor: Actor, q: z.output<typeof poListQuerySchema>): Prisma.PurchaseOrderWhereInput {
  return {
    AND: [
      projectScoped(actor) as Prisma.PurchaseOrderWhereInput,
      q.status ? { status: q.status as Prisma.EnumPoStatusFilter["equals"] } : {},
      q.pending ? { status: { in: [...OPEN_FOR_RECEIPT] } } : {},
      q.projectId ? { projectId: q.projectId } : {},
      q.partyId ? { partyId: q.partyId } : {},
      q.from ? { orderDate: { gte: toDbDate(q.from)! } } : {},
      q.to ? { orderDate: { lte: toDbDate(q.to)! } } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }, { lines: { some: { itemBrand: { item: { name: { contains: q.q, mode: "insensitive" } } } } } }] } : {},
    ],
  };
}

export async function listPos(actor: Actor, raw: unknown) {
  requirePermission(actor, "po.view");
  const q = poListQuerySchema.parse(raw ?? {});
  const where = poWhere(actor, q);
  const base: Prisma.PurchaseOrderWhereInput = { AND: [projectScoped(actor) as Prisma.PurchaseOrderWhereInput, q.projectId ? { projectId: q.projectId } : {}] };
  const [total, rows, byStatus, value] = await Promise.all([
    db.purchaseOrder.count({ where }),
    db.purchaseOrder.findMany({ where, orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { id: true, name: true } } } }),
    db.purchaseOrder.groupBy({ by: ["status"], where: base, _count: true, _sum: { total: true } }),
    db.purchaseOrder.aggregate({ where, _sum: { total: true } }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, query: q, rows: rows.map((r) => ({ ...r, total: dec2(r.total) })), byStatus: Object.fromEntries(byStatus.map((b) => [b.status, { count: b._count, total: dec2(b._sum.total) }])) as Record<string, { count: number; total: string }>, filteredValue: dec2(value._sum.total) };
}

export async function poAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "po.view")) return null;
  const po = await db.purchaseOrder.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, select: { number: true, projectId: true, status: true } });
  if (!po) return null;
  return { projectId: po.projectId, label: po.number, canView: true, canUpload: can(actor, "po.create") || can(actor, "po.approve"), locked: !["DRAFT", "REJECTED"].includes(po.status) };
}

/** Rows for the "new PO from requisition" prefill: open quantity per approved PR line. */
export async function prefillFromPr(actor: Actor, prId: string) {
  requirePermission(actor, "po.create");
  const pr = await db.purchaseRequisition.findFirst({ where: { AND: [{ id: prId }, projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput] }, include: { lines: { orderBy: { lineNo: "asc" }, include: { itemBrand: { select: { lastPurchaseRate: true, preferredSupplierId: true, item: { select: { gstRate: true } } } } } } } });
  if (!pr) throw new NotFoundError("Requisition");
  if (!["APPROVED", "PARTIALLY_ORDERED"].includes(pr.status)) throw new ForbiddenError("Only approved requisitions can be ordered.");
  return {
    projectId: pr.projectId,
    prId: pr.id,
    deliveryLocationId: pr.deliveryLocationId,
    expectedDate: pr.requiredBy ? pr.requiredBy.toISOString().slice(0, 10) : "",
    partyId: pr.lines.find((l) => l.itemBrand.preferredSupplierId)?.itemBrand.preferredSupplierId ?? null,
    lines: pr.lines
      .filter((l) => cmpQty(dec3(l.quantity), dec3(l.orderedQty)) > 0)
      .map((l) => ({ itemBrandId: l.itemBrandId, quantity: subQty(dec3(l.quantity), dec3(l.orderedQty)), rate: l.itemBrand.lastPurchaseRate ? dec4(l.itemBrand.lastPurchaseRate) : "", discountPct: "0", gstRate: l.itemBrand.item.gstRate ? String(Number(l.itemBrand.item.gstRate)) : "18", prLineId: l.id, description: l.notes ?? "" })),
  };
}
