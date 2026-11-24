import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addMoney, addQty, cmpMoney, cmpQty, divRound, fmtMoney, lineAmounts, money, qtyUnits, subQty, taxModeFor, unitRate } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { approvalHint, assertCanApprove, assertProjectUsable, dec2, dec3, dec4, getCommercialSettings, parseInput, projectScoped, requirePermission, transition } from "@/modules/commercial/core";
import { gstRateField, optMoney, optPct, projectIdField, qtyField, rateField } from "@/modules/commercial/pricing";
import { milestonesSchema } from "@/modules/commercial/payment-terms";
import type { EntityAccess } from "@/modules/documents/access";
import { startOfToday } from "@/modules/tasks/rules";
import { createPo } from "./po";
import { supplierPerformance } from "./performance";

/**
 * Rate enquiries: requirement → RFQ → supplier quotations (manual entry, revisions) →
 * line-wise comparison (price, landed cost, lead time, reliability) → proposed award
 * (split allowed) → award approval → one draft PO per awarded supplier.
 */

const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
const optId = uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null));

export const rfqSchema = z.object({
  projectId: projectIdField,
  prId: optId,
  title: text("Title", 200, 3),
  deliveryLocationId: optId,
  deliveryAddress: optionalText("Delivery address", 500),
  requiredBy: optDate,
  responseDue: optDate,
  paymentTerms: optionalText("Payment terms", 300),
  freightTerms: optionalText("Freight terms", 300),
  taxTerms: optionalText("Tax terms", 300),
  validityDays: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().int().min(1).max(365)])),
  specifications: optionalText("Specifications", 5000),
  supplierIds: z.array(uuid).min(1, "Invite at least one supplier."),
  lines: z
    .array(z.object({ itemId: uuid, itemBrandId: optId, acceptableBrands: optionalText("Acceptable brands", 300), quantity: qtyField, specifications: optionalText("Specifications", 500), prLineId: optId }))
    .min(1, "Add at least one material.")
    .max(200),
});

export const quotationSchema = z.object({
  rfqId: uuid,
  partyId: uuid,
  supplierRef: optionalText("Supplier reference", 80),
  quoteDate: dateString,
  validUntil: optDate,
  freight: optMoney,
  freightGstRate: optPct,
  paymentTerms: optionalText("Payment terms", 300),
  deliveryDays: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().int().min(0).max(365)])),
  remarks: optionalText("Remarks", 1000),
  replacesId: optId,
  advancePct: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.null(), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Percent.").refine((v) => Number(v) <= 100, "Max 100%.")])),
  creditDays: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().int().min(0).max(365)])),
  warranty: optionalText("Warranty", 300),
  paymentMilestones: milestonesSchema.optional().nullable().transform((v) => (v && v.length ? v : null)),
  lines: z
    .array(z.object({ rfqLineId: uuid, itemBrandId: uuid, quantity: qtyField, rate: rateField, discountPct: optPct, gstRate: gstRateField, leadTimeDays: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().int().min(0).max(365)])), remarks: optionalText("Remarks", 300), paymentTerms: optionalText("Item payment terms", 300) }))
    .min(1, "Quote at least one line.")
    .max(200),
});

async function loadRfq(actor: Actor, id: string, client: Tx | typeof db = db) {
  const r = await client.rfq.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.RfqWhereInput] }, include: { lines: true, suppliers: true } });
  if (!r) throw new NotFoundError("Rate enquiry");
  return r;
}

export async function createRfq(actor: Actor, input: unknown) {
  requirePermission(actor, "rfq.manage");
  const data = parseInput(rfqSchema, input);
  if (data.projectId) await assertProjectUsable(actor, data.projectId);
  return db.$transaction(async (tx) => {
    if (data.deliveryLocationId) {
      const location = await tx.stockLocation.findFirst({ where: { id: data.deliveryLocationId, organizationId: actor.organizationId, status: "ACTIVE", type: { in: ["WAREHOUSE", "SITE"] } } });
      if (!location || (location.type === "SITE" && location.projectId !== data.projectId)) throw new ValidationError("Choose an active delivery location for this project.", { deliveryLocationId: "Invalid location." });
    }
    const pr = data.prId ? await tx.purchaseRequisition.findFirst({ where: { AND: [{ id: data.prId }, projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput] }, include: { lines: { include: { itemBrand: { select: { itemId: true } } } } } }) : null;
    if (data.prId && (!pr || pr.projectId !== data.projectId || !["APPROVED", "PARTIALLY_ORDERED"].includes(pr.status))) throw new ValidationError("Choose an approved requisition for this project.", { prId: "Invalid requisition." });
    const brands = await tx.itemBrand.findMany({ where: { id: { in: data.lines.flatMap((l) => l.itemBrandId ? [l.itemBrandId] : []) }, organizationId: actor.organizationId }, select: { id: true, itemId: true } });
    const brandItems = new Map(brands.map((b) => [b.id, b.itemId]));
    data.lines.forEach((line, i) => {
      if (line.itemBrandId && brandItems.get(line.itemBrandId) !== line.itemId) throw new ValidationError("The brand must belong to the selected item.", { [`lines.${i}.itemBrandId`]: "Invalid item brand." });
      if (line.prLineId) {
        const source = pr?.lines.find((l) => l.id === line.prLineId);
        if (!source || source.itemBrand.itemId !== line.itemId || source.itemBrandId !== line.itemBrandId) throw new ValidationError("The line must match the selected requisition.", { [`lines.${i}.prLineId`]: "Invalid requisition line." });
      }
    });
    const suppliers = await tx.party.findMany({ where: { id: { in: data.supplierIds }, organizationId: actor.organizationId, isSupplier: true, status: "ACTIVE" }, select: { id: true } });
    if (suppliers.length !== new Set(data.supplierIds).size) throw new ValidationError("Every invited party must be an active supplier.", { supplierIds: "Invalid supplier." });
    const items = await tx.item.findMany({ where: { id: { in: data.lines.map((l) => l.itemId) }, organizationId: actor.organizationId }, select: { id: true, unit: true } });
    const units = new Map(items.map((i) => [i.id, i.unit]));
    data.lines.forEach((l, i) => {
      if (!units.has(l.itemId)) throw new ValidationError("Item not found.", { [`lines.${i}.itemId`]: "Not found." });
    });
    const number = await nextDocNumber(tx, actor.organizationId, "RFQ", startOfToday());
    const rfq = await tx.rfq.create({
      data: {
        organizationId: actor.organizationId,
        number,
        projectId: data.projectId,
        prId: data.prId,
        title: data.title,
        deliveryLocationId: data.deliveryLocationId,
        deliveryAddress: data.deliveryAddress,
        requiredBy: toDbDate(data.requiredBy),
        responseDue: toDbDate(data.responseDue),
        paymentTerms: data.paymentTerms,
        freightTerms: data.freightTerms,
        taxTerms: data.taxTerms,
        validityDays: data.validityDays,
        specifications: data.specifications,
        createdById: actor.id,
        lines: { create: data.lines.map((l, i) => ({ lineNo: i + 1, itemId: l.itemId, itemBrandId: l.itemBrandId, acceptableBrands: l.acceptableBrands, quantity: l.quantity, unit: units.get(l.itemId)!, specifications: l.specifications, prLineId: l.prLineId })) },
        suppliers: { create: [...new Set(data.supplierIds)].map((partyId) => ({ partyId })) },
      },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rfq.created", entityType: "rfq", entityId: rfq.id, projectId: rfq.projectId, summary: `Created rate enquiry ${number} – ${data.title} (${data.lines.length} items, ${data.supplierIds.length} suppliers)` }, tx);
    return rfq;
  });
}

const addSuppliersSchema = z.object({ supplierIds: z.array(uuid).min(1, "Choose at least one supplier.") });

/** Invite more suppliers to an open enquiry (any number, until the award is sent for approval). */
export async function addRfqSuppliers(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "rfq.manage");
  const data = parseInput(addSuppliersSchema, input);
  const rfq = await loadRfq(actor, id);
  if (!["DRAFT", "SENT", "RESPONSES_IN"].includes(rfq.status)) throw new ValidationError("Suppliers can only be added while the enquiry is open (before the award is sent for approval).");
  const already = new Set(rfq.suppliers.map((s) => s.partyId));
  const ids = [...new Set(data.supplierIds)].filter((p) => !already.has(p));
  if (!ids.length) throw new ValidationError("These suppliers are already on the enquiry.", { supplierIds: "Already invited." });
  return db.$transaction(async (tx) => {
    const parties = await tx.party.findMany({ where: { id: { in: ids }, organizationId: actor.organizationId, isSupplier: true, status: "ACTIVE" }, select: { id: true, name: true } });
    if (parties.length !== ids.length) throw new ValidationError("Every invited party must be an active supplier.", { supplierIds: "Invalid supplier." });
    await tx.rfqSupplier.createMany({ data: ids.map((partyId) => ({ rfqId: id, partyId })), skipDuplicates: true });
    await tx.rfq.update({ where: { id }, data: { version: { increment: 1 } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rfq.suppliers_added", entityType: "rfq", entityId: id, projectId: rfq.projectId, summary: `Added ${parties.length} supplier(s) to ${rfq.number}: ${parties.map((p) => p.name).join(", ")}` }, tx);
    return { added: parties.length };
  });
}

/** Prefill for "Request supplier rates" from an approved requisition. */
export async function prefillRfqFromPr(actor: Actor, prId: string) {
  requirePermission(actor, "rfq.manage");
  const pr = await db.purchaseRequisition.findFirst({ where: { AND: [{ id: prId }, projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput] }, include: { project: { select: { code: true, name: true } }, lines: { orderBy: { lineNo: "asc" }, include: { itemBrand: { select: { itemId: true, preferredSupplierId: true } } } } } });
  if (!pr) throw new NotFoundError("Requisition");
  if (!["APPROVED", "PARTIALLY_ORDERED"].includes(pr.status)) throw new ValidationError("Only approved requisitions can be sent for rates.");
  return {
    projectId: pr.projectId,
    prId: pr.id,
    prNumber: pr.number,
    title: `Rates for ${pr.number}${pr.project ? ` – ${pr.project.name}` : ""}`,
    deliveryLocationId: pr.deliveryLocationId,
    requiredBy: pr.requiredBy ? pr.requiredBy.toISOString().slice(0, 10) : "",
    supplierIds: [...new Set(pr.lines.map((l) => l.itemBrand.preferredSupplierId).filter(Boolean) as string[])],
    lines: pr.lines.filter((l) => cmpQty(dec3(l.quantity), dec3(l.orderedQty)) > 0).map((l) => ({ itemId: l.itemBrand.itemId, itemBrandId: l.itemBrandId, quantity: subQty(dec3(l.quantity), dec3(l.orderedQty)), prLineId: l.id, acceptableBrands: "", specifications: l.notes ?? "" })),
  };
}

export type RfqAction = "send" | "cancel" | "close" | "approve_award" | "reject_award";

export async function rfqAction(actor: Actor, id: string, action: RfqAction, opts: { version: number; note?: string | null; via?: string | null }) {
  const rfq = await loadRfq(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string) => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `rfq.${action}`, entityType: "rfq", entityId: id, projectId: rfq.projectId, summary: `${verb} ${rfq.number}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  if (action === "send") {
    requirePermission(actor, "rfq.manage");
    return db.$transaction(async (tx) => {
      await transition(tx.rfq, w, ["DRAFT", "SENT", "RESPONSES_IN"], { status: rfq.status === "DRAFT" ? "SENT" : rfq.status }, "rate enquiry");
      await tx.rfqSupplier.updateMany({ where: { rfqId: id, sentAt: null }, data: { sentAt: new Date(), sentVia: opts.via ?? "manual" } });
      await log(tx, `Marked as shared with suppliers${opts.via ? ` (${opts.via})` : ""}:`);
    });
  }
  if (action === "approve_award" || action === "reject_award") {
    const value = await awardValue(id);
    await assertCanApprove(actor, { permission: "rfq.approve", docType: "PO", amount: value, createdById: rfq.awardProposedById, submittedById: rfq.awardProposedById, what: "supplier award" });
    if (action === "reject_award" && !opts.note) throw new ValidationError("Give a reason.", { note: "Reason is required." });
    return db.$transaction(async (tx) => {
      if (action === "approve_award") {
        await transition(tx.rfq, w, ["AWARD_PENDING"], { status: "AWARDED", awardApprovedById: actor.id, awardApprovedAt: new Date() }, "rate enquiry");
        await tx.supplierQuotation.updateMany({ where: { rfqId: id, status: "RECEIVED", lines: { some: { awardedQty: { gt: 0 } } } }, data: { status: "AWARDED" } });
      } else {
        await transition(tx.rfq, w, ["AWARD_PENDING"], { status: "RESPONSES_IN", awardNote: opts.note }, "rate enquiry");
        await tx.quotationLine.updateMany({ where: { quotation: { rfqId: id } }, data: { awardedQty: 0 } });
      }
      await log(tx, action === "approve_award" ? "Approved supplier award for" : "Rejected proposed award for");
    });
  }
  requirePermission(actor, "rfq.manage");
  if (!opts.note) throw new ValidationError("Give a reason.", { note: "Reason is required." });
  return db.$transaction(async (tx) => {
    await transition(tx.rfq, w, action === "cancel" ? ["DRAFT", "SENT", "RESPONSES_IN", "AWARD_PENDING"] : ["AWARDED", "RESPONSES_IN", "SENT"], { status: action === "cancel" ? "CANCELLED" : "CLOSED", awardNote: opts.note }, "rate enquiry");
    await log(tx, action === "cancel" ? "Cancelled" : "Closed");
  });
}

async function awardValue(rfqId: string) {
  const lines = await db.quotationLine.findMany({ where: { quotation: { rfqId }, awardedQty: { gt: 0 } }, include: { quotation: { select: { taxMode: true } } } });
  return addMoney(...lines.map((l) => lineAmounts({ qty: dec3(l.awardedQty), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate) }, l.quotation.taxMode).total));
}

/** Manual entry of a supplier quotation (or a revised one, superseding the previous). */
export async function recordQuotation(actor: Actor, input: unknown) {
  requirePermission(actor, "rfq.manage");
  const data = parseInput(quotationSchema, input);
  const rfq = await loadRfq(actor, data.rfqId);
  if (!["SENT", "RESPONSES_IN", "DRAFT"].includes(rfq.status)) throw new ValidationError("Quotations can only be recorded while the enquiry is open.");
  if (!rfq.suppliers.some((s) => s.partyId === data.partyId)) throw new ValidationError("This supplier was not invited to the enquiry.", { partyId: "Not invited." });
  return db.$transaction((tx) => persistQuotation(tx, { organizationId: actor.organizationId, rfq, data, createdById: actor.id, actorId: actor.id, viaPortal: false }));
}

type QuotationData = z.infer<typeof quotationSchema>;

/**
 * Saves a quotation (or a revision superseding the supplier's current one). Shared by manual
 * entry and the supplier's own quote link. Caller checks permission / token and that the
 * enquiry is open and the supplier invited.
 */
export async function persistQuotation(
  tx: Tx,
  { organizationId, rfq, data, createdById, actorId, viaPortal }: { organizationId: string; rfq: { id: string; number: string; status: string; projectId: string | null; lines: { id: string; itemId: string }[] }; data: QuotationData; createdById: string; actorId: string | null; viaPortal: boolean },
) {
  const rfqLines = new Map(rfq.lines.map((l) => [l.id, l]));
  {
    const party = await tx.party.findUniqueOrThrow({ where: { id: data.partyId } });
    const settings = await getCommercialSettings(organizationId, tx);
    const ibs = await tx.itemBrand.findMany({ where: { id: { in: data.lines.map((l) => l.itemBrandId) }, organizationId }, select: { id: true, itemId: true } });
    const ibMap = new Map(ibs.map((i) => [i.id, i]));
    data.lines.forEach((l, i) => {
      const rl = rfqLines.get(l.rfqLineId);
      const ib = ibMap.get(l.itemBrandId);
      if (!rl) throw new ValidationError("Line does not belong to this enquiry.", { [`lines.${i}.rfqLineId`]: "Invalid line." });
      if (!ib || ib.itemId !== rl.itemId) throw new ValidationError("The offered brand must be for the enquired item.", { [`lines.${i}.itemBrandId`]: "Brand of a different item." });
    });
    let revision = 1;
    if (data.replacesId) {
      const prev = await tx.supplierQuotation.findFirst({ where: { id: data.replacesId, rfqId: data.rfqId, partyId: data.partyId, status: "RECEIVED" } });
      if (!prev) throw new ValidationError("Only the current quotation of this supplier can be revised.");
      revision = prev.revision + 1;
      await tx.supplierQuotation.update({ where: { id: prev.id }, data: { status: "SUPERSEDED" } });
    } else if (await tx.supplierQuotation.count({ where: { rfqId: data.rfqId, partyId: data.partyId, status: { in: ["RECEIVED", "AWARDED"] } } })) {
      throw new ValidationError("A quotation from this supplier is already recorded. Use “Revise” to enter a revised quotation.");
    }
    const number = await nextDocNumber(tx, organizationId, "SQ", toDbDate(data.quoteDate)!);
    const q = await tx.supplierQuotation.create({
      data: {
        organizationId,
        viaPortal,
        number,
        rfqId: data.rfqId,
        partyId: data.partyId,
        supplierRef: data.supplierRef,
        quoteDate: toDbDate(data.quoteDate)!,
        validUntil: toDbDate(data.validUntil),
        revision,
        supersedesId: data.replacesId,
        freight: data.freight,
        freightGstRate: data.freightGstRate,
        paymentTerms: data.paymentTerms,
        deliveryDays: data.deliveryDays,
        taxMode: taxModeFor(settings.stateCode, party.stateCode),
        remarks: data.remarks,
        advancePct: data.advancePct,
        creditDays: data.creditDays,
        warranty: data.warranty,
        paymentMilestones: (data.paymentMilestones ?? undefined) as Prisma.InputJsonValue | undefined,
        createdById,
        lines: { create: data.lines.map((l) => ({ rfqLineId: l.rfqLineId, itemBrandId: l.itemBrandId, itemId: ibMap.get(l.itemBrandId)!.itemId, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, leadTimeDays: l.leadTimeDays, remarks: l.remarks, paymentTerms: l.paymentTerms })) },
      },
    });
    await tx.rfqSupplier.updateMany({ where: { rfqId: data.rfqId, partyId: data.partyId }, data: { status: "RESPONDED" } });
    if (rfq.status === "SENT" || rfq.status === "DRAFT") await tx.rfq.update({ where: { id: rfq.id }, data: { status: "RESPONSES_IN", version: { increment: 1 } } });
    const how = viaPortal ? " (submitted by the supplier via their quote link)" : "";
    await writeAudit({ organizationId, actorId, action: data.replacesId ? "rfq.quotation_revised" : "rfq.quotation_recorded", entityType: "rfq", entityId: rfq.id, projectId: rfq.projectId, summary: `${data.replacesId ? `Revised quotation (rev ${revision})` : "Recorded quotation"} ${number} from ${party.name} on ${rfq.number}${how}` }, tx);
    return q;
  }
}

/** Records that a supplier's quote link was shared (WhatsApp / email / copied). */
export async function markRfqSupplierShared(actor: Actor, rfqId: string, partyId: string, via: string) {
  requirePermission(actor, "rfq.manage");
  const rfq = await loadRfq(actor, rfqId);
  if (!rfq.suppliers.some((s) => s.partyId === partyId)) throw new NotFoundError("Supplier");
  await db.$transaction(async (tx) => {
    await tx.rfqSupplier.updateMany({ where: { rfqId, partyId, sentAt: null }, data: { sentAt: new Date(), sentVia: via.slice(0, 30) } });
    if (rfq.status === "DRAFT") await tx.rfq.update({ where: { id: rfqId }, data: { status: "SENT", version: { increment: 1 } } });
  });
}

// ─────────────────────────── Comparison & award ───────────────────────────

/** One line describing a supplier's payment terms (structured first, then free text). */
export function supplierTermsSummary(q: { advancePct: Prisma.Decimal | null; creditDays: number | null; paymentTerms: string | null; paymentMilestones: Prisma.JsonValue | null; warranty?: string | null }) {
  const parts: string[] = [];
  const ms = Array.isArray(q.paymentMilestones) ? (q.paymentMilestones as { label: string; basis: string; value: string }[]) : [];
  if (ms.length) parts.push(ms.map((m) => `${m.basis === "PERCENT" ? `${m.value}%` : `₹${m.value}`} ${m.label.toLowerCase()}`).join(", "));
  else if (q.advancePct && Number(q.advancePct) > 0) parts.push(`${Number(q.advancePct)}% advance`);
  if (q.creditDays !== null && q.creditDays !== undefined) parts.push(q.creditDays === 0 ? "payment on delivery" : `${q.creditDays} days credit`);
  if (q.paymentTerms) parts.push(q.paymentTerms);
  return parts.join(" · ") || null;
}

export type ComparisonQuote = {
  terms: string | null;
  lineTerms: string | null;
  advancePct: string | null;
  creditDays: number | null;
  warranty: string | null;
  quotationId: string;
  quotationLineId: string;
  partyId: string;
  partyName: string;
  quotationNumber: string;
  revision: number;
  brand: string;
  itemBrandId: string;
  quantity: string;
  rate: string;
  discountPct: string;
  gstRate: string;
  taxable: string;
  tax: string;
  freightShare: string;
  landedTotal: string;
  landedUnit: string;
  leadTimeDays: number | null;
  validUntil: string | null;
  expired: boolean;
  awardedQty: string;
  lowestRate: boolean;
  lowestLanded: boolean;
  recommended: boolean;
  reliability: { onTimePct: number | null; rejectionPct: number | null; receipts: number };
};

/**
 * Line-by-line comparison. Landed cost = taxable + GST + the line's share of freight (split by
 * taxable value) — GST is shown separately because input credit may be claimable. Recommendation
 * = lowest landed unit cost among valid quotes, tie-broken by on-time delivery.
 */
export async function getRfq(actor: Actor, id: string) {
  requirePermission(actor, "rfq.view");
  const rfq = await db.rfq.findFirst({
    where: { AND: [{ id }, projectScoped(actor) as Prisma.RfqWhereInput] },
    include: {
      project: { select: { id: true, code: true, name: true } },
      pr: { select: { id: true, number: true } },
      deliveryLocation: { select: { id: true, name: true } },
      createdBy: { select: { id: true, fullName: true } },
      awardProposedBy: { select: { id: true, fullName: true } },
      awardApprovedBy: { select: { id: true, fullName: true } },
      lines: { orderBy: { lineNo: "asc" }, include: { item: { select: { id: true, code: true, name: true, unit: true } }, itemBrand: { select: { id: true, brand: { select: { name: true } } } } } },
      suppliers: { include: { party: { select: { id: true, name: true, phone: true, email: true, whatsappNumber: true } } }, orderBy: { createdAt: "asc" } },
      quotations: { orderBy: [{ partyId: "asc" }, { revision: "desc" }], include: { party: { select: { id: true, name: true } }, lines: { include: { itemBrand: { select: { brand: { select: { name: true } } } } } } } },
      purchaseOrders: { select: { id: true, number: true, status: true, total: true, party: { select: { name: true } } } },
    },
  });
  if (!rfq) throw new NotFoundError("Rate enquiry");
  const today = startOfToday();
  const active = rfq.quotations.filter((q) => q.status === "RECEIVED" || q.status === "AWARDED");
  const perf = await supplierPerformance(actor.organizationId, active.map((q) => q.partyId));

  const comparison = rfq.lines.map((line) => {
    const quotes: ComparisonQuote[] = [];
    for (const q of active) {
      const ql = q.lines.find((l) => l.rfqLineId === line.id);
      if (!ql) continue;
      const amounts = lineAmounts({ qty: dec3(ql.quantity), rate: dec4(ql.rate), discountPct: dec2(ql.discountPct), gstRate: dec2(ql.gstRate) }, q.taxMode);
      const quoteTaxable = q.lines.reduce((a, l) => a + money(lineAmounts({ qty: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct) }, q.taxMode).taxable), BigInt(0));
      const freightTotal = money(lineAmounts({ qty: "1", rate: dec2(q.freight), gstRate: dec2(q.freightGstRate) }, q.taxMode).total);
      const share = quoteTaxable > BigInt(0) ? divRound(freightTotal * money(amounts.taxable), quoteTaxable) : BigInt(0);
      const landed = fmtMoney(money(amounts.total) + share);
      const p = perf.get(q.partyId);
      quotes.push({
        quotationId: q.id,
        quotationLineId: ql.id,
        partyId: q.partyId,
        partyName: q.party.name,
        quotationNumber: q.number,
        revision: q.revision,
        brand: ql.itemBrand.brand.name,
        itemBrandId: ql.itemBrandId,
        quantity: dec3(ql.quantity),
        rate: dec4(ql.rate),
        discountPct: dec2(ql.discountPct),
        gstRate: dec2(ql.gstRate),
        taxable: amounts.taxable,
        tax: amounts.tax,
        freightShare: fmtMoney(share),
        landedTotal: landed,
        landedUnit: unitRate(landed, dec3(ql.quantity)),
        leadTimeDays: ql.leadTimeDays ?? q.deliveryDays,
        terms: supplierTermsSummary(q),
        lineTerms: ql.paymentTerms ?? null,
        advancePct: q.advancePct ? dec2(q.advancePct) : null,
        creditDays: q.creditDays,
        warranty: q.warranty,
        validUntil: q.validUntil?.toISOString() ?? null,
        expired: !!q.validUntil && q.validUntil.getTime() < today.getTime(),
        awardedQty: dec3(ql.awardedQty),
        lowestRate: false,
        lowestLanded: false,
        recommended: false,
        reliability: { onTimePct: p?.onTimePct ?? null, rejectionPct: p?.rejectionPct ?? null, receipts: p?.receipts ?? 0 },
      });
    }
    const effRate = (x: ComparisonQuote) => money(unitRate(x.taxable, x.quantity));
    const valid = quotes.filter((x) => !x.expired);
    if (quotes.length) {
      const minRate = quotes.reduce((a, b) => (effRate(b) < effRate(a) ? b : a));
      quotes.filter((x) => effRate(x) === effRate(minRate)).forEach((x) => (x.lowestRate = true));
      const minLanded = quotes.reduce((a, b) => (money(b.landedUnit) < money(a.landedUnit) ? b : a));
      quotes.filter((x) => x.landedUnit === minLanded.landedUnit).forEach((x) => (x.lowestLanded = true));
    }
    if (valid.length) {
      const best = [...valid].sort((a, b) => cmpMoney(a.landedUnit, b.landedUnit) || (b.reliability.onTimePct ?? -1) - (a.reliability.onTimePct ?? -1))[0]!;
      best.recommended = true;
    }
    const awarded = quotes.reduce((a, x) => addQty(a, x.awardedQty), "0");
    return { line: { ...line, quantity: dec3(line.quantity) }, quotes, awarded };
  });

  const settings = await getCommercialSettings(actor.organizationId);
  const hint = approvalHint(actor, "rfq.approve", { createdById: rfq.awardProposedById, submittedById: rfq.awardProposedById }, settings.enforceSegregation);
  const awardedSuppliers = new Set(rfq.quotations.filter((q) => q.lines.some((l) => cmpQty(dec3(l.awardedQty), "0") > 0)).map((q) => q.partyId));
  const poPartyNames = new Set(rfq.purchaseOrders.filter((p) => p.status !== "CANCELLED").map((p) => p.party.name));
  return {
    rfq: { ...rfq, lines: rfq.lines.map((l) => ({ ...l, quantity: dec3(l.quantity) })), quotations: rfq.quotations.map((q) => ({ ...q, freight: dec2(q.freight), freightGstRate: dec2(q.freightGstRate), lines: q.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), awardedQty: dec3(l.awardedQty) })) })), purchaseOrders: rfq.purchaseOrders.map((p) => ({ ...p, total: dec2(p.total) })) },
    comparison,
    can: {
      manage: can(actor, "rfq.manage") && ["DRAFT", "SENT", "RESPONSES_IN"].includes(rfq.status),
      send: can(actor, "rfq.manage") && ["DRAFT", "SENT", "RESPONSES_IN"].includes(rfq.status),
      award: can(actor, "rfq.manage") && rfq.status === "RESPONSES_IN",
      approveAward: rfq.status === "AWARD_PENDING" && hint.canApprove,
      approveBlockedReason: rfq.status === "AWARD_PENDING" ? hint.reason : null,
      createPos: can(actor, "po.create") && rfq.status === "AWARDED" && [...awardedSuppliers].length > 0 && rfq.purchaseOrders.filter((p) => p.status !== "CANCELLED").length === 0,
      cancel: can(actor, "rfq.manage") && ["DRAFT", "SENT", "RESPONSES_IN", "AWARD_PENDING"].includes(rfq.status),
      close: can(actor, "rfq.manage") && ["AWARDED", "RESPONSES_IN", "SENT"].includes(rfq.status),
    },
    poSuppliers: [...poPartyNames],
  };
}

const awardSchema = z.object({ version: z.number().int(), note: optionalText("Note", 1000), awards: z.array(z.object({ quotationLineId: uuid, quantity: z.union([z.string(), z.number()]).transform((v) => String(v).trim() || "0").pipe(z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Quantity.")) })).max(1000) });

/** Proposes the award (split across suppliers allowed); goes to an approver before any PO is raised. */
export async function proposeAward(actor: Actor, rfqId: string, input: unknown) {
  requirePermission(actor, "rfq.manage");
  const data = parseInput(awardSchema, input);
  const rfq = await loadRfq(actor, rfqId);
  if (rfq.status !== "RESPONSES_IN") throw new ValidationError("Awards can be proposed once quotations are in.");
  const lines = await db.quotationLine.findMany({ where: { id: { in: data.awards.map((a) => a.quotationLineId) }, quotation: { rfqId, status: "RECEIVED" } }, include: { quotation: { select: { validUntil: true, party: { select: { name: true } } } } } });
  if (lines.length !== data.awards.length) throw new ValidationError("Award lines must belong to current quotations of this enquiry.");
  const per = new Map<string, bigint>();
  const today = startOfToday();
  for (const a of data.awards) {
    const ql = lines.find((l) => l.id === a.quotationLineId)!;
    if (cmpQty(a.quantity, dec3(ql.quantity)) > 0) throw new ValidationError(`Award for ${ql.quotation.party.name} exceeds the quoted quantity.`);
    if (cmpQty(a.quantity, "0") > 0 && ql.quotation.validUntil && ql.quotation.validUntil < today) throw new ValidationError(`The quotation from ${ql.quotation.party.name} has expired. Ask for a revised quotation.`);
    if (ql.rfqLineId) per.set(ql.rfqLineId, (per.get(ql.rfqLineId) ?? BigInt(0)) + qtyUnits(a.quantity));
  }
  for (const l of rfq.lines) if ((per.get(l.id) ?? BigInt(0)) > qtyUnits(dec3(l.quantity))) throw new ValidationError(`Total award for line ${l.lineNo} exceeds the enquired quantity (${dec3(l.quantity)}).`);
  if (![...per.values()].some((v) => v > BigInt(0))) throw new ValidationError("Award a quantity on at least one line.");
  await db.$transaction(async (tx) => {
    await tx.quotationLine.updateMany({ where: { quotation: { rfqId } }, data: { awardedQty: 0 } });
    for (const a of data.awards) if (cmpQty(a.quantity, "0") > 0) await tx.quotationLine.update({ where: { id: a.quotationLineId }, data: { awardedQty: a.quantity } });
    await transition(tx.rfq, { id: rfqId, organizationId: actor.organizationId, version: data.version }, ["RESPONSES_IN"], { status: "AWARD_PENDING", awardNote: data.note, awardProposedById: actor.id, awardProposedAt: new Date() }, "rate enquiry");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rfq.award_proposed", entityType: "rfq", entityId: rfqId, projectId: rfq.projectId, summary: `Proposed award on ${rfq.number} for approval${data.note ? ` – ${data.note}` : ""}` }, tx);
  });
}

/** After award approval: one draft PO per awarded supplier, linked to the RFQ (and requisition lines). */
export async function createPosFromAward(actor: Actor, rfqId: string) {
  requirePermission(actor, "po.create");
  return db.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM rfqs WHERE id = ${rfqId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
  const rfq = await tx.rfq.findFirst({ where: { AND: [{ id: rfqId }, projectScoped(actor) as Prisma.RfqWhereInput] }, include: { lines: true, purchaseOrders: { select: { status: true } }, quotations: { where: { status: "AWARDED" }, include: { lines: { where: { awardedQty: { gt: 0 } } } } } } });
  if (!rfq) throw new NotFoundError("Rate enquiry");
  if (rfq.status !== "AWARDED") throw new ValidationError("The award must be approved first.");
  if (rfq.purchaseOrders.some((p) => p.status !== "CANCELLED")) throw new ValidationError("Purchase orders were already created from this award.");
  const lineById = new Map(rfq.lines.map((l) => [l.id, l]));
  const created: { id: string; number: string }[] = [];
  for (const q of rfq.quotations) {
    if (!q.lines.length) continue;
    const po = await createPo(actor, {
      projectId: rfq.projectId,
      partyId: q.partyId,
      deliveryLocationId: rfq.deliveryLocationId,
      deliveryAddress: rfq.deliveryAddress,
      orderDate: startOfToday().toISOString().slice(0, 10),
      expectedDate: rfq.requiredBy ? rfq.requiredBy.toISOString().slice(0, 10) : null,
      paymentTerms: supplierTermsSummary(q)?.slice(0, 500) ?? null,
      advancePct: q.advancePct ? dec2(q.advancePct) : null,
      creditDays: q.creditDays,
      warranty: q.warranty,
      paymentMilestones: q.paymentMilestones,
      charges: dec2(q.freight),
      chargesGstRate: dec2(q.freightGstRate),
      rfqId: rfq.id,
      prId: rfq.prId,
      lines: q.lines.map((l) => ({ itemBrandId: l.itemBrandId, quantity: dec3(l.awardedQty), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: String(Number(dec2(l.gstRate))), prLineId: l.rfqLineId ? (lineById.get(l.rfqLineId)?.prLineId ?? null) : null, quotationLineId: l.id, description: l.remarks })),
    }, tx);
    created.push({ id: po.id, number: po.number });
  }
  return created;
  }, { timeout: 20000 });
}

export const rfqListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).catch(20).default(20),
});

export async function listRfqs(actor: Actor, raw: unknown) {
  requirePermission(actor, "rfq.view");
  const q = rfqListQuerySchema.parse(raw ?? {});
  const where: Prisma.RfqWhereInput = {
    AND: [
      projectScoped(actor) as Prisma.RfqWhereInput,
      q.status ? { status: q.status as Prisma.EnumRfqStatusFilter["equals"] } : {},
      q.projectId ? { projectId: q.projectId } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { title: { contains: q.q, mode: "insensitive" } }] } : {},
    ],
  };
  const [total, rows, byStatus] = await Promise.all([
    db.rfq.count({ where }),
    db.rfq.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, _count: { select: { lines: true, suppliers: true, quotations: { where: { status: { in: ["RECEIVED", "AWARDED"] } } } } } } }),
    db.rfq.groupBy({ by: ["status"], where: { AND: [projectScoped(actor) as Prisma.RfqWhereInput, q.projectId ? { projectId: q.projectId } : {}] }, _count: true }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, query: q, rows, byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number> };
}

export async function rfqAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "rfq.view")) return null;
  const r = await db.rfq.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.RfqWhereInput] }, select: { number: true, projectId: true, status: true } });
  if (!r) return null;
  return { projectId: r.projectId, label: r.number, canView: true, canUpload: can(actor, "rfq.manage"), locked: ["AWARDED", "CLOSED", "CANCELLED"].includes(r.status) };
}

/** Supplier quotation evidence (the supplier's own quotation file) follows the enquiry's visibility. */
export async function quotationAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "rfq.view")) return null;
  const q = await db.supplierQuotation.findFirst({ where: { id, organizationId: actor.organizationId, rfq: { is: projectScoped(actor) as Prisma.RfqWhereInput } }, select: { number: true, party: { select: { name: true } }, rfq: { select: { projectId: true, status: true } } } });
  if (!q?.rfq) return null;
  return { projectId: q.rfq.projectId, label: `${q.number} (${q.party.name})`, canView: true, canUpload: can(actor, "rfq.manage"), locked: ["AWARDED", "CLOSED", "CANCELLED"].includes(q.rfq.status) };
}
