import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { GST_STATES } from "@/lib/gst";
import { addMoney, addQty, cmpMoney, cmpQty, maxQty, pctOf, subMoney, subQty, taxModeFor } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { assertProjectUsable, dec2, dec3, dec4, decOpt2, getCommercialSettings, parseInput, projectRequiredScoped, requireAnyPermission, requirePermission, transition } from "@/modules/commercial/core";
import { gstRateField, optMoney, optPct, priceDocument, projectIdField, qtyField, rateField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { RA_CERTIFIED, cpoLineBilled, loadClient, optDate, optId } from "./shared";

/**
 * Client purchase orders (contracts): the authority and ceiling for everything sold or billed.
 *   DRAFT → PENDING_APPROVAL → ACTIVE (approved) / REJECTED → … → CLOSED
 *   Amendment / variation of an ACTIVE contract snapshots it (client_po_revisions) and needs re-approval.
 *   A line can never drop below what is already ordered (sales orders) or billed.
 */

const optPctNull = z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.null(), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Percent: up to 2 decimals.").refine((v) => Number(v) <= 100, "Must be 100 or less.")]));
const optMoneyNull = z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.null(), z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, "Amount: up to 2 decimals.")]));

const cpoLineSchema = z.object({
  id: optId,
  boqRef: optionalText("BOQ ref", 40),
  description: text("Description", 500),
  itemId: optId,
  hsnSac: optionalText("HSN/SAC", 10),
  unit: text("Unit", 20),
  quantity: qtyField,
  rate: rateField,
  discountPct: optPct,
  gstRate: gstRateField,
});

const milestoneSchema = z.object({ id: optId, name: text("Milestone", 200), percent: optPctNull, amount: optMoneyNull, dueDate: optDate });

export const cpoSchema = z.object({
  projectId: projectIdField,
  partyId: uuid,
  clientPoNumber: text("Client PO number", 60),
  poDate: dateString,
  startDate: optDate,
  endDate: optDate,
  scope: optionalText("Scope", 5000),
  paymentTerms: optionalText("Payment terms", 500),
  deliveryTerms: optionalText("Delivery terms", 500),
  retentionPct: optPct,
  advanceAmount: optMoney,
  advanceRecoveryPct: optPct,
  placeOfSupply: z.union([z.string(), z.null()]).optional().transform((v) => (v ? v : null)).refine((v) => v === null || v in GST_STATES, "Choose a valid state."),
  notes: optionalText("Notes", 2000),
  lines: z.array(cpoLineSchema).min(1, "Add at least one line.").max(500),
  milestones: z.array(milestoneSchema).max(50).optional().default([]),
});

const EDITABLE = ["DRAFT", "REJECTED"] as const;

export const cpoInclude = {
  project: { select: { id: true, code: true, name: true, siteAddress: true } },
  party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true, paymentTermsDays: true } },
  createdBy: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  lines: { orderBy: { lineNo: "asc" as const } },
  milestones: { orderBy: { sortOrder: "asc" as const } },
  revisions: { orderBy: { revision: "desc" as const }, include: { createdBy: { select: { fullName: true } } } },
  salesOrders: { select: { id: true, number: true, status: true, total: true, orderDate: true }, orderBy: { createdAt: "desc" as const } },
  raBills: { select: { id: true, number: true, raNumber: true, status: true, claimedAmount: true, certifiedAmount: true, netPayable: true, billDate: true }, orderBy: { raNumber: "desc" as const } },
  invoices: { select: { id: true, number: true, status: true, total: true, netReceivable: true, receivedAmount: true, invoiceDate: true }, orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.ClientPoInclude;

const scoped = (actor: Actor) => projectRequiredScoped(actor) as Prisma.ClientPoWhereInput;

async function loadScoped(actor: Actor, id: string, client: Tx | typeof db = db) {
  const cpo = await client.clientPo.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: { lines: true, milestones: true } });
  if (!cpo) throw new NotFoundError("Client PO");
  return cpo;
}

/** Quantity of each contract line already drawn into sales orders (all but cancelled). */
async function soQtyByLine(tx: Tx | typeof db, clientPoId: string, excludeSoId?: string) {
  const rows = await tx.soLine.findMany({ where: { clientPoLine: { clientPoId }, so: { status: { not: "CANCELLED" }, ...(excludeSoId ? { id: { not: excludeSoId } } : {}) } }, select: { clientPoLineId: true, quantity: true } });
  const m = new Map<string, string>();
  for (const r of rows) if (r.clientPoLineId) m.set(r.clientPoLineId, addQty(m.get(r.clientPoLineId) ?? "0", dec3(r.quantity)));
  return m;
}
export { soQtyByLine };

async function buildCpo(tx: Tx, actor: Actor, data: z.output<typeof cpoSchema>) {
  const party = await loadClient(tx, actor, data.partyId);
  const settings = await getCommercialSettings(actor.organizationId, tx);
  const placeOfSupply = data.placeOfSupply ?? party.stateCode;
  const mode = taxModeFor(settings.stateCode, placeOfSupply);
  if (data.startDate && data.endDate && data.endDate < data.startDate) throw new ValidationError("End date is before the start date.", { endDate: "Before start date." });
  const itemIds = [...new Set(data.lines.map((l) => l.itemId).filter(Boolean) as string[])];
  if (itemIds.length) {
    const n = await tx.item.count({ where: { id: { in: itemIds }, organizationId: actor.organizationId } });
    if (n !== itemIds.length) throw new ValidationError("A linked item was not found.");
  }
  const priced = priceDocument(data.lines, mode, {});
  if (cmpMoney(data.advanceAmount, priced.totals.total) > 0) throw new ValidationError("Advance cannot exceed the contract value.", { advanceAmount: "More than the contract total." });
  let pctSum = "0";
  data.milestones.forEach((m, i) => {
    if (!m.percent && !m.amount) throw new ValidationError("Each milestone needs a percent or an amount.", { [`milestones.${i}.percent`]: "Percent or amount required." });
    if (m.percent) pctSum = addMoney(pctSum, m.percent);
  });
  if (cmpMoney(pctSum, "100") > 0) throw new ValidationError("Milestone percentages add up to more than 100%.", { milestones: "Over 100%." });
  const header = {
    projectId: data.projectId,
    partyId: party.id,
    clientPoNumber: data.clientPoNumber,
    poDate: toDbDate(data.poDate)!,
    startDate: toDbDate(data.startDate),
    endDate: toDbDate(data.endDate),
    scope: data.scope,
    paymentTerms: data.paymentTerms ?? (party.paymentTermsDays !== null ? `${party.paymentTermsDays} days from invoice` : null),
    deliveryTerms: data.deliveryTerms,
    retentionPct: data.retentionPct,
    advanceAmount: data.advanceAmount,
    advanceRecoveryPct: data.advanceRecoveryPct,
    taxMode: mode,
    placeOfSupply,
    taxable: priced.totals.taxable,
    taxAmount: priced.totals.tax,
    total: priced.totals.total,
    notes: data.notes,
  };
  const lines = priced.lines.map((l, i) => ({ id: l.id, lineNo: i + 1, boqRef: l.boqRef, description: l.description, itemId: l.itemId, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax, total: l.amounts.total }));
  const milestones = data.milestones.map((m, i) => ({ id: m.id, sortOrder: i, name: m.name, percent: m.percent, amount: m.amount ?? (m.percent ? pctOf(priced.totals.total, m.percent) : null), dueDate: toDbDate(m.dueDate) }));
  return { header, lines, milestones, party };
}

export async function createClientPo(actor: Actor, input: unknown) {
  requirePermission(actor, "cpo.manage");
  const data = parseInput(cpoSchema, input);
  const project = await assertProjectUsable(actor, data.projectId);
  return db.$transaction(async (tx) => {
    const { header, lines, milestones, party } = await buildCpo(tx, actor, data);
    const dup = await tx.clientPo.findFirst({ where: { organizationId: actor.organizationId, partyId: party.id, clientPoNumber: { equals: header.clientPoNumber, mode: "insensitive" }, status: { not: "CANCELLED" } }, select: { number: true } });
    if (dup) throw new ValidationError(`Client PO number "${header.clientPoNumber}" is already recorded for this client (${dup.number}).`, { clientPoNumber: "Already recorded." });
    const number = await nextDocNumber(tx, actor.organizationId, "CPO", header.poDate);
    const cpo = await tx.clientPo.create({
      data: { organizationId: actor.organizationId, number, ...header, createdById: actor.id, lines: { create: lines.map(({ id: _id, ...l }) => l) }, milestones: { create: milestones.map(({ id: _id, ...m }) => m) } },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "cpo.created", entityType: "client_po", entityId: cpo.id, projectId: cpo.projectId, summary: `Recorded client PO ${header.clientPoNumber} (${number}) from ${party.name} for ${project.code} – ₹${header.total}` }, tx);
    return cpo;
  });
}

export async function updateClientPo(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "cpo.manage");
  const data = parseInput(cpoSchema, input);
  const before = await loadScoped(actor, id);
  if (!(EDITABLE as readonly string[]).includes(before.status)) throw new ValidationError("Only draft or rejected client POs can be edited. Use Amend for an active contract.");
  await assertProjectUsable(actor, data.projectId);
  if (data.projectId !== before.projectId || data.partyId !== before.partyId) {
    const used = (await db.salesOrder.count({ where: { clientPoId: id } })) + (await db.raBill.count({ where: { clientPoId: id } })) + (await db.clientInvoice.count({ where: { clientPoId: id } }));
    if (used) throw new ValidationError("Client and project cannot change once sales orders, running bills or invoices exist.");
  }
  return db.$transaction(async (tx) => {
    const { header, lines, milestones } = await buildCpo(tx, actor, data);
    const soQty = await soQtyByLine(tx, id);
    const billed = await cpoLineBilled(tx, id);
    const existing = new Map(before.lines.map((l) => [l.id, l]));
    const kept = new Set<string>();
    for (const old of before.lines) await tx.clientPoLine.update({ where: { id: old.id }, data: { lineNo: 5000 + old.lineNo } });
    for (const l of lines) {
      const { id: lineId, ...rest } = l;
      const old = lineId ? existing.get(lineId) : undefined;
      if (lineId && !old) throw new ValidationError("A line does not belong to this client PO.");
      if (old) {
        kept.add(old.id);
        const floor = maxQty(soQty.get(old.id) ?? "0", billed.get(old.id) ?? "0");
        if (cmpQty(l.quantity, floor) < 0) throw new ValidationError(`Line ${l.lineNo}: quantity cannot be below what is already ordered or billed (${floor}).`, { [`lines.${l.lineNo - 1}.quantity`]: `Minimum ${floor}.` });
        await tx.clientPoLine.update({ where: { id: old.id }, data: rest });
      } else {
        await tx.clientPoLine.create({ data: { ...rest, clientPoId: id } });
      }
    }
    for (const old of before.lines) {
      if (kept.has(old.id)) continue;
      if (cmpQty(maxQty(soQty.get(old.id) ?? "0", billed.get(old.id) ?? "0"), "0") > 0) throw new ValidationError(`Line ${old.lineNo} is already used by a sales order, running bill or invoice and cannot be removed.`);
      const refs = (await tx.soLine.count({ where: { clientPoLineId: old.id } })) + (await tx.raBillLine.count({ where: { clientPoLineId: old.id } })) + (await tx.invoiceLine.count({ where: { clientPoLineId: old.id } }));
      if (refs) throw new ValidationError(`Line ${old.lineNo} is referenced by earlier documents and cannot be removed. Set its quantity to what was used instead.`);
      await tx.clientPoLine.delete({ where: { id: old.id } });
    }
    const keptMs = new Set(milestones.filter((m) => m.id && before.milestones.some((b) => b.id === m.id)).map((m) => m.id!));
    await tx.clientPoMilestone.deleteMany({ where: { clientPoId: id, id: { notIn: [...keptMs] } } });
    for (const m of milestones) {
      const { id: mid, ...rest } = m;
      if (mid && keptMs.has(mid)) await tx.clientPoMilestone.update({ where: { id: mid }, data: rest });
      else await tx.clientPoMilestone.create({ data: { ...rest, clientPoId: id } });
    }
    await transition(tx.clientPo, { id, organizationId: actor.organizationId, version }, EDITABLE, { ...header, status: "DRAFT", statusNote: before.revision > 0 ? before.statusNote : null }, "client PO");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "cpo.updated", entityType: "client_po", entityId: id, projectId: header.projectId, summary: `Edited client PO ${before.number}${before.revision ? ` (revision ${before.revision})` : ""} – ₹${header.total}` }, tx);
  });
}

export type CpoAction = "submit" | "approve" | "reject" | "amend" | "variation" | "close" | "cancel";

export async function clientPoAction(actor: Actor, id: string, action: CpoAction, opts: { version: number; note?: string | null }) {
  const cpo = await loadScoped(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string, extra = "") => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `cpo.${action}`, entityType: "client_po", entityId: id, projectId: cpo.projectId, summary: `${verb} client PO ${cpo.number}${extra}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new ValidationError(msg, { note: msg });
  };
  switch (action) {
    // Simplified workflow: "Finalize" (submit) activates the client PO in one step.
    case "submit":
    case "approve":
    case "reject":
      requireAnyPermission(actor, ["cpo.manage", "cpo.approve"]);
      if (action === "reject") need(opts.note, "Give a reason for returning it.");
      return db.$transaction(async (tx) => {
        if (action !== "reject") {
          const now = new Date();
          await transition(tx.clientPo, w, action === "submit" ? EDITABLE : ["PENDING_APPROVAL"], { status: "ACTIVE", ...(action === "submit" ? { submittedById: actor.id, submittedAt: now } : {}), approvedById: actor.id, approvedAt: now, statusNote: null, ...(cpo.originalTotal === null ? { originalTotal: cpo.total, originalTaxable: cpo.taxable } : {}) }, "client PO");
          await log(tx, "Finalized", ` (₹${dec2(cpo.total)})`);
        } else {
          await transition(tx.clientPo, w, ["PENDING_APPROVAL"], { status: "REJECTED", statusNote: opts.note }, "client PO");
          await log(tx, "Rejected");
        }
      });
    case "amend":
    case "variation":
      requirePermission(actor, "cpo.approve", "You do not have permission to amend an active client PO.");
      need(opts.note, action === "variation" ? "Describe the variation (scope / quantity change)." : "Give the reason for the amendment.");
      return db.$transaction(async (tx) => {
        const full = await tx.clientPo.findUniqueOrThrow({ where: { id }, include: { lines: true, milestones: true } });
        await tx.clientPoRevision.create({ data: { clientPoId: id, revision: full.revision, snapshot: JSON.parse(JSON.stringify(full)) as Prisma.InputJsonValue, reason: opts.note!, isVariation: action === "variation", createdById: actor.id } });
        await transition(tx.clientPo, w, ["ACTIVE"], { status: "DRAFT", revision: { increment: 1 }, approvedById: null, approvedAt: null, submittedById: null, submittedAt: null, statusNote: `${action === "variation" ? "Variation" : "Amendment"} ${full.revision + 1}: ${opts.note}` }, "client PO");
        await log(tx, action === "variation" ? "Opened variation" : "Opened amendment", ` ${full.revision + 1} of`);
      });
    case "close":
      requirePermission(actor, "cpo.approve", "You do not have permission to close a client PO.");
      need(opts.note, "Give a reason for closing.");
      return db.$transaction(async (tx) => {
        const openRa = await tx.raBill.count({ where: { clientPoId: id, status: { in: ["DRAFT", "INTERNAL_REVIEW", "SUBMITTED", "DISPUTED"] } } });
        if (openRa) throw new ValidationError("Running bills are still in progress on this contract. Certify or cancel them first.");
        await transition(tx.clientPo, w, ["ACTIVE", "COMPLETED"], { status: "CLOSED", statusNote: opts.note }, "client PO");
        await log(tx, "Closed");
      });
    case "cancel": {
      if (cpo.status === "ACTIVE") requirePermission(actor, "cpo.approve", "You do not have permission to cancel an active client PO.");
      else requireAnyPermission(actor, ["cpo.manage", "cpo.approve"]);
      need(opts.note, "Give a reason for cancelling.");
      return db.$transaction(async (tx) => {
        const [so, ra, inv] = await Promise.all([
          tx.salesOrder.count({ where: { clientPoId: id, status: { not: "CANCELLED" } } }),
          tx.raBill.count({ where: { clientPoId: id, status: { not: "CANCELLED" } } }),
          tx.clientInvoice.count({ where: { clientPoId: id, status: { not: "CANCELLED" } } }),
        ]);
        if (ra || inv) throw new ValidationError("This contract has been billed (running bills or invoices exist), so it cannot be cancelled. Close it instead.");
        if (so) throw new ValidationError("Sales orders exist against this contract. Cancel them first, or close the contract.");
        await transition(tx.clientPo, w, ["DRAFT", "PENDING_APPROVAL", "REJECTED", "ACTIVE"], { status: "CANCELLED", statusNote: opts.note }, "client PO");
        await log(tx, "Cancelled");
      });
    }
  }
}

export async function setMilestoneStatus(actor: Actor, milestoneId: string, status: "PENDING" | "BILLED" | "RECEIVED") {
  requirePermission(actor, "cpo.manage");
  if (!["PENDING", "BILLED", "RECEIVED"].includes(status)) throw new ValidationError("Invalid milestone status.");
  const m = await db.clientPoMilestone.findFirst({ where: { id: milestoneId, clientPo: scoped(actor) }, include: { clientPo: { select: { id: true, number: true, projectId: true } } } });
  if (!m) throw new NotFoundError("Milestone");
  await db.$transaction(async (tx) => {
    await tx.clientPoMilestone.update({ where: { id: milestoneId }, data: { status } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "cpo.milestone", entityType: "client_po", entityId: m.clientPo.id, projectId: m.clientPo.projectId, summary: `Milestone "${m.name}" on ${m.clientPo.number} marked ${status.toLowerCase()}` }, tx);
  });
}

// ─────────────────────────── Queries ───────────────────────────

/** Per-line contract progress: ordered (SOs), delivered, claimed, certified, invoiced. */
async function lineProgress(clientPoId: string) {
  const [soLines, raLines, invLines] = await Promise.all([
    db.soLine.findMany({ where: { clientPoLine: { clientPoId }, so: { status: { not: "CANCELLED" } } }, select: { clientPoLineId: true, quantity: true, deliveredQty: true, returnedQty: true } }),
    db.raBillLine.findMany({ where: { raBill: { clientPoId, status: { not: "CANCELLED" } } }, select: { clientPoLineId: true, claimedQty: true, certifiedQty: true, raBill: { select: { status: true } } } }),
    db.invoiceLine.findMany({ where: { clientPoLine: { clientPoId }, invoice: { status: { not: "CANCELLED" } } }, select: { clientPoLineId: true, quantity: true, taxable: true } }),
  ]);
  const p = new Map<string, { ordered: string; delivered: string; claimed: string; certified: string; invoiced: string; invoicedValue: string }>();
  const get = (k: string) => p.get(k) ?? (p.set(k, { ordered: "0", delivered: "0", claimed: "0", certified: "0", invoiced: "0", invoicedValue: "0.00" }), p.get(k)!);
  for (const s of soLines) if (s.clientPoLineId) {
    const g = get(s.clientPoLineId);
    g.ordered = addQty(g.ordered, dec3(s.quantity));
    g.delivered = addQty(g.delivered, subQty(dec3(s.deliveredQty), dec3(s.returnedQty)));
  }
  for (const r of raLines) {
    if (!r.clientPoLineId) continue;
    const g = get(r.clientPoLineId);
    if ((RA_CERTIFIED as readonly string[]).includes(r.raBill.status)) g.certified = addQty(g.certified, dec3(r.certifiedQty));
    else g.claimed = addQty(g.claimed, dec3(r.claimedQty));
  }
  for (const i of invLines) if (i.clientPoLineId) {
    const g = get(i.clientPoLineId);
    g.invoiced = addQty(g.invoiced, dec3(i.quantity));
    g.invoicedValue = addMoney(g.invoicedValue, dec2(i.taxable));
  }
  return p;
}

export async function getClientPo(actor: Actor, id: string) {
  requirePermission(actor, "cpo.view");
  const cpo = await db.clientPo.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: cpoInclude });
  if (!cpo) throw new NotFoundError("Client PO");
  const manage = can(actor, "cpo.manage") || can(actor, "cpo.approve");
  const progress = await lineProgress(id);
  const billed = await cpoLineBilled(db as unknown as Tx, id);
  const activeInv = cpo.invoices.filter((i) => i.status !== "CANCELLED");
  const invoiced = activeInv.reduce((a, i) => addMoney(a, dec2(i.total)), "0.00");
  const received = activeInv.reduce((a, i) => addMoney(a, dec2(i.receivedAmount)), "0.00");
  const certified = cpo.raBills.filter((r) => (RA_CERTIFIED as readonly string[]).includes(r.status)).reduce((a, r) => addMoney(a, dec2(r.certifiedAmount)), "0.00");
  const anyBilled = cpo.raBills.some((r) => r.status !== "CANCELLED") || activeInv.length > 0;
  return {
    cpo: {
      ...cpo,
      taxable: dec2(cpo.taxable),
      taxAmount: dec2(cpo.taxAmount),
      total: dec2(cpo.total),
      originalTotal: decOpt2(cpo.originalTotal),
      retentionPct: dec2(cpo.retentionPct),
      advanceAmount: dec2(cpo.advanceAmount),
      advanceRecoveryPct: dec2(cpo.advanceRecoveryPct),
      lines: cpo.lines.map((l) => {
        const g = progress.get(l.id) ?? { ordered: "0", delivered: "0", claimed: "0", certified: "0", invoiced: "0", invoicedValue: "0.00" };
        const used = billed.get(l.id) ?? "0";
        return { ...l, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), taxable: dec2(l.taxable), taxAmount: dec2(l.taxAmount), total: dec2(l.total), progress: g, billable: cmpQty(dec3(l.quantity), used) > 0 ? subQty(dec3(l.quantity), used) : "0" };
      }),
      milestones: cpo.milestones.map((m) => ({ ...m, percent: decOpt2(m.percent), amount: decOpt2(m.amount) })),
      salesOrders: cpo.salesOrders.map((s) => ({ ...s, total: dec2(s.total) })),
      raBills: cpo.raBills.map((r) => ({ ...r, claimedAmount: dec2(r.claimedAmount), certifiedAmount: dec2(r.certifiedAmount), netPayable: dec2(r.netPayable) })),
      invoices: cpo.invoices.map((i) => ({ ...i, total: dec2(i.total), netReceivable: dec2(i.netReceivable), receivedAmount: dec2(i.receivedAmount) })),
    },
    summary: { contract: dec2(cpo.total), original: decOpt2(cpo.originalTotal), variation: cpo.originalTotal ? subMoney(dec2(cpo.total), dec2(cpo.originalTotal)) : "0.00", certified, invoiced, received, outstanding: subMoney(activeInv.reduce((a, i) => addMoney(a, dec2(i.netReceivable)), "0.00"), received) },
    can: {
      edit: can(actor, "cpo.manage") && (EDITABLE as readonly string[]).includes(cpo.status),
      submit: can(actor, "cpo.manage") && (EDITABLE as readonly string[]).includes(cpo.status),
      approve: cpo.status === "PENDING_APPROVAL" && manage,
      approveBlockedReason: null as string | null,
      amend: can(actor, "cpo.approve") && cpo.status === "ACTIVE",
      requestChange: !can(actor, "cpo.approve") && manage && cpo.status === "ACTIVE",
      close: can(actor, "cpo.approve") && ["ACTIVE", "COMPLETED"].includes(cpo.status),
      cancel: !anyBilled && (cpo.status === "ACTIVE" ? can(actor, "cpo.approve") : manage && ["DRAFT", "PENDING_APPROVAL", "REJECTED"].includes(cpo.status)),
      salesOrder: can(actor, "so.manage") && cpo.status === "ACTIVE",
      raBill: can(actor, "rabill.manage") && cpo.status === "ACTIVE",
      invoice: can(actor, "invoice.manage") && cpo.status === "ACTIVE",
      milestones: can(actor, "cpo.manage") && cpo.status !== "CANCELLED",
    },
  };
}

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  partyId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listClientPos(actor: Actor, raw: unknown) {
  requirePermission(actor, "cpo.view");
  const q = listQuerySchema.parse(raw ?? {});
  const base: Prisma.ClientPoWhereInput = { AND: [scoped(actor), q.projectId ? { projectId: q.projectId } : {}] };
  const where: Prisma.ClientPoWhereInput = {
    AND: [
      base,
      q.status ? { status: q.status as Prisma.EnumContractStatusFilter["equals"] } : {},
      q.partyId ? { partyId: q.partyId } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { clientPoNumber: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }, { lines: { some: { description: { contains: q.q, mode: "insensitive" } } } }] } : {},
    ],
  };
  const [total, rows, byStatus] = await Promise.all([
    db.clientPo.count({ where }),
    db.clientPo.findMany({ where, orderBy: [{ poDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { id: true, name: true } }, invoices: { where: { status: { not: "CANCELLED" } }, select: { total: true } } } }),
    db.clientPo.groupBy({ by: ["status"], where: base, _count: true, _sum: { total: true } }),
  ]);
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((r) => ({ id: r.id, number: r.number, clientPoNumber: r.clientPoNumber, revision: r.revision, status: r.status, poDate: r.poDate.toISOString(), total: dec2(r.total), invoiced: r.invoices.reduce((a, i) => addMoney(a, dec2(i.total)), "0.00"), party: r.party, project: r.project })),
    byStatus: Object.fromEntries(byStatus.map((b) => [b.status, { count: b._count, total: dec2(b._sum.total) }])) as Record<string, { count: number; total: string }>,
  };
}

/** Active contracts for pickers (sales orders, running bills, invoices). */
export async function clientPoOptions(actor: Actor, opts: { projectId?: string } = {}) {
  if (!can(actor, "cpo.view") && !can(actor, "so.manage") && !can(actor, "rabill.manage") && !can(actor, "invoice.manage")) return [];
  const rows = await db.clientPo.findMany({ where: { AND: [projectRequiredScoped(actor) as Prisma.ClientPoWhereInput, { status: "ACTIVE" }, opts.projectId ? { projectId: opts.projectId } : {}] }, orderBy: { poDate: "desc" }, take: 500, select: { id: true, number: true, clientPoNumber: true, projectId: true, partyId: true, party: { select: { name: true } }, project: { select: { code: true } } } });
  return rows.map((r) => ({ id: r.id, label: `${r.number} · ${r.clientPoNumber}`, hint: `${r.project.code} · ${r.party.name}`, projectId: r.projectId, partyId: r.partyId }));
}

export async function clientPoAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "cpo.view")) return null;
  const r = await db.clientPo.findFirst({ where: { AND: [{ id }, scoped(actor)] }, select: { number: true, projectId: true, status: true } });
  if (!r) return null;
  return { projectId: r.projectId, label: r.number, canView: true, canUpload: can(actor, "cpo.manage") || can(actor, "cpo.approve"), locked: !["DRAFT", "REJECTED"].includes(r.status) };
}

/** Edit form values for an existing client PO. */
export function cpoFormValues(cpo: Awaited<ReturnType<typeof getClientPo>>["cpo"]) {
  return {
    projectId: cpo.projectId,
    partyId: cpo.partyId,
    clientPoNumber: cpo.clientPoNumber,
    poDate: cpo.poDate.toISOString().slice(0, 10),
    startDate: cpo.startDate?.toISOString().slice(0, 10) ?? "",
    endDate: cpo.endDate?.toISOString().slice(0, 10) ?? "",
    scope: cpo.scope ?? "",
    paymentTerms: cpo.paymentTerms ?? "",
    deliveryTerms: cpo.deliveryTerms ?? "",
    retentionPct: cpo.retentionPct === "0.00" ? "" : String(Number(cpo.retentionPct)),
    advanceAmount: cpo.advanceAmount === "0.00" ? "" : cpo.advanceAmount,
    advanceRecoveryPct: cpo.advanceRecoveryPct === "0.00" ? "" : String(Number(cpo.advanceRecoveryPct)),
    placeOfSupply: cpo.placeOfSupply,
    notes: cpo.notes ?? "",
    lines: cpo.lines.map((l) => ({ key: l.id, id: l.id, description: l.description, hsnSac: l.hsnSac ?? "", unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: String(Number(l.discountPct)), gstRate: String(Number(l.gstRate)), links: { boqRef: l.boqRef, itemId: l.itemId }, note: cmpQty(l.progress.ordered, "0") > 0 || cmpQty(l.progress.certified, "0") > 0 ? `Ordered ${l.progress.ordered} · certified ${l.progress.certified} · invoiced ${l.progress.invoiced}` : undefined })),
    milestones: cpo.milestones.map((m) => ({ key: m.id, id: m.id, name: m.name, percent: m.percent ? String(Number(m.percent)) : "", amount: m.percent ? "" : (m.amount ?? ""), dueDate: m.dueDate?.toISOString().slice(0, 10) ?? "" })),
  };
}
