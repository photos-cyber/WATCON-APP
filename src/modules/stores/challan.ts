import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addQty, cmpQty, subQty } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { assertProjectUsable, dec3, parseInput, projectRequiredScoped, projectScoped, requirePermission, transition } from "@/modules/commercial/core";
import { qtyField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { ensureSiteLocation, ensureSystemLocations, postMovementTx } from "@/modules/inventory/engine";
import { startOfToday } from "@/modules/tasks/rules";
import { advanceProjectStatus } from "@/modules/projects/lifecycle";

/**
 * Delivery challans.
 *  Internal (ISSUE_TO_SITE, SITE_TO_SITE, RETURN_TO_STORE): dispatch moves stock source → IN TRANSIT;
 *    the destination's GRN moves it in-transit → destination (partial / multiple receipts allowed);
 *    leftovers are reconciled by closing the discrepancy (return to source or write off). Nothing is
 *    ever added or deducted twice: dispatch and receipt each post their own leg exactly once.
 *  External (RETURN_TO_SUPPLIER, CLIENT_DELIVERY): dispatch deducts stock; delivery is confirmed with proof.
 */

export const CHALLAN_TYPES = ["ISSUE_TO_SITE", "SITE_TO_SITE", "RETURN_TO_STORE", "RETURN_TO_SUPPLIER", "CLIENT_DELIVERY"] as const;
const INTERNAL = ["ISSUE_TO_SITE", "SITE_TO_SITE", "RETURN_TO_STORE"];

const optId = uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null));
const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

export const challanSchema = z.object({
  type: z.enum(CHALLAN_TYPES),
  projectId: optId,
  fromLocationId: uuid,
  toLocationId: optId,
  partyId: optId,
  poId: optId,
  soId: optId,
  dispatchDate: dateString,
  expectedDate: optDate,
  vehicleNo: optionalText("Vehicle no.", 30),
  transporter: optionalText("Transporter", 120),
  lrNumber: optionalText("LR / docket no.", 60),
  driverName: optionalText("Driver", 120),
  driverPhone: optionalText("Driver phone", 20),
  senderName: optionalText("Sender", 120),
  receiverName: optionalText("Receiver", 120),
  remarks: optionalText("Remarks", 1000),
  lines: z.array(z.object({ itemBrandId: uuid, quantity: qtyField, poLineId: optId, soLineId: optId, remarks: optionalText("Remarks", 300) })).min(1, "Add at least one line.").max(200),
});
export type ChallanInput = z.input<typeof challanSchema>;

export const CHALLAN_TYPE_LABELS: Record<(typeof CHALLAN_TYPES)[number], string> = {
  ISSUE_TO_SITE: "Material issue to site",
  SITE_TO_SITE: "Site-to-site transfer",
  RETURN_TO_STORE: "Return to store",
  RETURN_TO_SUPPLIER: "Return to supplier",
  CLIENT_DELIVERY: "Client delivery",
};

async function validate(tx: Tx, actor: Actor, d: z.output<typeof challanSchema>) {
  const from = await tx.stockLocation.findFirst({ where: { id: d.fromLocationId, organizationId: actor.organizationId, status: "ACTIVE" } });
  if (!from || !["WAREHOUSE", "SITE"].includes(from.type)) throw new ValidationError("Choose an active warehouse or site to dispatch from.", { fromLocationId: "Invalid source." });
  const to = d.toLocationId ? await tx.stockLocation.findFirst({ where: { id: d.toLocationId, organizationId: actor.organizationId, status: "ACTIVE" } }) : null;
  let projectId = d.projectId;
  let partyId: string | null = null;
  switch (d.type) {
    case "ISSUE_TO_SITE":
      if (from.type !== "WAREHOUSE") throw new ValidationError("Material issues go from a warehouse.", { fromLocationId: "Choose a warehouse." });
      if (!to && !projectId) throw new ValidationError("Choose the destination site.", { toLocationId: "Required." });
      break;
    case "SITE_TO_SITE":
      if (from.type !== "SITE") throw new ValidationError("Choose the source site.", { fromLocationId: "Choose a site." });
      if (!to && !projectId) throw new ValidationError("Choose the destination site.", { toLocationId: "Required." });
      break;
    case "RETURN_TO_STORE":
      if (from.type !== "SITE") throw new ValidationError("Returns to store start at a site.", { fromLocationId: "Choose a site." });
      if (!to || to.type !== "WAREHOUSE") throw new ValidationError("Choose the receiving warehouse.", { toLocationId: "Choose a warehouse." });
      projectId = from.projectId;
      break;
    case "RETURN_TO_SUPPLIER":
    case "CLIENT_DELIVERY": {
      const party = d.partyId ? await tx.party.findFirst({ where: { id: d.partyId, organizationId: actor.organizationId } }) : null;
      if (!party || (d.type === "RETURN_TO_SUPPLIER" ? !party.isSupplier : !party.isClient)) throw new ValidationError(d.type === "RETURN_TO_SUPPLIER" ? "Choose the supplier." : "Choose the client.", { partyId: "Required." });
      partyId = party.id;
      projectId = projectId ?? from.projectId;
      break;
    }
  }
  let toLocationId: string | null = null;
  if (d.type === "ISSUE_TO_SITE" || d.type === "SITE_TO_SITE") {
    if (to) {
      if (to.type !== "SITE" || !to.projectId) throw new ValidationError("Destination must be a project site store.", { toLocationId: "Choose a site." });
      projectId = to.projectId;
      toLocationId = to.id;
    } else toLocationId = await ensureSiteLocation(tx, actor.organizationId, projectId!);
    if (toLocationId === from.id) throw new ValidationError("Source and destination are the same.", { toLocationId: "Same as source." });
  } else if (d.type === "RETURN_TO_STORE") toLocationId = to!.id;

  const ibs = await tx.itemBrand.findMany({ where: { id: { in: d.lines.map((l) => l.itemBrandId) }, organizationId: actor.organizationId }, select: { id: true, itemId: true } });
  const map = new Map(ibs.map((i) => [i.id, i.itemId]));
  d.lines.forEach((l, i) => {
    if (!map.has(l.itemBrandId)) throw new ValidationError("Item–brand not found.", { [`lines.${i}.itemBrandId`]: "Not found." });
  });
  if (d.type === "CLIENT_DELIVERY" && !d.soId) throw new ValidationError("Client deliveries must be made against the project's approved sales order.", { soId: "Choose the sales order." });
  if (d.soId) {
    const so = await tx.salesOrder.findFirst({ where: { id: d.soId, organizationId: actor.organizationId }, include: { lines: true } });
    if (!so || !["APPROVED", "PARTIALLY_FULFILLED"].includes(so.status)) throw new ValidationError("Deliveries can only be made against an approved sales order.", { soId: "Not approved." });
    if (d.projectId && so.projectId !== d.projectId) throw new ValidationError("The sales order belongs to a different project.", { soId: "Different project." });
    d.lines.forEach((l, i) => {
      if (!so.lines.some((x) => x.itemBrandId === l.itemBrandId)) throw new ValidationError("This material is not on the sales order.", { [`lines.${i}.itemBrandId`]: "Not on the sales order." });
    });
    d.lines.forEach((l, i) => {
      if (l.soLineId && !so.lines.some((x) => x.id === l.soLineId && x.itemBrandId === l.itemBrandId)) throw new ValidationError("Line does not match the sales order.", { [`lines.${i}.soLineId`]: "Mismatch." });
    });
    d.lines.forEach((l) => {
      if (!l.soLineId) l.soLineId = so.lines.find((x) => x.itemBrandId === l.itemBrandId)?.id ?? null;
    });
    partyId = so.partyId;
    projectId = so.projectId;
  } else if (d.lines.some((l) => l.soLineId)) {
    // Site issue traced to sales-order lines: each must be the same material on an order of this project.
    const ids = d.lines.map((l) => l.soLineId).filter((x): x is string => !!x);
    const sl = await tx.soLine.findMany({ where: { id: { in: ids }, so: { organizationId: actor.organizationId } }, select: { id: true, itemBrandId: true, so: { select: { projectId: true } } } });
    d.lines.forEach((l, i) => {
      if (!l.soLineId) return;
      const x = sl.find((s) => s.id === l.soLineId);
      if (!x || x.itemBrandId !== l.itemBrandId || !d.projectId || x.so.projectId !== d.projectId) throw new ValidationError("Line does not match a sales order of this project.", { [`lines.${i}.soLineId`]: "Mismatch." });
    });
  }
  if (d.poId) {
    const po = await tx.purchaseOrder.findFirst({ where: { id: d.poId, organizationId: actor.organizationId }, include: { lines: true } });
    if (!po || po.partyId !== partyId) throw new ValidationError("The PO must be with the same supplier.", { poId: "Mismatch." });
    d.lines.forEach((l, i) => {
      if (l.poLineId && !po.lines.some((x) => x.id === l.poLineId && x.itemBrandId === l.itemBrandId)) throw new ValidationError("Line does not match the PO.", { [`lines.${i}.poLineId`]: "Mismatch." });
      if (!l.poLineId) l.poLineId = po.lines.find((x) => x.itemBrandId === l.itemBrandId)?.id ?? null;
    });
  }
  return { projectId, partyId, toLocationId, itemIds: map };
}

export async function createChallan(actor: Actor, input: unknown) {
  requirePermission(actor, "stock.transfer");
  const d = parseInput(challanSchema, input);
  if (d.projectId) await assertProjectUsable(actor, d.projectId);
  return db.$transaction((tx) => createChallanTx(tx, actor, d));
}

/** Creates a draft challan inside the caller's transaction (no stock moves until dispatch). */
export async function createChallanTx(tx: Tx, actor: Actor, d: z.output<typeof challanSchema>, extra: { clientKey?: string | null } = {}) {
  {
    const v = await validate(tx, actor, d);
    if (v.projectId && v.projectId !== d.projectId) await assertProjectUsable(actor, v.projectId, tx);
    const number = await nextDocNumber(tx, actor.organizationId, "DC", toDbDate(d.dispatchDate)!);
    const c = await tx.challan.create({
      data: {
        organizationId: actor.organizationId,
        number,
        type: d.type,
        projectId: v.projectId,
        fromLocationId: d.fromLocationId,
        toLocationId: v.toLocationId,
        partyId: v.partyId,
        poId: d.poId,
        soId: d.soId,
        dispatchDate: toDbDate(d.dispatchDate),
        expectedDate: toDbDate(d.expectedDate),
        vehicleNo: d.vehicleNo,
        transporter: d.transporter,
        lrNumber: d.lrNumber,
        driverName: d.driverName,
        driverPhone: d.driverPhone,
        senderName: d.senderName,
        receiverName: d.receiverName,
        remarks: d.remarks,
        clientKey: extra.clientKey ?? null,
        createdById: actor.id,
        lines: { create: d.lines.map((l, i) => ({ lineNo: i + 1, itemBrandId: l.itemBrandId, itemId: v.itemIds.get(l.itemBrandId)!, quantity: l.quantity, poLineId: l.poLineId, soLineId: l.soLineId, remarks: l.remarks })) },
      },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "challan.created", entityType: "challan", entityId: c.id, projectId: c.projectId, summary: `Created ${CHALLAN_TYPE_LABELS[d.type].toLowerCase()} challan ${number} (${d.lines.length} lines)` }, tx);
    return c;
  }
}

async function loadChallan(actor: Actor, id: string, client: Tx | typeof db = db) {
  const c = await client.challan.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.ChallanWhereInput] }, include: { lines: true } });
  if (!c) throw new NotFoundError("Challan");
  return c;
}

/** Dispatch: posts the outbound leg once (idempotent keys), under a guarded status change. */
async function dispatch(actor: Actor, c: Awaited<ReturnType<typeof loadChallan>>, version: number) {
  await db.$transaction((tx) => dispatchChallanTx(tx, actor, c, version));
}

/** Dispatch inside the caller's transaction: source stock → in transit (internal) or out (external). */
export async function dispatchChallanTx(tx: Tx, actor: Actor, c: Prisma.ChallanGetPayload<{ include: { lines: true } }>, version: number) {
  const today = startOfToday();
  {
    await transition(tx.challan, { id: c.id, organizationId: actor.organizationId, version }, ["DRAFT"], { status: "DISPATCHED", dispatchedById: actor.id, dispatchedAt: new Date(), dispatchDate: c.dispatchDate ?? today }, "challan");
    const sys = await ensureSystemLocations(tx, actor.organizationId);
    const internal = INTERNAL.includes(c.type);
    for (const l of c.lines) {
      const base = { organizationId: actor.organizationId, actorId: actor.id, itemBrandId: l.itemBrandId, projectId: c.projectId, txnDate: today, today, quantity: dec3(l.quantity), reference: c.number, sourceType: "challan", sourceId: c.id };
      if (internal) {
        await postMovementTx(tx, { ...base, locationId: c.fromLocationId!, type: "TRANSFER_OUT", direction: "OUT", idempotencyKey: `challan:${c.id}:${l.id}:out` });
        await postMovementTx(tx, { ...base, locationId: sys.TRANSIT, type: "TRANSFER_IN", direction: "IN", idempotencyKey: `challan:${c.id}:${l.id}:transit` });
      } else {
        await postMovementTx(tx, { ...base, locationId: c.fromLocationId!, type: c.type === "RETURN_TO_SUPPLIER" ? "RETURN_TO_SUPPLIER" : "CLIENT_DELIVERY", direction: "OUT", idempotencyKey: `challan:${c.id}:${l.id}:out` });
        if (l.poLineId) {
          const [pl] = await tx.$queryRaw<{ rejected_qty: string; returned_qty: string; accepted_qty: string }[]>`SELECT rejected_qty::text, returned_qty::text, accepted_qty::text FROM po_lines WHERE id = ${l.poLineId}::uuid FOR UPDATE`;
          if (cmpQty(addQty(pl!.returned_qty, dec3(l.quantity)), pl!.accepted_qty) > 0) throw new ValidationError(`Line ${l.lineNo}: returning more than was accepted on the PO line.`);
          await tx.poLine.update({ where: { id: l.poLineId }, data: { returnedQty: { increment: dec3(l.quantity) } } });
        }
        if (l.soLineId) {
          const [sl] = await tx.$queryRaw<{ quantity: string; delivered_qty: string; returned_qty: string }[]>`SELECT quantity::text, delivered_qty::text, returned_qty::text FROM so_lines WHERE id = ${l.soLineId}::uuid FOR UPDATE`;
          const net = subQty(sl!.delivered_qty, sl!.returned_qty);
          if (cmpQty(addQty(net, dec3(l.quantity)), sl!.quantity) > 0) throw new ValidationError(`Line ${l.lineNo}: delivery exceeds the sales-order quantity (${sl!.quantity}, delivered ${net}).`);
          await tx.soLine.update({ where: { id: l.soLineId }, data: { deliveredQty: { increment: dec3(l.quantity) } } });
        }
      }
    }
    if (c.soId) await refreshSoFulfilment(tx, c.soId);
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "challan.dispatched", entityType: "challan", entityId: c.id, projectId: c.projectId, summary: `Dispatched challan ${c.number}${internal ? " (stock now in transit)" : ""}` }, tx);
  }
}

export async function refreshSoFulfilment(tx: Tx, soId: string) {
  const so = await tx.salesOrder.findUnique({ where: { id: soId }, include: { lines: true } });
  if (!so || !["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED"].includes(so.status)) return;
  const net = (l: (typeof so.lines)[number]) => subQty(dec3(l.deliveredQty), dec3(l.returnedQty));
  const any = so.lines.some((l) => cmpQty(net(l), "0") > 0);
  const all = so.lines.every((l) => cmpQty(net(l), dec3(l.quantity)) >= 0);
  const status = all ? "FULFILLED" : any ? "PARTIALLY_FULFILLED" : "APPROVED";
  if (status !== so.status) {
    await tx.salesOrder.update({ where: { id: soId }, data: { status, version: { increment: 1 } } });
    await advanceProjectStatus(tx, so.projectId, null);
  }
}

/** Internal challans: derive receipt status from line counters (called by GRN posting / reversal). */
export async function refreshChallanStatus(tx: Tx, challanId: string) {
  const c = await tx.challan.findUnique({ where: { id: challanId }, include: { lines: true } });
  if (!c || !["DISPATCHED", "PARTIALLY_RECEIVED", "RECEIVED"].includes(c.status)) return;
  const done = c.lines.every((l) => cmpQty(addQty(dec3(l.receivedQty), dec3(l.writtenOffQty)), dec3(l.quantity)) >= 0);
  const any = c.lines.some((l) => cmpQty(dec3(l.receivedQty), "0") > 0);
  const status = done ? "RECEIVED" : any ? "PARTIALLY_RECEIVED" : "DISPATCHED";
  if (status !== c.status) await tx.challan.update({ where: { id: challanId }, data: { status, version: { increment: 1 } } });
}

/** Signed challan / proof of delivery uploaded on the challan (any non-deleted file in those categories). */
export async function hasDeliveryProof(client: Tx | typeof db, challanId: string) {
  return (await client.attachment.count({ where: { entityType: "challan", entityId: challanId, deletedAt: null, category: { in: ["SIGNED_CHALLAN", "DELIVERY_CHALLAN"] } } })) > 0;
}

export async function challanAction(actor: Actor, id: string, action: "dispatch" | "deliver" | "cancel" | "close_discrepancy", opts: { version: number; note?: string | null; resolution?: "RETURN" | "WRITE_OFF"; deliveredDate?: string | null; receiverName?: string | null }) {
  requirePermission(actor, "stock.transfer");
  const c = await loadChallan(actor, id);
  if (c.projectId) await assertProjectUsable(actor, c.projectId);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  if (action === "dispatch") return dispatch(actor, c, opts.version);
  if (action === "cancel") {
    if (!opts.note) throw new ValidationError("Give a reason.", { note: "Reason is required." });
    return db.$transaction(async (tx) => {
      await transition(tx.challan, w, ["DRAFT"], { status: "CANCELLED", statusNote: opts.note }, "challan");
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "challan.cancelled", entityType: "challan", entityId: id, projectId: c.projectId, summary: `Cancelled challan ${c.number} – ${opts.note}` }, tx);
    });
  }
  if (action === "deliver") {
    if (INTERNAL.includes(c.type)) throw new ValidationError("Internal transfers are received with a site receipt (GRN) at the destination.");
    // Simplified workflow: a client delivery is confirmed only with proof (signed challan / POD).
    if (c.type === "CLIENT_DELIVERY" && !(await hasDeliveryProof(db, id))) throw new ValidationError("Upload the signed challan or proof of delivery first, then confirm the delivery.", { proof: "Signed challan / POD required." });
    return db.$transaction(async (tx) => {
      await transition(tx.challan, w, ["DISPATCHED"], { status: "DELIVERED", deliveredDate: toDbDate(opts.deliveredDate ?? null) ?? startOfToday(), receiverName: opts.receiverName ?? c.receiverName, statusNote: opts.note ?? null }, "challan");
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "challan.delivered", entityType: "challan", entityId: id, projectId: c.projectId, summary: `Confirmed delivery of challan ${c.number}${opts.receiverName ? ` (received by ${opts.receiverName})` : ""}` }, tx);
    });
  }
  // close_discrepancy: whatever is still in transit is returned to the source or written off.
  if (!INTERNAL.includes(c.type)) throw new ValidationError("Only internal transfers have an in-transit balance.");
  if (!opts.note) throw new ValidationError("Explain the discrepancy.", { note: "Reason is required." });
  const resolution = opts.resolution ?? "WRITE_OFF";
  if (resolution === "WRITE_OFF" && !can(actor, "stock.adjust")) throw new ValidationError("Writing off stock needs the Stock adjustments permission. Choose “Return to source” or ask an authorised user.");
  const today = startOfToday();
  return db.$transaction(async (tx) => {
    await transition(tx.challan, w, ["DISPATCHED", "PARTIALLY_RECEIVED"], { status: "CLOSED", statusNote: `${resolution === "RETURN" ? "Returned to source" : "Written off"}: ${opts.note}` }, "challan");
    const sys = await ensureSystemLocations(tx, actor.organizationId);
    for (const l of c.lines) {
      const left = subQty(dec3(l.quantity), addQty(dec3(l.receivedQty), dec3(l.writtenOffQty)));
      if (cmpQty(left, "0") <= 0) continue;
      const base = { organizationId: actor.organizationId, actorId: actor.id, itemBrandId: l.itemBrandId, projectId: c.projectId, txnDate: today, today, quantity: left, reference: c.number, reason: opts.note, sourceType: "challan", sourceId: c.id };
      if (resolution === "RETURN") {
        await postMovementTx(tx, { ...base, locationId: sys.TRANSIT, type: "TRANSFER_OUT", direction: "OUT", idempotencyKey: `challan:${c.id}:${l.id}:ret-out` });
        await postMovementTx(tx, { ...base, locationId: c.fromLocationId!, type: "TRANSFER_IN", direction: "IN", idempotencyKey: `challan:${c.id}:${l.id}:ret-in` });
      } else {
        await postMovementTx(tx, { ...base, locationId: sys.TRANSIT, type: "WRITE_OFF", direction: "OUT", idempotencyKey: `challan:${c.id}:${l.id}:writeoff` });
      }
      await tx.challanLine.update({ where: { id: l.id }, data: { writtenOffQty: { increment: left } } });
    }
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "challan.discrepancy_closed", entityType: "challan", entityId: id, projectId: c.projectId, summary: `Closed transit discrepancy on ${c.number} (${resolution === "RETURN" ? "returned to source" : "written off"}) – ${opts.note}` }, tx);
  });
}

export async function getChallan(actor: Actor, id: string) {
  requirePermission(actor, "grn.view");
  const c = await db.challan.findFirst({
    where: { AND: [{ id }, projectScoped(actor) as Prisma.ChallanWhereInput] },
    include: {
      project: { select: { id: true, code: true, name: true } },
      fromLocation: { select: { id: true, name: true, address: true } },
      toLocation: { select: { id: true, name: true, address: true } },
      party: { select: { id: true, name: true, address: true, gstin: true } },
      po: { select: { id: true, number: true } },
      so: { select: { id: true, number: true } },
      createdBy: { select: { fullName: true } },
      dispatchedBy: { select: { fullName: true } },
      grns: { select: { id: true, number: true, status: true, receiptDate: true } },
      lines: { orderBy: { lineNo: "asc" }, include: { itemBrand: { select: { item: { select: { id: true, code: true, name: true, unit: true, hsnCode: true } }, brand: { select: { name: true } } } } } },
    },
  });
  if (!c) throw new NotFoundError("Challan");
  const internal = INTERNAL.includes(c.type);
  const transit = c.lines.some((l) => cmpQty(subQty(dec3(l.quantity), addQty(dec3(l.receivedQty), dec3(l.writtenOffQty))), "0") > 0);
  const manage = can(actor, "stock.transfer");
  const needsPod = c.type === "CLIENT_DELIVERY" && c.status === "DISPATCHED";
  const podMissing = needsPod && !(await hasDeliveryProof(db, c.id));
  return {
    challan: { ...c, lines: c.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), receivedQty: dec3(l.receivedQty), damagedQty: dec3(l.damagedQty), writtenOffQty: dec3(l.writtenOffQty), inTransit: subQty(dec3(l.quantity), addQty(dec3(l.receivedQty), dec3(l.writtenOffQty))) })) },
    internal,
    /** Client delivery waiting for its signed challan / POD before it can be confirmed. */
    podMissing,
    can: {
      dispatch: manage && c.status === "DRAFT",
      cancel: manage && c.status === "DRAFT",
      deliver: manage && !internal && c.status === "DISPATCHED" && !podMissing,
      receive: can(actor, "grn.create") && internal && ["DISPATCHED", "PARTIALLY_RECEIVED"].includes(c.status),
      closeDiscrepancy: manage && internal && ["DISPATCHED", "PARTIALLY_RECEIVED"].includes(c.status) && transit,
      writeOff: can(actor, "stock.adjust"),
    },
  };
}

export const challanListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  type: z.enum(CHALLAN_TYPES).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export function challanWhere(actor: Actor, q: z.output<typeof challanListQuerySchema>): Prisma.ChallanWhereInput {
  return {
    AND: [
      projectScoped(actor) as Prisma.ChallanWhereInput,
      q.status ? { status: q.status as Prisma.EnumChallanStatusFilter["equals"] } : {},
      q.type ? { type: q.type } : {},
      q.projectId ? { OR: [{ projectId: q.projectId }, { toLocation: { projectId: q.projectId } }, { fromLocation: { projectId: q.projectId } }] } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { vehicleNo: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }] } : {},
    ],
  };
}

export async function listChallans(actor: Actor, raw: unknown) {
  requirePermission(actor, "grn.view");
  const q = challanListQuerySchema.parse(raw ?? {});
  const where = challanWhere(actor, q);
  const [total, rows, byStatus] = await Promise.all([
    db.challan.count({ where }),
    db.challan.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, fromLocation: { select: { name: true } }, toLocation: { select: { name: true } }, party: { select: { name: true } }, _count: { select: { lines: true } } } }),
    db.challan.groupBy({ by: ["status"], where: { AND: [projectScoped(actor) as Prisma.ChallanWhereInput] }, _count: true }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, query: q, rows, byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number> };
}

export async function challanAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "grn.view")) return null;
  const c = await db.challan.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.ChallanWhereInput] }, select: { number: true, projectId: true, status: true } });
  if (!c) return null;
  return { projectId: c.projectId, label: c.number, canView: true, canUpload: can(actor, "stock.transfer") || can(actor, "grn.create"), locked: c.status !== "DRAFT" && c.status !== "DISPATCHED" };
}

/** Everything the challan form needs: on-hand per location, open POs (supplier returns) and approved SOs (client deliveries). */
export async function challanFormData(actor: Actor) {
  requirePermission(actor, "stock.transfer");
  const [balances, pos, sos] = await Promise.all([
    db.stockBalance.findMany({ where: { organizationId: actor.organizationId, onHand: { gt: 0 } }, select: { itemBrandId: true, locationId: true, onHand: true } }),
    db.purchaseOrder.findMany({ where: { AND: [projectScoped(actor) as Prisma.PurchaseOrderWhereInput, { status: { in: ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED"] } }] }, orderBy: { orderDate: "desc" }, take: 300, select: { id: true, number: true, partyId: true, projectId: true } }),
    db.salesOrder.findMany({ where: { AND: [projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput, { status: { in: ["APPROVED", "PARTIALLY_FULFILLED"] } }] }, orderBy: { orderDate: "desc" }, take: 300, select: { id: true, number: true, partyId: true, projectId: true, lines: { select: { itemBrandId: true, quantity: true, deliveredQty: true, returnedQty: true } } } }),
  ]);
  return {
    stock: balances.map((b) => ({ itemBrandId: b.itemBrandId, locationId: b.locationId, onHand: dec3(b.onHand) })),
    pos,
    // Only orders with material still to deliver — service-only or fully delivered orders have
    // nothing a delivery challan could carry.
    sos: sos
      .map((s) => ({ id: s.id, number: s.number, partyId: s.partyId, projectId: s.projectId, lines: s.lines.filter((l) => l.itemBrandId).map((l) => ({ itemBrandId: l.itemBrandId!, pending: subQty(dec3(l.quantity), subQty(dec3(l.deliveredQty), dec3(l.returnedQty))) })) }))
      .filter((s) => s.lines.some((l) => Number(l.pending) > 0)),
  };
}
