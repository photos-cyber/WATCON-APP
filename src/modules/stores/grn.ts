import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ForbiddenError, NotFoundError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { addQty, cmpQty, divRound, fmtQty, qtyUnits, subQty, toUnits, unitRate } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { approvalHint, assertProjectUsable, dec2, dec3, getCommercialSettings, parseInput, projectScoped, requirePermission, segregationBlocks, transition } from "@/modules/commercial/core";
import { qtyOrZero } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { ensureSystemLocations, postMovementTx, reverseMovementTx } from "@/modules/inventory/engine";
import { isOpenForReceipt, refreshPoReceiptStatus } from "@/modules/procurement/po";
import { startOfToday } from "@/modules/tasks/rules";
import { refreshChallanStatus } from "./challan";

/**
 * Goods receipt notes (site material receiving).
 *   DRAFT → SUBMITTED (site engineer) → POSTED (verifier; stock increases) | REJECTED → (edit) → SUBMITTED
 *   POSTED → REVERSED (opposite stock entries; only if not billed and stock still available)
 * Stock increases ONLY at posting, ONLY by the accepted quantity, ONLY at the receiving
 * location (a site delivery lands in the site store, never in the central warehouse).
 */

const optId = uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null));
const coord = (min: number, max: number) => z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().min(min).max(max)]));

export const grnSchema = z.object({
  clientKey: z.string().uuid(),
  poId: optId,
  challanId: optId,
  receiptDate: dateString,
  supplierChallanNo: optionalText("Supplier challan no.", 60),
  supplierInvoiceNo: optionalText("Supplier invoice no.", 60),
  vehicleNo: optionalText("Vehicle no.", 30),
  receivedByName: optionalText("Received by", 120),
  remarks: optionalText("Remarks", 1000),
  latitude: coord(-90, 90),
  longitude: coord(-180, 180),
  submit: z.boolean().default(false),
  lines: z
    .array(z.object({ poLineId: optId, challanLineId: optId, receivedQty: qtyOrZero, damagedQty: qtyOrZero.optional().default("0"), rejectedQty: qtyOrZero.optional().default("0"), remarks: optionalText("Remarks", 300) }))
    .min(1)
    .max(200),
});
export type GrnInput = z.input<typeof grnSchema>;

type Source = { kind: "po"; po: Prisma.PurchaseOrderGetPayload<{ include: { lines: true } }> } | { kind: "challan"; challan: Prisma.ChallanGetPayload<{ include: { lines: true; toLocation: true } }> };

async function loadSource(actor: Actor, data: { poId: string | null; challanId: string | null }, client: Tx | typeof db = db): Promise<Source> {
  if (!!data.poId === !!data.challanId) throw new ValidationError("Choose the purchase order or the challan being received.");
  if (data.poId) {
    const po = await client.purchaseOrder.findFirst({ where: { AND: [{ id: data.poId }, projectScoped(actor) as Prisma.PurchaseOrderWhereInput] }, include: { lines: true } });
    if (!po) throw new NotFoundError("Purchase order");
    return { kind: "po", po };
  }
  const challan = await client.challan.findFirst({ where: { AND: [{ id: data.challanId! }, projectScoped(actor) as Prisma.ChallanWhereInput] }, include: { lines: true, toLocation: true } });
  if (!challan) throw new NotFoundError("Challan");
  return { kind: "challan", challan };
}

function pendingOnPoLine(l: { quantity: Prisma.Decimal; acceptedQty: Prisma.Decimal }) {
  const p = subQty(dec3(l.quantity), dec3(l.acceptedQty));
  return cmpQty(p, "0") > 0 ? p : "0";
}
function inTransitOnChallanLine(l: { quantity: Prisma.Decimal; receivedQty: Prisma.Decimal; writtenOffQty: Prisma.Decimal }) {
  return subQty(dec3(l.quantity), addQty(dec3(l.receivedQty), dec3(l.writtenOffQty)));
}

/** Validates lines against the source and returns rows to persist. */
async function buildLines(source: Source, lines: z.output<typeof grnSchema>["lines"], allowUnapproved: boolean) {
  const out: Prisma.GrnLineCreateManyGrnInput[] = [];
  let lineNo = 0;
  for (const [i, l] of lines.entries()) {
    const accepted = subQty(l.receivedQty, addQty(l.damagedQty, l.rejectedQty));
    if (cmpQty(accepted, "0") < 0) throw new ValidationError(`Line ${i + 1}: damaged + rejected cannot exceed the received quantity.`, { [`lines.${i}.damagedQty`]: "More than received." });
    if (cmpQty(l.receivedQty, "0") === 0) continue; // nothing received on this line
    if (source.kind === "po") {
      if (!isOpenForReceipt(source.po.status, allowUnapproved)) throw new ValidationError(`PO ${source.po.number} is ${source.po.status.toLowerCase().replace(/_/g, " ")}; material can only be received against approved, open purchase orders.`);
      const pl = source.po.lines.find((x) => x.id === l.poLineId);
      if (!pl) throw new ValidationError("A line does not belong to the purchase order.", { [`lines.${i}.poLineId`]: "Invalid line." });
      out.push({ lineNo: ++lineNo, poLineId: pl.id, itemBrandId: pl.itemBrandId, itemId: pl.itemId, expectedQty: pendingOnPoLine(pl), receivedQty: l.receivedQty, acceptedQty: accepted, damagedQty: l.damagedQty, rejectedQty: l.rejectedQty, unitCost: unitRate(dec2(pl.taxable), dec3(pl.quantity)), remarks: l.remarks });
    } else {
      const c = source.challan;
      if (!["DISPATCHED", "PARTIALLY_RECEIVED"].includes(c.status) || !["ISSUE_TO_SITE", "SITE_TO_SITE", "RETURN_TO_STORE"].includes(c.type)) throw new ValidationError(`Challan ${c.number} is not awaiting receipt.`);
      const cl = c.lines.find((x) => x.id === l.challanLineId);
      if (!cl) throw new ValidationError("A line does not belong to the challan.", { [`lines.${i}.challanLineId`]: "Invalid line." });
      if (cmpQty(l.rejectedQty, "0") > 0) throw new ValidationError("For internal transfers record damaged quantity; shortages stay in transit until the discrepancy is closed.", { [`lines.${i}.rejectedQty`]: "Use damaged / short." });
      out.push({ lineNo: ++lineNo, challanLineId: cl.id, itemBrandId: cl.itemBrandId, itemId: cl.itemId, expectedQty: inTransitOnChallanLine(cl), receivedQty: l.receivedQty, acceptedQty: accepted, damagedQty: l.damagedQty, rejectedQty: "0", remarks: l.remarks });
    }
  }
  if (!out.length) throw new ValidationError("Enter the received quantity for at least one line.");
  return out;
}

function headerFrom(source: Source) {
  if (source.kind === "po") return { poId: source.po.id, challanId: null, projectId: source.po.projectId, locationId: source.po.deliveryLocationId, partyId: source.po.partyId };
  const c = source.challan;
  return { poId: null, challanId: c.id, projectId: c.toLocation?.projectId ?? c.projectId, locationId: c.toLocationId!, partyId: null };
}

/** Creates (or, for a repeated client key, returns) a site receipt. Duplicate taps never create two GRNs. */
export async function createGrn(actor: Actor, input: unknown) {
  requirePermission(actor, "grn.create");
  const data = parseInput(grnSchema, input);
  const existing = await db.grn.findUnique({ where: { organizationId_clientKey: { organizationId: actor.organizationId, clientKey: data.clientKey } }, select: { id: true, number: true } });
  if (existing) return { ...existing, duplicate: true };
  const settings = await getCommercialSettings(actor.organizationId);
  const source = await loadSource(actor, data);
  const head = headerFrom(source);
  if (head.projectId) await assertProjectUsable(actor, head.projectId);
  const lines = await buildLines(source, data.lines, settings.allowReceiptOnUnapprovedPo);
  try {
    return await db.$transaction(async (tx) => {
      const number = await nextDocNumber(tx, actor.organizationId, "GRN", toDbDate(data.receiptDate)!);
      const grn = await tx.grn.create({
        data: {
          organizationId: actor.organizationId,
          number,
          ...head,
          receiptDate: toDbDate(data.receiptDate)!,
          supplierChallanNo: data.supplierChallanNo,
          supplierInvoiceNo: data.supplierInvoiceNo,
          vehicleNo: data.vehicleNo,
          receivedByName: data.receivedByName,
          remarks: data.remarks,
          latitude: data.latitude,
          longitude: data.longitude,
          clientKey: data.clientKey,
          status: data.submit ? "SUBMITTED" : "DRAFT",
          submittedById: data.submit ? actor.id : null,
          submittedAt: data.submit ? new Date() : null,
          createdById: actor.id,
          lines: { createMany: { data: lines } },
        },
      });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: data.submit ? "grn.submitted" : "grn.created", entityType: "grn", entityId: grn.id, projectId: grn.projectId, summary: `${data.submit ? "Recorded and submitted" : "Recorded draft"} receipt ${number} against ${source.kind === "po" ? source.po.number : source.challan.number} (${lines.length} lines)` }, tx);
      return { id: grn.id, number: grn.number, duplicate: false };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await db.grn.findUnique({ where: { organizationId_clientKey: { organizationId: actor.organizationId, clientKey: data.clientKey } }, select: { id: true, number: true } });
      if (again) return { ...again, duplicate: true };
    }
    throw e;
  }
}

async function loadGrn(actor: Actor, id: string, client: Tx | typeof db = db) {
  const g = await client.grn.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.GrnWhereInput] }, include: { lines: true } });
  if (!g) throw new NotFoundError("Receipt");
  return g;
}

export async function updateGrn(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "grn.create");
  const data = parseInput(grnSchema, input);
  const grn = await loadGrn(actor, id);
  if (!["DRAFT", "REJECTED"].includes(grn.status)) throw new ValidationError("Only draft or rejected receipts can be edited.");
  if (grn.poId !== data.poId || grn.challanId !== data.challanId) throw new ValidationError("The source document of a receipt cannot change.");
  const settings = await getCommercialSettings(actor.organizationId);
  const source = await loadSource(actor, data);
  const lines = await buildLines(source, data.lines, settings.allowReceiptOnUnapprovedPo);
  await db.$transaction(async (tx) => {
    await transition(tx.grn, { id, organizationId: actor.organizationId, version }, ["DRAFT", "REJECTED"], { receiptDate: toDbDate(data.receiptDate)!, supplierChallanNo: data.supplierChallanNo, supplierInvoiceNo: data.supplierInvoiceNo, vehicleNo: data.vehicleNo, receivedByName: data.receivedByName, remarks: data.remarks, latitude: data.latitude, longitude: data.longitude, status: data.submit ? "SUBMITTED" : "DRAFT", submittedById: data.submit ? actor.id : null, submittedAt: data.submit ? new Date() : null, statusNote: null }, "receipt");
    await tx.grnLine.deleteMany({ where: { grnId: id } });
    await tx.grnLine.createMany({ data: lines.map((l) => ({ ...l, grnId: id })) });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "grn.updated", entityType: "grn", entityId: id, projectId: grn.projectId, summary: `Edited receipt ${grn.number}${data.submit ? " and submitted it" : ""}` }, tx);
  });
}

/**
 * Verify & post. One guarded status change (SUBMITTED → POSTED) + PO-line counters under row
 * locks + stock movements with deterministic idempotency keys, all in ONE transaction: two people
 * posting the same receipt, or two receipts racing for the same PO quantity, cannot double-count.
 */
export async function postGrn(actor: Actor, id: string, version: number) {
  requirePermission(actor, "grn.post", "You do not have permission to verify and post receipts.");
  const grn = await loadGrn(actor, id);
  if (grn.status !== "SUBMITTED") throw new ValidationError(grn.status === "POSTED" ? "This receipt is already posted." : "Only submitted receipts can be posted.");
  const settings = await getCommercialSettings(actor.organizationId);
  if (segregationBlocks(actor, settings.enforceSegregation, grn.createdById, grn.submittedById)) throw new ForbiddenError("Separation of duties: a receipt must be verified and posted by someone other than the person who recorded it.");
  const today = startOfToday();
  await db.$transaction(async (tx) => {
    await transition(tx.grn, { id, organizationId: actor.organizationId, version }, ["SUBMITTED"], { status: "POSTED", postedById: actor.id, postedAt: new Date() }, "receipt");
    const sys = await ensureSystemLocations(tx, actor.organizationId);
    let poNumber: string | null = null;
    if (grn.poId) {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: grn.poId }, select: { number: true, status: true } });
      poNumber = po.number;
      if (!isOpenForReceipt(po.status, settings.allowReceiptOnUnapprovedPo)) throw new ValidationError(`PO ${po.number} is no longer open for receipt (${po.status.toLowerCase().replace(/_/g, " ")}). Reject this receipt.`);
      const tolerance = toUnits(settings.receiptTolerancePct, 2);
      for (const l of grn.lines) {
        const [pl] = await tx.$queryRaw<{ quantity: string; accepted_qty: string }[]>`SELECT quantity::text, accepted_qty::text FROM po_lines WHERE id = ${l.poLineId}::uuid FOR UPDATE`;
        if (!pl) throw new ValidationError("A PO line of this receipt no longer exists.");
        const allowed = qtyUnits(pl.quantity) + divRound(qtyUnits(pl.quantity) * tolerance, BigInt(10000));
        const after = qtyUnits(pl.accepted_qty) + qtyUnits(dec3(l.acceptedQty));
        if (after > allowed) throw new ValidationError(`Line ${l.lineNo}: accepting ${dec3(l.acceptedQty)} would exceed the ordered quantity (${pl.quantity}, already accepted ${pl.accepted_qty}${tolerance > BigInt(0) ? `, tolerance ${settings.receiptTolerancePct}%` : ""}). Another receipt may have been posted first — edit this receipt.`);
        await tx.poLine.update({ where: { id: l.poLineId! }, data: { receivedQty: { increment: dec3(l.receivedQty) }, acceptedQty: { increment: dec3(l.acceptedQty) }, rejectedQty: { increment: addQty(dec3(l.damagedQty), dec3(l.rejectedQty)) } } });
        if (cmpQty(dec3(l.acceptedQty), "0") > 0) {
          await postMovementTx(tx, { organizationId: actor.organizationId, actorId: actor.id, itemBrandId: l.itemBrandId, locationId: grn.locationId, projectId: grn.projectId, type: "RECEIPT", direction: "IN", quantity: dec3(l.acceptedQty), txnDate: today, today, reference: `${grn.number} / ${po.number}`, unitCost: l.unitCost?.toFixed(4) ?? null, idempotencyKey: `grn:${grn.id}:${l.id}`, sourceType: "grn", sourceId: grn.id });
          if (l.unitCost) await tx.itemBrand.update({ where: { id: l.itemBrandId }, data: { lastPurchaseRate: l.unitCost } });
        }
      }
      await refreshPoReceiptStatus(tx, grn.poId);
    } else if (grn.challanId) {
      for (const l of grn.lines) {
        const [cl] = await tx.$queryRaw<{ quantity: string; received_qty: string; written_off_qty: string }[]>`SELECT quantity::text, received_qty::text, written_off_qty::text FROM challan_lines WHERE id = ${l.challanLineId}::uuid FOR UPDATE`;
        const transit = subQty(cl!.quantity, addQty(cl!.received_qty, cl!.written_off_qty));
        if (cmpQty(dec3(l.receivedQty), transit) > 0) throw new ValidationError(`Line ${l.lineNo}: only ${transit} is still in transit on this challan. Another receipt may have been posted first.`);
        await tx.challanLine.update({ where: { id: l.challanLineId! }, data: { receivedQty: { increment: dec3(l.receivedQty) }, damagedQty: { increment: dec3(l.damagedQty) } } });
        const base = { organizationId: actor.organizationId, actorId: actor.id, itemBrandId: l.itemBrandId, projectId: grn.projectId, txnDate: today, today, reference: grn.number, sourceType: "grn", sourceId: grn.id };
        // Out of transit for everything that physically arrived; good stock into the destination, damaged into quarantine.
        await postMovementTx(tx, { ...base, locationId: sys.TRANSIT, type: "TRANSFER_OUT", direction: "OUT", quantity: dec3(l.receivedQty), idempotencyKey: `grn:${grn.id}:${l.id}:transit` });
        if (cmpQty(dec3(l.acceptedQty), "0") > 0) await postMovementTx(tx, { ...base, locationId: grn.locationId, type: "TRANSFER_IN", direction: "IN", quantity: dec3(l.acceptedQty), idempotencyKey: `grn:${grn.id}:${l.id}` });
        if (cmpQty(dec3(l.damagedQty), "0") > 0) await postMovementTx(tx, { ...base, locationId: sys.QUARANTINE, type: "TRANSFER_IN", direction: "IN", quantity: dec3(l.damagedQty), remarks: "Damaged in transit", idempotencyKey: `grn:${grn.id}:${l.id}:damaged` });
      }
      await refreshChallanStatus(tx, grn.challanId);
    }
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "grn.posted", entityType: "grn", entityId: id, projectId: grn.projectId, summary: `Verified and posted receipt ${grn.number}${poNumber ? ` against ${poNumber}` : ""} to stock` }, tx);
  });
}

export async function grnAction(actor: Actor, id: string, action: "submit" | "reject" | "cancel" | "reverse", opts: { version: number; note?: string | null }) {
  const grn = await loadGrn(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string) => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `grn.${action}`, entityType: "grn", entityId: id, projectId: grn.projectId, summary: `${verb} receipt ${grn.number}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  if (action === "submit") {
    requirePermission(actor, "grn.create");
    return db.$transaction(async (tx) => {
      await transition(tx.grn, w, ["DRAFT", "REJECTED"], { status: "SUBMITTED", submittedById: actor.id, submittedAt: new Date(), statusNote: null }, "receipt");
      await log(tx, "Submitted");
    });
  }
  if (!opts.note) throw new ValidationError("Give a reason.", { note: "Reason is required." });
  if (action === "reject") {
    requirePermission(actor, "grn.post");
    return db.$transaction(async (tx) => {
      await transition(tx.grn, w, ["SUBMITTED"], { status: "REJECTED", statusNote: opts.note }, "receipt");
      await log(tx, "Returned for correction");
    });
  }
  if (action === "cancel") {
    if (!can(actor, "grn.post") && grn.createdById !== actor.id) throw new ForbiddenError();
    return db.$transaction(async (tx) => {
      await transition(tx.grn, w, ["DRAFT", "SUBMITTED", "REJECTED"], { status: "CANCELLED", statusNote: opts.note }, "receipt");
      await log(tx, "Cancelled");
    });
  }
  // Reverse a posted receipt: opposite stock entries + counters back, never edits the original postings.
  requirePermission(actor, "grn.reverse");
  if (grn.lines.some((l) => cmpQty(dec3(l.billedQty), "0") > 0)) throw new ValidationError("Supplier bills are matched to this receipt. Cancel those bills before reversing it.");
  const today = startOfToday();
  return db.$transaction(async (tx) => {
    await transition(tx.grn, w, ["POSTED"], { status: "REVERSED", reversedById: actor.id, reversedAt: new Date(), statusNote: opts.note }, "receipt");
    const moves = await tx.stockTransaction.findMany({ where: { sourceType: "grn", sourceId: id, type: { not: "REVERSAL" } }, orderBy: { createdAt: "desc" }, select: { id: true } });
    for (const m of moves) await reverseMovementTx(tx, actor.organizationId, actor.id, m.id, `Reversal of ${grn.number}: ${opts.note}`, today);
    for (const l of grn.lines) {
      if (l.poLineId) await tx.poLine.update({ where: { id: l.poLineId }, data: { receivedQty: { decrement: dec3(l.receivedQty) }, acceptedQty: { decrement: dec3(l.acceptedQty) }, rejectedQty: { decrement: addQty(dec3(l.damagedQty), dec3(l.rejectedQty)) } } });
      if (l.challanLineId) await tx.challanLine.update({ where: { id: l.challanLineId }, data: { receivedQty: { decrement: dec3(l.receivedQty) }, damagedQty: { decrement: dec3(l.damagedQty) } } });
    }
    if (grn.poId) await refreshPoReceiptStatus(tx, grn.poId);
    if (grn.challanId) await refreshChallanStatus(tx, grn.challanId);
    await log(tx, "Reversed");
  });
}

// ─────────────────────────── Queries ───────────────────────────

/** Site engineer's inbox: POs and inbound challans awaiting receipt at the project's site (or all accessible). */
export async function pendingDeliveries(actor: Actor, projectId?: string) {
  requirePermission(actor, "grn.view");
  const settings = await getCommercialSettings(actor.organizationId);
  const statuses = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", ...(settings.allowReceiptOnUnapprovedPo ? ["PENDING_APPROVAL"] : [])] as Prisma.EnumPoStatusFilter["in"];
  const [pos, challans] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { AND: [projectScoped(actor) as Prisma.PurchaseOrderWhereInput, { status: { in: statuses } }, projectId ? { projectId } : {}] },
      orderBy: [{ expectedDate: { sort: "asc", nulls: "last" } }],
      take: 200,
      include: { party: { select: { name: true } }, project: { select: { id: true, code: true } }, deliveryLocation: { select: { name: true } }, lines: { select: { quantity: true, acceptedQty: true } }, grns: { where: { status: { in: ["DRAFT", "SUBMITTED"] } }, select: { id: true } } },
    }),
    db.challan.findMany({
      where: { AND: [projectScoped(actor) as Prisma.ChallanWhereInput, { status: { in: ["DISPATCHED", "PARTIALLY_RECEIVED"] }, type: { in: ["ISSUE_TO_SITE", "SITE_TO_SITE", "RETURN_TO_STORE"] } }, projectId ? { OR: [{ projectId }, { toLocation: { projectId } }] } : {}] },
      orderBy: { dispatchDate: "asc" },
      take: 200,
      include: { fromLocation: { select: { name: true } }, toLocation: { select: { name: true } }, project: { select: { id: true, code: true } }, lines: { select: { quantity: true, receivedQty: true, writtenOffQty: true } } },
    }),
  ]);
  const today = startOfToday();
  return [
    ...pos.map((p) => ({ kind: "po" as const, id: p.id, number: p.number, party: p.party.name, project: p.project, location: p.deliveryLocation.name, expectedDate: p.expectedDate?.toISOString() ?? null, overdue: !!p.expectedDate && p.expectedDate < today, pendingLines: p.lines.filter((l) => cmpQty(dec3(l.quantity), dec3(l.acceptedQty)) > 0).length, pendingQty: fmtQty(p.lines.reduce((a, l) => a + (qtyUnits(dec3(l.quantity)) > qtyUnits(dec3(l.acceptedQty)) ? qtyUnits(dec3(l.quantity)) - qtyUnits(dec3(l.acceptedQty)) : BigInt(0)), BigInt(0))), inProgress: p.grns.length, status: p.status })),
    ...challans.map((c) => ({ kind: "challan" as const, id: c.id, number: c.number, party: c.fromLocation?.name ?? "—", project: c.project, location: c.toLocation?.name ?? "—", expectedDate: (c.expectedDate ?? c.dispatchDate)?.toISOString() ?? null, overdue: !!c.expectedDate && c.expectedDate < today, pendingLines: c.lines.filter((l) => cmpQty(inTransitOnChallanLine(l), "0") > 0).length, pendingQty: fmtQty(c.lines.reduce((a, l) => a + qtyUnits(inTransitOnChallanLine(l)), BigInt(0))), inProgress: 0, status: c.status })),
  ].filter((d) => d.pendingLines > 0);
}

/** The receipt form's view of a source: what is still expected per line. */
export async function receiptSource(actor: Actor, kind: "po" | "challan", id: string) {
  requirePermission(actor, "grn.create");
  const source = await loadSource(actor, kind === "po" ? { poId: id, challanId: null } : { poId: null, challanId: id });
  const ibIds = source.kind === "po" ? source.po.lines.map((l) => l.itemBrandId) : source.challan.lines.map((l) => l.itemBrandId);
  const ibs = await db.itemBrand.findMany({ where: { id: { in: ibIds } }, select: { id: true, item: { select: { name: true, code: true, unit: true } }, brand: { select: { name: true } } } });
  const name = new Map(ibs.map((i) => [i.id, i]));
  if (source.kind === "po") {
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { party: { select: { name: true } }, deliveryLocation: { select: { name: true } }, project: { select: { id: true, code: true, name: true } } } });
    return { kind, id, number: po.number, status: po.status, party: po.party.name, location: po.deliveryLocation.name, project: po.project, lines: source.po.lines.map((l) => ({ sourceLineId: l.id, itemBrandId: l.itemBrandId, item: name.get(l.itemBrandId)!.item, brand: name.get(l.itemBrandId)!.brand.name, ordered: dec3(l.quantity), alreadyAccepted: dec3(l.acceptedQty), expected: pendingOnPoLine(l) })) };
  }
  const c = await db.challan.findUniqueOrThrow({ where: { id }, include: { fromLocation: { select: { name: true } }, toLocation: { select: { name: true } }, project: { select: { id: true, code: true, name: true } } } });
  return { kind, id, number: c.number, status: c.status, party: c.fromLocation?.name ?? "—", location: c.toLocation?.name ?? "—", project: c.project, lines: source.challan.lines.map((l) => ({ sourceLineId: l.id, itemBrandId: l.itemBrandId, item: name.get(l.itemBrandId)!.item, brand: name.get(l.itemBrandId)!.brand.name, ordered: dec3(l.quantity), alreadyAccepted: dec3(l.receivedQty), expected: inTransitOnChallanLine(l) })) };
}

export async function getGrn(actor: Actor, id: string) {
  requirePermission(actor, "grn.view");
  const grn = await db.grn.findFirst({
    where: { AND: [{ id }, projectScoped(actor) as Prisma.GrnWhereInput] },
    include: {
      project: { select: { id: true, code: true, name: true } },
      location: { select: { id: true, name: true } },
      party: { select: { id: true, name: true } },
      po: { select: { id: true, number: true } },
      challan: { select: { id: true, number: true } },
      createdBy: { select: { id: true, fullName: true } },
      submittedBy: { select: { id: true, fullName: true } },
      postedBy: { select: { id: true, fullName: true } },
      reversedBy: { select: { id: true, fullName: true } },
      lines: { orderBy: { lineNo: "asc" }, include: { itemBrand: { select: { item: { select: { id: true, code: true, name: true, unit: true } }, brand: { select: { name: true } } } } } },
    },
  });
  if (!grn) throw new NotFoundError("Receipt");
  const settings = await getCommercialSettings(actor.organizationId);
  const hint = approvalHint(actor, "grn.post", grn, settings.enforceSegregation);
  return {
    grn: { ...grn, latitude: grn.latitude?.toFixed(6) ?? null, longitude: grn.longitude?.toFixed(6) ?? null, lines: grn.lines.map((l) => ({ ...l, expectedQty: dec3(l.expectedQty), receivedQty: dec3(l.receivedQty), acceptedQty: dec3(l.acceptedQty), damagedQty: dec3(l.damagedQty), rejectedQty: dec3(l.rejectedQty), billedQty: dec3(l.billedQty), shortQty: cmpQty(dec3(l.expectedQty), dec3(l.receivedQty)) > 0 ? subQty(dec3(l.expectedQty), dec3(l.receivedQty)) : "0", unitCost: l.unitCost?.toFixed(4) ?? null })) },
    can: {
      edit: can(actor, "grn.create") && ["DRAFT", "REJECTED"].includes(grn.status),
      submit: can(actor, "grn.create") && ["DRAFT", "REJECTED"].includes(grn.status),
      post: grn.status === "SUBMITTED" && hint.canApprove,
      postBlockedReason: grn.status === "SUBMITTED" ? hint.reason : null,
      reject: grn.status === "SUBMITTED" && can(actor, "grn.post"),
      cancel: ["DRAFT", "SUBMITTED", "REJECTED"].includes(grn.status) && (can(actor, "grn.post") || grn.createdById === actor.id),
      reverse: grn.status === "POSTED" && can(actor, "grn.reverse"),
    },
  };
}

export const grnListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  poId: uuid.optional().catch(undefined),
  discrepancy: z.enum(["1"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export function grnWhere(actor: Actor, q: z.output<typeof grnListQuerySchema>): Prisma.GrnWhereInput {
  return {
    AND: [
      projectScoped(actor) as Prisma.GrnWhereInput,
      q.status ? { status: q.status as Prisma.EnumGrnStatusFilter["equals"] } : {},
      q.projectId ? { projectId: q.projectId } : {},
      q.poId ? { poId: q.poId } : {},
      q.discrepancy ? { lines: { some: { OR: [{ damagedQty: { gt: 0 } }, { rejectedQty: { gt: 0 } }] } } } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { supplierChallanNo: { contains: q.q, mode: "insensitive" } }, { supplierInvoiceNo: { contains: q.q, mode: "insensitive" } }, { po: { number: { contains: q.q, mode: "insensitive" } } }, { party: { name: { contains: q.q, mode: "insensitive" } } }] } : {},
    ],
  };
}

export async function listGrns(actor: Actor, raw: unknown) {
  requirePermission(actor, "grn.view");
  const q = grnListQuerySchema.parse(raw ?? {});
  const where = grnWhere(actor, q);
  const [total, rows, byStatus] = await Promise.all([
    db.grn.count({ where }),
    db.grn.findMany({ where, orderBy: [{ receiptDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { name: true } }, po: { select: { id: true, number: true } }, challan: { select: { id: true, number: true } }, location: { select: { name: true } }, createdBy: { select: { fullName: true } }, _count: { select: { lines: true } }, lines: { select: { damagedQty: true, rejectedQty: true } } } }),
    db.grn.groupBy({ by: ["status"], where: { AND: [projectScoped(actor) as Prisma.GrnWhereInput, q.projectId ? { projectId: q.projectId } : {}] }, _count: true }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, query: q, rows: rows.map(({ lines, ...r }) => ({ ...r, discrepancy: lines.some((l) => Number(l.damagedQty) > 0 || Number(l.rejectedQty) > 0) })), byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number> };
}

export async function grnAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "grn.view")) return null;
  const g = await db.grn.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.GrnWhereInput] }, select: { number: true, projectId: true, status: true } });
  if (!g) return null;
  return { projectId: g.projectId, label: g.number, canView: true, canUpload: can(actor, "grn.create") || can(actor, "grn.post"), locked: ["POSTED", "REVERSED"].includes(g.status) };
}

