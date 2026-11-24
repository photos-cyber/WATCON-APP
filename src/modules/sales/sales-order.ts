import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addQty, cmpQty, maxQty, subQty, taxModeFor } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { approvalHint, assertCanApprove, assertProjectUsable, assertProjectVisible, dec2, dec3, dec4, getCommercialSettings, parseInput, projectRequiredScoped, requirePermission, transition } from "@/modules/commercial/core";
import { gstRateField, optPct, priceDocument, projectIdField, qtyField, rateField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { refreshSoFulfilment } from "@/modules/stores/challan";
import { soQtyByLine } from "./client-po";
import { loadClient, lockClientPo, optDate, optId } from "./shared";
import { advanceProjectStatus } from "@/modules/projects/lifecycle";

/**
 * Sales orders — the driver of each project.
 *   DRAFT → PENDING_APPROVAL → APPROVED / REJECTED → PARTIALLY_FULFILLED → FULFILLED → CLOSED
 * An approved order is LOCKED: nobody edits it directly. Changes go through an amendment request
 * that only a Super Admin (not the requester) can approve; approval applies the change, bumps the
 * revision and re-syncs the project's material requirements (which drive PR → RFQ → PO).
 */

const soLineSchema = z.object({
  id: optId,
  clientPoLineId: optId,
  itemBrandId: optId,
  description: optionalText("Description", 500),
  hsnSac: optionalText("HSN/SAC", 10),
  unit: optionalText("Unit", 20),
  quantity: qtyField,
  rate: rateField,
  discountPct: optPct,
  gstRate: gstRateField,
});

const headerFields = {
  deliveryDate: optDate,
  deliveryAddress: optionalText("Delivery address", 500),
  deliverySchedule: optionalText("Delivery schedule", 1000),
  billingSchedule: optionalText("Billing schedule", 1000),
  paymentTerms: optionalText("Payment terms", 500),
  notes: optionalText("Notes", 2000),
  lines: z.array(soLineSchema).min(1, "Add at least one line.").max(500),
};

export const soSchema = z.object({ projectId: projectIdField, partyId: uuid, clientPoId: optId, orderDate: dateString, ...headerFields });
export const soAmendmentSchema = z.object({ reason: text("Reason", 1000, 5), ...headerFields });

type SoData = z.output<typeof soSchema>;
type SoLineData = z.output<typeof soLineSchema>;

const EDITABLE = ["DRAFT", "REJECTED"] as const;
const LOCKED = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED"] as const;
/** Orders whose lines drive project material requirements. */
const DRIVING = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] as const;

const scoped = (actor: Actor) => projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput;

async function loadScoped(actor: Actor, id: string, client: Tx | typeof db = db) {
  const so = await client.salesOrder.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: { lines: true } });
  if (!so) throw new NotFoundError("Sales order");
  return so;
}

/** Validates, prices and resolves the lines; enforces the client-PO ceiling (caller holds the client-PO lock). */
async function buildSo(tx: Tx, actor: Actor, data: SoData, excludeSoId?: string) {
  const party = await loadClient(tx, actor, data.partyId);
  const settings = await getCommercialSettings(actor.organizationId, tx);
  let cpo: { id: string; placeOfSupply: string | null; lines: { id: string; quantity: Prisma.Decimal; description: string; unit: string; hsnSac: string | null; lineNo: number }[] } | null = null;
  if (data.clientPoId) {
    const c = await tx.clientPo.findFirst({ where: { id: data.clientPoId, organizationId: actor.organizationId }, include: { lines: true } });
    if (!c || c.status !== "ACTIVE") throw new ValidationError("Choose an approved (active) client PO.", { clientPoId: "Not active." });
    if (c.projectId !== data.projectId || c.partyId !== data.partyId) throw new ValidationError("The client PO belongs to another project or client.", { clientPoId: "Different project / client." });
    cpo = c;
  }
  const mode = taxModeFor(settings.stateCode, cpo?.placeOfSupply ?? party.stateCode);
  const ibIds = [...new Set(data.lines.map((l) => l.itemBrandId).filter(Boolean) as string[])];
  const ibs = await tx.itemBrand.findMany({ where: { id: { in: ibIds }, organizationId: actor.organizationId }, include: { item: { select: { name: true, unit: true, hsnCode: true, status: true } }, brand: { select: { name: true, status: true } } } });
  const ibMap = new Map(ibs.map((i) => [i.id, i]));
  const cpoLines = new Map((cpo?.lines ?? []).map((l) => [l.id, l]));
  const resolved = data.lines.map((l, i) => {
    const f = (k: string) => `lines.${i}.${k}`;
    if (l.itemBrandId) {
      const ib = ibMap.get(l.itemBrandId);
      if (!ib) throw new ValidationError("Item–brand not found.", { [f("itemBrandId")]: "Not found." });
      if (ib.item.status !== "ACTIVE" || ib.brand.status !== "ACTIVE") throw new ValidationError(`${ib.item.name} (${ib.brand.name}) is inactive.`, { [f("itemBrandId")]: "Inactive." });
    }
    if (l.clientPoLineId && !cpoLines.has(l.clientPoLineId)) throw new ValidationError("A line does not belong to the selected client PO.", { [f("clientPoLineId")]: "Not on this client PO." });
    const ib = l.itemBrandId ? ibMap.get(l.itemBrandId) : undefined;
    const cl = l.clientPoLineId ? cpoLines.get(l.clientPoLineId) : undefined;
    const description = l.description ?? (ib ? `${ib.item.name} – ${ib.brand.name}` : cl?.description) ?? null;
    const unit = l.unit ?? ib?.item.unit ?? cl?.unit ?? null;
    if (!description) throw new ValidationError("Pick an item or describe the line.", { [f("description")]: "Required." });
    if (!unit) throw new ValidationError("Give the unit for this line.", { [f("unit")]: "Required." });
    return { ...l, description, unit, hsnSac: l.hsnSac ?? ib?.item.hsnCode ?? cl?.hsnSac ?? null };
  });
  if (cpo) {
    const others = await soQtyByLine(tx, cpo.id, excludeSoId);
    const mine = new Map<string, string>();
    for (const l of resolved) if (l.clientPoLineId) mine.set(l.clientPoLineId, addQty(mine.get(l.clientPoLineId) ?? "0", l.quantity));
    for (const [lineId, qty] of mine) {
      const cl = cpoLines.get(lineId)!;
      const used = others.get(lineId) ?? "0";
      if (cmpQty(addQty(used, qty), dec3(cl.quantity)) > 0) {
        const left = cmpQty(dec3(cl.quantity), used) > 0 ? subQty(dec3(cl.quantity), used) : "0";
        throw new ValidationError(`Client PO line ${cl.lineNo} (${cl.description}): only ${left} ${cl.unit} is left to order (contract ${dec3(cl.quantity)}, already on other sales orders ${used}).`, { lines: `Over the client PO quantity on line ${cl.lineNo}.` });
      }
    }
  }
  const priced = priceDocument(resolved, mode, {});
  const header = {
    projectId: data.projectId,
    partyId: party.id,
    clientPoId: data.clientPoId,
    orderDate: toDbDate(data.orderDate)!,
    deliveryDate: toDbDate(data.deliveryDate),
    deliveryAddress: data.deliveryAddress,
    deliverySchedule: data.deliverySchedule,
    billingSchedule: data.billingSchedule,
    paymentTerms: data.paymentTerms ?? (party.paymentTermsDays !== null ? `${party.paymentTermsDays} days from invoice` : null),
    notes: data.notes,
    taxMode: mode,
    taxable: priced.totals.taxable,
    taxAmount: priced.totals.tax,
    total: priced.totals.total,
  };
  const lines = priced.lines.map((l, i) => ({ id: l.id, lineNo: i + 1, clientPoLineId: l.clientPoLineId, itemBrandId: l.itemBrandId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax, total: l.amounts.total }));
  return { header, lines, party };
}

/** Applies a new line set to an existing order, matching by id; delivered / invoiced lines keep their history. */
async function applyLines(tx: Tx, soId: string, before: { id: string; lineNo: number; itemBrandId: string | null; deliveredQty: Prisma.Decimal; returnedQty: Prisma.Decimal; invoicedQty: Prisma.Decimal }[], lines: Awaited<ReturnType<typeof buildSo>>["lines"]) {
  const existing = new Map(before.map((l) => [l.id, l]));
  const kept = new Set<string>();
  for (const old of before) await tx.soLine.update({ where: { id: old.id }, data: { lineNo: 5000 + old.lineNo } });
  for (const l of lines) {
    const { id: lineId, ...rest } = l;
    const old = lineId ? existing.get(lineId) : undefined;
    if (lineId && !old) throw new ValidationError("A line does not belong to this sales order.");
    if (old) {
      kept.add(old.id);
      const delivered = dec3(old.deliveredQty);
      const invoiced = dec3(old.invoicedQty);
      const floor = maxQty(delivered, invoiced);
      if (cmpQty(l.quantity, floor) < 0) throw new ValidationError(`Line ${l.lineNo}: quantity cannot be below what was already delivered (${delivered}) or invoiced (${invoiced}).`, { [`lines.${l.lineNo - 1}.quantity`]: `Minimum ${floor}.` });
      if (old.itemBrandId !== l.itemBrandId && cmpQty(floor, "0") > 0) throw new ValidationError(`Line ${l.lineNo}: the item of a delivered or invoiced line cannot change.`);
      await tx.soLine.update({ where: { id: old.id }, data: rest });
    } else {
      await tx.soLine.create({ data: { ...rest, soId } });
    }
  }
  for (const old of before) {
    if (kept.has(old.id)) continue;
    if (cmpQty(dec3(old.deliveredQty), "0") > 0 || cmpQty(dec3(old.invoicedQty), "0") > 0) throw new ValidationError(`Line ${old.lineNo} has deliveries or invoices and cannot be removed. Reduce it to the delivered quantity instead.`);
    const refs = (await tx.challanLine.count({ where: { soLineId: old.id } })) + (await tx.invoiceLine.count({ where: { soLineId: old.id } })) + (await tx.materialRequirement.count({ where: { salesOrderLineId: old.id } }));
    if (refs) {
      // Referenced by history (challans / requirements): keep the row but zero it out is not allowed by the qty CHECK, so refuse.
      const req = await tx.materialRequirement.findMany({ where: { salesOrderLineId: old.id }, select: { id: true } });
      if (req.length && refs === req.length) {
        await tx.materialRequirement.updateMany({ where: { salesOrderLineId: old.id }, data: { salesOrderLineId: null } });
      } else {
        throw new ValidationError(`Line ${old.lineNo} is referenced by challans or invoices and cannot be removed.`);
      }
    }
    await tx.soLine.delete({ where: { id: old.id } });
  }
}

// ─────────────────────────── Material requirements sync ───────────────────────────

/**
 * Re-derives the project's material requirements from its driving sales orders:
 *   requiredQty(item–brand) = Σ quantity of lines on approved / in-fulfilment orders
 *                             (closed orders count what was actually delivered),
 * never below what has already been requisitioned for it, never deleted (cancelled when zero).
 */
export async function syncRequirementsFromSo(tx: Tx, organizationId: string, actorId: string, projectId: string) {
  const lines = await tx.soLine.findMany({
    where: { itemBrandId: { not: null }, so: { projectId, organizationId, status: { in: [...DRIVING] } } },
    select: { id: true, itemBrandId: true, quantity: true, deliveredQty: true, returnedQty: true, so: { select: { status: true, deliveryDate: true, number: true, createdAt: true } } },
    orderBy: [{ so: { createdAt: "asc" } }, { lineNo: "asc" }],
  });
  const agg = new Map<string, { qty: string; firstLineId: string; requiredBy: Date | null; numbers: Set<string> }>();
  for (const l of lines) {
    const q = l.so.status === "CLOSED" ? subQty(dec3(l.deliveredQty), dec3(l.returnedQty)) : dec3(l.quantity);
    const a = agg.get(l.itemBrandId!) ?? { qty: "0", firstLineId: l.id, requiredBy: null, numbers: new Set<string>() };
    a.qty = addQty(a.qty, cmpQty(q, "0") > 0 ? q : "0");
    if (l.so.deliveryDate && (!a.requiredBy || l.so.deliveryDate < a.requiredBy)) a.requiredBy = l.so.deliveryDate;
    a.numbers.add(l.so.number);
    agg.set(l.itemBrandId!, a);
  }
  const soSourced = await tx.materialRequirement.findMany({ where: { projectId, OR: [{ salesOrderLineId: { not: null } }, { itemBrandId: { in: [...agg.keys()] } }] } });
  const existing = new Map(soSourced.map((r) => [r.itemBrandId, r]));
  const keys = new Set([...agg.keys(), ...soSourced.filter((r) => r.salesOrderLineId).map((r) => r.itemBrandId)]);
  for (const ibId of keys) {
    const a = agg.get(ibId);
    const req = existing.get(ibId);
    const requisitioned = req
      ? (await tx.prLine.findMany({ where: { requirementId: req.id, pr: { status: { notIn: ["CANCELLED", "REJECTED"] } } }, select: { quantity: true } })).reduce((s, p) => addQty(s, dec3(p.quantity)), "0")
      : "0";
    const target = maxQty(a?.qty ?? "0", requisitioned);
    const note = a ? `From sales orders: ${[...a.numbers].join(", ")}` : "No active sales order lines";
    if (req) {
      if (cmpQty(target, "0") <= 0) {
        if (req.status !== "CANCELLED") {
          await tx.materialRequirement.update({ where: { id: req.id }, data: { status: "CANCELLED", notes: note, version: { increment: 1 } } });
          await writeAudit({ organizationId, actorId, action: "requirement.so_sync", entityType: "material_requirement", entityId: req.id, projectId, summary: `Requirement cancelled – no active sales-order quantity (was ${dec3(req.requiredQty)})` }, tx);
        }
        continue;
      }
      if (cmpQty(target, dec3(req.requiredQty)) === 0 && req.status === "OPEN" && req.salesOrderLineId) continue;
      await tx.materialRequirement.update({ where: { id: req.id }, data: { requiredQty: target, status: "OPEN", salesOrderLineId: req.salesOrderLineId ?? a?.firstLineId ?? null, requiredBy: req.requiredBy ?? a?.requiredBy ?? null, notes: note, version: { increment: 1 } } });
      await writeAudit({ organizationId, actorId, action: "requirement.so_sync", entityType: "material_requirement", entityId: req.id, projectId, summary: `Requirement set to ${target} from sales orders (was ${dec3(req.requiredQty)})` }, tx);
    } else if (a && cmpQty(target, "0") > 0) {
      const ib = await tx.itemBrand.findUniqueOrThrow({ where: { id: ibId }, select: { itemId: true } });
      const row = await tx.materialRequirement.create({ data: { organizationId, projectId, itemBrandId: ibId, itemId: ib.itemId, requiredQty: target, requiredBy: a.requiredBy, notes: note, salesOrderLineId: a.firstLineId, createdById: actorId } });
      await writeAudit({ organizationId, actorId, action: "requirement.so_sync", entityType: "material_requirement", entityId: row.id, projectId, summary: `Requirement of ${target} created from sales orders` }, tx);
    }
  }
}

// ─────────────────────────── Commands ───────────────────────────

export async function createSalesOrder(actor: Actor, input: unknown) {
  requirePermission(actor, "so.manage");
  const data = parseInput(soSchema, input);
  const project = await assertProjectUsable(actor, data.projectId);
  return db.$transaction((tx) => createSalesOrderTx(tx, actor, data, project.code));
}

/** Creates a draft sales order inside the caller's transaction (also used by quotation → SO). */
export async function createSalesOrderTx(tx: Tx, actor: Actor, input: unknown, projectCode: string, auditSuffix = "") {
  const data = parseInput(soSchema, input);
  if (data.clientPoId) await lockClientPo(tx, data.clientPoId);
  const { header, lines, party } = await buildSo(tx, actor, data);
  const number = await nextDocNumber(tx, actor.organizationId, "SO", header.orderDate);
  const so = await tx.salesOrder.create({ data: { organizationId: actor.organizationId, number, ...header, createdById: actor.id, lines: { create: lines.map(({ id: _id, ...l }) => l) } } });
  await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.created", entityType: "sales_order", entityId: so.id, projectId: so.projectId, summary: `Created sales order ${number} for ${party.name} (${projectCode}) – ₹${header.total}${auditSuffix}` }, tx);
  return so;
}

export async function updateSalesOrder(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "so.manage");
  const data = parseInput(soSchema, input);
  const before = await loadScoped(actor, id);
  if ((LOCKED as readonly string[]).includes(before.status) || before.status === "CLOSED") throw new ForbiddenError("This sales order is approved and locked. Raise an amendment request; a Super Admin will review it.");
  if (!(EDITABLE as readonly string[]).includes(before.status)) throw new ValidationError("Only draft or rejected sales orders can be edited.");
  if (data.projectId !== before.projectId) throw new ValidationError("A sales order cannot move to another project.", { projectId: "Cannot change." });
  await assertProjectUsable(actor, data.projectId);
  return db.$transaction(async (tx) => {
    if (data.clientPoId) await lockClientPo(tx, data.clientPoId);
    const { header, lines } = await buildSo(tx, actor, data, id);
    await applyLines(tx, id, before.lines, lines);
    await transition(tx.salesOrder, { id, organizationId: actor.organizationId, version }, EDITABLE, { ...header, status: "DRAFT", statusNote: null }, "sales order");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.updated", entityType: "sales_order", entityId: id, projectId: before.projectId, summary: `Edited sales order ${before.number} – ₹${header.total}` }, tx);
  });
}

export type SoAction = "submit" | "approve" | "reject" | "close" | "cancel";

export async function salesOrderAction(actor: Actor, id: string, action: SoAction, opts: { version: number; note?: string | null }) {
  const so = await loadScoped(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string, extra = "") => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `so.${action}`, entityType: "sales_order", entityId: id, projectId: so.projectId, summary: `${verb} sales order ${so.number}${extra}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new ValidationError(msg, { note: msg });
  };
  switch (action) {
    case "submit":
      requirePermission(actor, "so.manage");
      return db.$transaction(async (tx) => {
        await transition(tx.salesOrder, w, EDITABLE, { status: "PENDING_APPROVAL", submittedById: actor.id, submittedAt: new Date(), statusNote: null }, "sales order");
        await log(tx, "Submitted", ` for approval (₹${dec2(so.total)})`);
      });
    case "approve":
    case "reject":
      await assertCanApprove(actor, { permission: "so.approve", docType: "SO", amount: dec2(so.total), createdById: so.createdById, submittedById: so.submittedById, what: "sales order" });
      if (action === "reject") need(opts.note, "Give a reason for rejecting.");
      return db.$transaction(async (tx) => {
        if (action === "approve") {
          // Re-check the contract ceiling at approval time (other orders may have been approved meanwhile).
          if (so.clientPoId) {
            await lockClientPo(tx, so.clientPoId);
            const others = await soQtyByLine(tx, so.clientPoId, so.id);
            const cl = await tx.clientPoLine.findMany({ where: { clientPoId: so.clientPoId } });
            for (const l of so.lines) {
              if (!l.clientPoLineId) continue;
              const c = cl.find((x) => x.id === l.clientPoLineId)!;
              if (cmpQty(addQty(others.get(c.id) ?? "0", dec3(l.quantity)), dec3(c.quantity)) > 0) throw new ValidationError(`Line ${l.lineNo} now exceeds what is left on client PO line ${c.lineNo}. Reject it so the quantity can be corrected.`);
            }
          }
          await transition(tx.salesOrder, w, ["PENDING_APPROVAL"], { status: "APPROVED", approvedById: actor.id, approvedAt: new Date(), statusNote: null }, "sales order");
          await log(tx, "Approved", ` (₹${dec2(so.total)}) — now locked; changes need an amendment request`);
          await syncRequirementsFromSo(tx, actor.organizationId, actor.id, so.projectId);
          await advanceProjectStatus(tx, so.projectId, actor.id);
        } else {
          await transition(tx.salesOrder, w, ["PENDING_APPROVAL"], { status: "REJECTED", statusNote: opts.note }, "sales order");
          await log(tx, "Rejected");
        }
      });
    case "close":
      requirePermission(actor, "so.approve");
      need(opts.note, "Give a reason for closing.");
      return db.$transaction(async (tx) => {
        await transition(tx.salesOrder, w, LOCKED, { status: "CLOSED", statusNote: opts.note }, "sales order");
        await tx.soAmendmentRequest.updateMany({ where: { soId: id, status: "PENDING" }, data: { status: "WITHDRAWN", decisionNote: "Sales order closed", decidedAt: new Date() } });
        await log(tx, "Closed");
        await syncRequirementsFromSo(tx, actor.organizationId, actor.id, so.projectId);
        await advanceProjectStatus(tx, so.projectId, actor.id);
      });
    case "cancel": {
      requirePermission(actor, "so.approve");
      need(opts.note, "Give a reason for cancelling.");
      return db.$transaction(async (tx) => {
        const lines = await tx.$queryRaw<{ delivered_qty: string; invoiced_qty: string }[]>`SELECT delivered_qty::text, invoiced_qty::text FROM so_lines WHERE so_id = ${id}::uuid FOR UPDATE`;
        if (lines.some((l) => cmpQty(l.delivered_qty, "0") > 0)) throw new ValidationError("Material has already been delivered against this order, so it cannot be cancelled. Close it instead.");
        if (lines.some((l) => cmpQty(l.invoiced_qty, "0") > 0)) throw new ValidationError("Invoices exist against this order. Cancel them first, or close the order.");
        const challans = await tx.challan.count({ where: { soId: id, status: { notIn: ["CANCELLED"] } } });
        if (challans) throw new ValidationError("Delivery challans exist for this order. Cancel them first.");
        await transition(tx.salesOrder, w, ["DRAFT", "PENDING_APPROVAL", "REJECTED", "APPROVED"], { status: "CANCELLED", statusNote: opts.note }, "sales order");
        await tx.soAmendmentRequest.updateMany({ where: { soId: id, status: "PENDING" }, data: { status: "WITHDRAWN", decisionNote: "Sales order cancelled", decidedAt: new Date() } });
        await log(tx, "Cancelled");
        await syncRequirementsFromSo(tx, actor.organizationId, actor.id, so.projectId);
      });
    }
  }
}

// ─────────────────────────── Amendment requests ───────────────────────────

type Snapshot = { header: Record<string, unknown>; lines: Record<string, unknown>[] };

function snapshotOf(so: Prisma.SalesOrderGetPayload<{ include: { lines: true } }>): Snapshot {
  return {
    header: { revision: so.revision, deliveryDate: so.deliveryDate?.toISOString().slice(0, 10) ?? null, deliveryAddress: so.deliveryAddress, deliverySchedule: so.deliverySchedule, billingSchedule: so.billingSchedule, paymentTerms: so.paymentTerms, notes: so.notes, total: dec2(so.total) },
    lines: [...so.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ id: l.id, lineNo: l.lineNo, clientPoLineId: l.clientPoLineId, itemBrandId: l.itemBrandId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), total: dec2(l.total), deliveredQty: dec3(l.deliveredQty), invoicedQty: dec3(l.invoicedQty) })),
  };
}

/** Any so.manage user may ask for a change to a locked order; the proposal is priced and pre-validated now and again at approval. */
export async function requestSoAmendment(actor: Actor, soId: string, input: unknown) {
  requirePermission(actor, "so.manage", "You do not have permission to request sales-order changes.");
  const data = parseInput(soAmendmentSchema, input);
  const so = await loadScoped(actor, soId);
  if (!(LOCKED as readonly string[]).includes(so.status)) throw new ValidationError(so.status === "DRAFT" || so.status === "REJECTED" ? "This order is not approved yet — edit it directly." : "Amendments can only be requested on approved or in-fulfilment orders.");
  await assertProjectUsable(actor, so.projectId);
  const full = await db.salesOrder.findUniqueOrThrow({ where: { id: soId }, include: { lines: true } });
  const proposedInput: SoData = { projectId: so.projectId, partyId: so.partyId, clientPoId: so.clientPoId, orderDate: so.orderDate.toISOString().slice(0, 10), deliveryDate: data.deliveryDate, deliveryAddress: data.deliveryAddress, deliverySchedule: data.deliverySchedule, billingSchedule: data.billingSchedule, paymentTerms: data.paymentTerms, notes: data.notes, lines: data.lines };
  return db.$transaction(async (tx) => {
    const { header, lines } = await buildSo(tx, actor, proposedInput, soId);
    validateAgainstHistory(full.lines, lines);
    const before = snapshotOf(full);
    if (JSON.stringify(normalise(before.lines)) === JSON.stringify(normalise(lines.map((l) => ({ ...l, deliveredQty: "", invoicedQty: "" })))) && sameHeader(before.header, header)) throw new ValidationError("Nothing has changed. Edit at least one line or detail.");
    const last = await tx.soAmendmentRequest.aggregate({ where: { soId }, _max: { requestNo: true } });
    const requestNo = (last._max.requestNo ?? 0) + 1;
    try {
      const req = await tx.soAmendmentRequest.create({
        data: {
          organizationId: actor.organizationId,
          soId,
          projectId: so.projectId,
          requestNo,
          reason: data.reason,
          proposed: { header: { deliveryDate: data.deliveryDate, deliveryAddress: data.deliveryAddress, deliverySchedule: data.deliverySchedule, billingSchedule: data.billingSchedule, paymentTerms: header.paymentTerms, notes: data.notes, total: header.total }, lines: lines.map((l) => ({ ...l, id: l.id ?? null })) } as unknown as Prisma.InputJsonValue,
          beforeSnapshot: before as unknown as Prisma.InputJsonValue,
          requestedById: actor.id,
        },
      });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so_amendment.requested", entityType: "so_amendment", entityId: req.id, projectId: so.projectId, summary: `Requested amendment #${requestNo} on ${so.number}: ${data.reason} (₹${dec2(so.total)} → ₹${header.total})` }, tx);
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.amendment_requested", entityType: "sales_order", entityId: soId, projectId: so.projectId, summary: `Amendment #${requestNo} requested – ${data.reason}` }, tx);
      const admins = await tx.user.findMany({ where: { organizationId: actor.organizationId, role: { key: "SUPER_ADMIN" }, id: { not: actor.id }, status: "ACTIVE" }, select: { id: true } });
      if (admins.length) await tx.notification.createMany({ data: admins.map((a) => ({ userId: a.id, type: "so_amendment", title: `Amendment request on ${so.number}`, body: data.reason, link: `/sales-orders/${soId}#amendments` })) });
      return req;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictError("There is already a pending amendment request for this sales order. Withdraw it or wait for the decision.");
      throw e;
    }
  });
}

const normalise = (lines: Record<string, unknown>[]) => lines.map((l) => [l.id ?? null, l.itemBrandId ?? null, l.clientPoLineId ?? null, l.description, l.unit, String(Number(l.quantity)), String(Number(l.rate)), String(Number(l.discountPct)), String(Number(l.gstRate))]);
const sameHeader = (a: Record<string, unknown>, b: Record<string, unknown>) => ["deliveryAddress", "deliverySchedule", "billingSchedule", "paymentTerms", "notes"].every((k) => (a[k] ?? null) === (b[k] ?? null)) && (a.deliveryDate ?? null) === ((b.deliveryDate as Date | null)?.toISOString().slice(0, 10) ?? null);

function validateAgainstHistory(before: { id: string; lineNo: number; itemBrandId: string | null; deliveredQty: Prisma.Decimal; invoicedQty: Prisma.Decimal }[], lines: { id: string | null; lineNo: number; itemBrandId: string | null; quantity: string }[]) {
  const ids = new Set(lines.map((l) => l.id).filter(Boolean));
  for (const old of before) {
    const delivered = dec3(old.deliveredQty);
    const invoiced = dec3(old.invoicedQty);
    const floor = maxQty(delivered, invoiced);
    const next = lines.find((l) => l.id === old.id);
    if (!next) {
      if (cmpQty(floor, "0") > 0) throw new ValidationError(`Line ${old.lineNo} has deliveries or invoices and cannot be removed.`);
      continue;
    }
    if (cmpQty(next.quantity, floor) < 0) throw new ValidationError(`Line ${old.lineNo}: quantity cannot go below what was already delivered (${delivered}) or invoiced (${invoiced}).`, { [`lines.${next.lineNo - 1}.quantity`]: `Minimum ${floor}.` });
    if (next.itemBrandId !== old.itemBrandId && cmpQty(floor, "0") > 0) throw new ValidationError(`Line ${old.lineNo}: the item of a delivered or invoiced line cannot change.`);
  }
  for (const l of lines) if (l.id && !before.some((b) => b.id === l.id)) throw new ValidationError("A line does not belong to this sales order.");
  void ids;
}

export async function withdrawSoAmendment(actor: Actor, requestId: string) {
  const req = await db.soAmendmentRequest.findFirst({ where: { id: requestId, so: scoped(actor) }, include: { so: { select: { number: true } } } });
  if (!req) throw new NotFoundError("Amendment request");
  if (req.requestedById !== actor.id && actor.role !== "SUPER_ADMIN") throw new ForbiddenError("Only the person who raised this request can withdraw it.");
  await db.$transaction(async (tx) => {
    const r = await tx.soAmendmentRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedById: actor.id } });
    if (r.count !== 1) throw new ConflictError("This request has already been decided.");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so_amendment.withdrawn", entityType: "so_amendment", entityId: requestId, projectId: req.projectId, summary: `Withdrew amendment #${req.requestNo} on ${req.so.number}` }, tx);
  });
}

/** Super Admin decision. Approval re-validates against current deliveries / invoices / contract and applies the change atomically. */
export async function decideSoAmendment(actor: Actor, requestId: string, decision: "approve" | "reject", note?: string | null) {
  if (actor.role !== "SUPER_ADMIN") throw new ForbiddenError("Only a Super Admin can approve or reject sales-order amendments.");
  const req = await db.soAmendmentRequest.findFirst({ where: { id: requestId, organizationId: actor.organizationId } });
  if (!req) throw new NotFoundError("Amendment request");
  if (req.status !== "PENDING") throw new ConflictError("This request has already been decided or withdrawn.");
  if (decision === "reject" && !note?.trim()) throw new ValidationError("Give a reason for rejecting.", { note: "Reason required." });

  return db.$transaction(async (tx) => {
    const claimed = await tx.soAmendmentRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: decision === "approve" ? "APPROVED" : "REJECTED", decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim() || null } });
    if (claimed.count !== 1) throw new ConflictError("This request has already been decided.");
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${req.soId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM so_lines WHERE so_id = ${req.soId}::uuid FOR UPDATE`;
    const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: req.soId }, include: { lines: true } });
    const notify = (title: string) => tx.notification.create({ data: { userId: req.requestedById, type: "so_amendment", title, body: note?.trim() || null, link: `/sales-orders/${so.id}#amendments` } });
    if (decision === "reject") {
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so_amendment.rejected", entityType: "so_amendment", entityId: requestId, projectId: so.projectId, summary: `Rejected amendment #${req.requestNo} on ${so.number} – ${note}` }, tx);
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.amendment_rejected", entityType: "sales_order", entityId: so.id, projectId: so.projectId, summary: `Amendment #${req.requestNo} rejected – ${note}` }, tx);
      await notify(`Amendment #${req.requestNo} on ${so.number} was rejected`);
      return { applied: false };
    }
    if (!(LOCKED as readonly string[]).includes(so.status)) throw new ValidationError("The sales order is no longer open for amendment.");
    const p = req.proposed as unknown as { header: Record<string, string | null>; lines: SoLineData[] };
    const data = parseInput(soSchema, { projectId: so.projectId, partyId: so.partyId, clientPoId: so.clientPoId, orderDate: so.orderDate.toISOString().slice(0, 10), ...p.header, lines: p.lines });
    if (so.clientPoId) await lockClientPo(tx, so.clientPoId);
    const { header, lines } = await buildSo(tx, actor, data, so.id);
    validateAgainstHistory(so.lines, lines);
    const before = snapshotOf(so);
    await applyLines(tx, so.id, so.lines, lines);
    const revision = so.revision + 1;
    await tx.salesOrder.update({ where: { id: so.id }, data: { ...header, revision, version: { increment: 1 }, statusNote: `Revision ${revision} applied (amendment #${req.requestNo})` } });
    await tx.soAmendmentRequest.update({ where: { id: requestId }, data: { appliedRevision: revision } });
    await refreshSoFulfilment(tx, so.id);
    const after = snapshotOf(await tx.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: true } }));
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so_amendment.approved", entityType: "so_amendment", entityId: requestId, projectId: so.projectId, summary: `Approved amendment #${req.requestNo} on ${so.number} → revision ${revision}`, metadata: { before, after } as unknown as Prisma.InputJsonValue }, tx);
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.amended", entityType: "sales_order", entityId: so.id, projectId: so.projectId, summary: `Revision ${revision} applied (amendment #${req.requestNo}): ₹${before.header.total} → ₹${header.total}`, metadata: { before, after } as unknown as Prisma.InputJsonValue }, tx);
    await notify(`Amendment #${req.requestNo} on ${so.number} was approved (revision ${revision})`);
    await syncRequirementsFromSo(tx, actor.organizationId, actor.id, so.projectId);
    return { applied: true, revision };
  });
}

// ─────────────────────────── Queries ───────────────────────────

const soInclude = {
  project: { select: { id: true, code: true, name: true, siteAddress: true } },
  party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true } },
  clientPo: { select: { id: true, number: true, clientPoNumber: true } },
  createdBy: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  lines: { orderBy: { lineNo: "asc" as const }, include: { itemBrand: { select: { id: true, item: { select: { id: true, code: true, name: true, unit: true } }, brand: { select: { name: true } } } }, clientPoLine: { select: { lineNo: true, quantity: true } } } },
  challans: { select: { id: true, number: true, status: true, dispatchDate: true }, orderBy: { createdAt: "desc" as const } },
  invoices: { select: { id: true, number: true, status: true, total: true, receivedAmount: true, netReceivable: true, invoiceDate: true }, orderBy: { createdAt: "desc" as const } },
  amendmentRequests: { orderBy: { requestNo: "desc" as const }, include: { requestedBy: { select: { id: true, fullName: true } }, decidedBy: { select: { fullName: true } } } },
} satisfies Prisma.SalesOrderInclude;

export async function getSalesOrder(actor: Actor, id: string) {
  requirePermission(actor, "so.view");
  const so = await db.salesOrder.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: soInclude });
  if (!so) throw new NotFoundError("Sales order");
  const settings = await getCommercialSettings(actor.organizationId);
  const hint = approvalHint(actor, "so.approve", so, settings.enforceSegregation);
  const ibIds = [...new Set(so.lines.map((l) => l.itemBrandId).filter(Boolean) as string[])];
  // Project-wide procurement for the order's item–brands (requirements → PRs → POs → receipts).
  const [prLines, poLines] = ibIds.length
    ? await Promise.all([
        db.prLine.findMany({ where: { itemBrandId: { in: ibIds }, pr: { projectId: so.projectId, status: { notIn: ["CANCELLED"] } } }, select: { itemBrandId: true, quantity: true, pr: { select: { id: true, number: true, status: true } } } }),
        db.poLine.findMany({ where: { itemBrandId: { in: ibIds }, po: { projectId: so.projectId, status: { notIn: ["CANCELLED", "DRAFT", "REJECTED"] } } }, select: { itemBrandId: true, quantity: true, acceptedQty: true, po: { select: { id: true, number: true, status: true } } } }),
      ])
    : [[], []];
  const challanLines = await db.challanLine.findMany({ where: { soLineId: { in: so.lines.map((l) => l.id) }, challan: { status: { not: "CANCELLED" } } }, select: { soLineId: true, quantity: true, challan: { select: { id: true, number: true, status: true } } } });
  const invLines = await db.invoiceLine.findMany({ where: { soLineId: { in: so.lines.map((l) => l.id) }, invoice: { status: { not: "CANCELLED" } } }, select: { soLineId: true, quantity: true, invoice: { select: { id: true, number: true, status: true } } } });
  const uniq = <T extends { id: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.id, x])).values()];
  const fulfilment = so.lines.map((l) => {
    const prs = prLines.filter((p) => p.itemBrandId === l.itemBrandId);
    const pos = poLines.filter((p) => p.itemBrandId === l.itemBrandId);
    return {
      lineId: l.id,
      requisitioned: prs.reduce((a, p) => addQty(a, dec3(p.quantity)), "0"),
      ordered: pos.reduce((a, p) => addQty(a, dec3(p.quantity)), "0"),
      received: pos.reduce((a, p) => addQty(a, dec3(p.acceptedQty)), "0"),
      delivered: subQty(dec3(l.deliveredQty), dec3(l.returnedQty)),
      invoiced: dec3(l.invoicedQty),
      prs: uniq(prs.map((p) => p.pr)),
      pos: uniq(pos.map((p) => p.po)),
      challans: uniq(challanLines.filter((c) => c.soLineId === l.id).map((c) => c.challan)),
      invoices: uniq(invLines.filter((c) => c.soLineId === l.id).map((c) => c.invoice)),
    };
  });
  const pending = so.amendmentRequests.find((r) => r.status === "PENDING") ?? null;
  const locked = (LOCKED as readonly string[]).includes(so.status);
  const anyDelivered = so.lines.some((l) => cmpQty(dec3(l.deliveredQty), "0") > 0 || cmpQty(dec3(l.invoicedQty), "0") > 0);
  return {
    so: {
      ...so,
      taxable: dec2(so.taxable),
      taxAmount: dec2(so.taxAmount),
      total: dec2(so.total),
      lines: so.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), taxable: dec2(l.taxable), taxAmount: dec2(l.taxAmount), total: dec2(l.total), deliveredQty: dec3(l.deliveredQty), returnedQty: dec3(l.returnedQty), invoicedQty: dec3(l.invoicedQty), clientPoLine: l.clientPoLine ? { lineNo: l.clientPoLine.lineNo, quantity: dec3(l.clientPoLine.quantity) } : null })),
      invoices: so.invoices.map((i) => ({ ...i, total: dec2(i.total), receivedAmount: dec2(i.receivedAmount), netReceivable: dec2(i.netReceivable) })),
      amendmentRequests: so.amendmentRequests.map((r) => ({ ...r, proposed: r.proposed as unknown as { header: Record<string, string | null>; lines: Record<string, string | null>[] }, beforeSnapshot: r.beforeSnapshot as unknown as Snapshot })),
    },
    fulfilment,
    pendingRequest: pending ? { id: pending.id, requestNo: pending.requestNo, reason: pending.reason, requestedBy: pending.requestedBy.fullName, requestedById: pending.requestedById, requestedAt: pending.requestedAt } : null,
    can: {
      edit: can(actor, "so.manage") && (EDITABLE as readonly string[]).includes(so.status),
      submit: can(actor, "so.manage") && (EDITABLE as readonly string[]).includes(so.status),
      approve: so.status === "PENDING_APPROVAL" && hint.canApprove,
      approveBlockedReason: so.status === "PENDING_APPROVAL" ? hint.reason : null,
      requestAmendment: can(actor, "so.manage") && locked && !pending,
      decideAmendment: actor.role === "SUPER_ADMIN" && !!pending,
      withdrawAmendment: !!pending && (pending.requestedById === actor.id || actor.role === "SUPER_ADMIN"),
      close: can(actor, "so.approve") && locked,
      cancel: can(actor, "so.approve") && !anyDelivered && ["DRAFT", "PENDING_APPROVAL", "REJECTED", "APPROVED"].includes(so.status),
      deliver: can(actor, "grn.create") && ["APPROVED", "PARTIALLY_FULFILLED"].includes(so.status) && so.lines.some((l) => l.itemBrandId),
      invoice: can(actor, "invoice.manage") && (locked || so.status === "CLOSED") && so.lines.some((l) => cmpQty(subQty(subQty(dec3(l.deliveredQty), dec3(l.returnedQty)), dec3(l.invoicedQty)), "0") > 0),
      planning: can(actor, "mrp.view"),
    },
  };
}

export const soListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  partyId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listSalesOrders(actor: Actor, raw: unknown) {
  requirePermission(actor, "so.view");
  const q = soListQuerySchema.parse(raw ?? {});
  const base: Prisma.SalesOrderWhereInput = { AND: [scoped(actor), q.projectId ? { projectId: q.projectId } : {}] };
  const where: Prisma.SalesOrderWhereInput = {
    AND: [
      base,
      q.status ? { status: q.status as Prisma.EnumSoStatusFilter["equals"] } : {},
      q.partyId ? { partyId: q.partyId } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }, { lines: { some: { description: { contains: q.q, mode: "insensitive" } } } }] } : {},
    ],
  };
  const [total, rows, byStatus, pendingAmendments] = await Promise.all([
    db.salesOrder.count({ where }),
    db.salesOrder.findMany({ where, orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { id: true, name: true } }, clientPo: { select: { number: true } }, lines: { select: { quantity: true, deliveredQty: true, returnedQty: true } }, amendmentRequests: { where: { status: "PENDING" }, select: { id: true } } } }),
    db.salesOrder.groupBy({ by: ["status"], where: base, _count: true, _sum: { total: true } }),
    db.soAmendmentRequest.count({ where: { status: "PENDING", so: base } }),
  ]);
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    pendingAmendments,
    rows: rows.map((r) => {
      const qty = r.lines.reduce((a, l) => a + Number(l.quantity), 0);
      const del = r.lines.reduce((a, l) => a + Number(l.deliveredQty) - Number(l.returnedQty), 0);
      return { id: r.id, number: r.number, revision: r.revision, status: r.status, orderDate: r.orderDate.toISOString(), deliveryDate: r.deliveryDate?.toISOString() ?? null, total: dec2(r.total), party: r.party, project: r.project, clientPo: r.clientPo?.number ?? null, fulfilledPct: qty > 0 ? Math.min(100, Math.round((del / qty) * 100)) : 0, pendingAmendment: r.amendmentRequests.length > 0 };
    }),
    byStatus: Object.fromEntries(byStatus.map((b) => [b.status, { count: b._count, total: dec2(b._sum.total) }])) as Record<string, { count: number; total: string }>,
  };
}

/** New-order defaults: the project's client (from its active contract or last order) and optional contract lines. */
export async function salesOrderPrefill(actor: Actor, opts: { projectId?: string | null; clientPoId?: string | null }) {
  requirePermission(actor, "so.manage");
  let projectId = opts.projectId ?? null;
  let partyId: string | null = null;
  let clientPoId: string | null = null;
  let lines: { clientPoLineId: string; description: string; hsnSac: string | null; unit: string; quantity: string; rate: string; discountPct: string; gstRate: string; note: string }[] = [];
  if (opts.clientPoId) {
    const cpo = await db.clientPo.findFirst({ where: { AND: [{ id: opts.clientPoId }, projectRequiredScoped(actor) as Prisma.ClientPoWhereInput] }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (!cpo) throw new NotFoundError("Client PO");
    if (cpo.status !== "ACTIVE") throw new ValidationError("Only an approved (active) client PO can be ordered against.");
    projectId = cpo.projectId;
    partyId = cpo.partyId;
    clientPoId = cpo.id;
    const used = await soQtyByLine(db as unknown as Tx, cpo.id);
    lines = cpo.lines
      .map((l) => ({ l, left: subQty(dec3(l.quantity), used.get(l.id) ?? "0") }))
      .filter(({ left }) => cmpQty(left, "0") > 0)
      .map(({ l, left }) => ({ clientPoLineId: l.id, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: left, rate: dec4(l.rate), discountPct: String(Number(l.discountPct)), gstRate: String(Number(l.gstRate)), note: `Contract line ${l.lineNo}${l.boqRef ? ` (${l.boqRef})` : ""}: ${dec3(l.quantity)} ${l.unit}, ${used.get(l.id) ?? "0"} already on orders` }));
  } else if (projectId) {
    await assertProjectVisible(actor, projectId);
    const cpo = await db.clientPo.findFirst({ where: { projectId, organizationId: actor.organizationId, status: "ACTIVE" }, orderBy: { poDate: "desc" }, select: { partyId: true } });
    const last = cpo ? null : await db.salesOrder.findFirst({ where: { projectId, organizationId: actor.organizationId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" }, select: { partyId: true } });
    partyId = cpo?.partyId ?? last?.partyId ?? null;
  }
  const project = projectId ? await db.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId }, select: { siteAddress: true } }) : null;
  return { projectId, partyId, clientPoId, deliveryAddress: project?.siteAddress ?? "", lines };
}

export async function salesOrderOptions(actor: Actor, opts: { projectId?: string; deliverable?: boolean } = {}) {
  if (!can(actor, "so.view")) return [];
  const rows = await db.salesOrder.findMany({ where: { AND: [scoped(actor), { status: { in: opts.deliverable ? ["APPROVED", "PARTIALLY_FULFILLED"] : [...LOCKED] } }, opts.projectId ? { projectId: opts.projectId } : {}] }, orderBy: { orderDate: "desc" }, take: 500, select: { id: true, number: true, projectId: true, partyId: true, party: { select: { name: true } }, project: { select: { code: true } } } });
  return rows.map((r) => ({ id: r.id, label: r.number, hint: `${r.project.code} · ${r.party.name}`, projectId: r.projectId, partyId: r.partyId }));
}

export async function salesOrderAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "so.view")) return null;
  const r = await db.salesOrder.findFirst({ where: { AND: [{ id }, scoped(actor)] }, select: { number: true, projectId: true, status: true } });
  if (!r) return null;
  return { projectId: r.projectId, label: r.number, canView: true, canUpload: can(actor, "so.manage") || can(actor, "so.approve"), locked: !["DRAFT", "REJECTED"].includes(r.status) };
}

export async function soAmendmentAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "so.view")) return null;
  const r = await db.soAmendmentRequest.findFirst({ where: { id, so: scoped(actor) }, select: { requestNo: true, projectId: true, status: true, so: { select: { number: true } } } });
  if (!r) return null;
  return { projectId: r.projectId, label: `${r.so.number} amendment #${r.requestNo}`, canView: true, canUpload: can(actor, "so.manage"), locked: r.status !== "PENDING" };
}

/** Pending amendment requests visible to the actor (for approvals / dashboards). */
export async function listPendingSoAmendments(actor: Actor) {
  if (!can(actor, "so.view")) return [];
  return db.soAmendmentRequest.findMany({ where: { status: "PENDING", so: scoped(actor) }, orderBy: { requestedAt: "asc" }, include: { so: { select: { id: true, number: true, total: true } }, project: { select: { code: true } }, requestedBy: { select: { fullName: true } } } });
}
