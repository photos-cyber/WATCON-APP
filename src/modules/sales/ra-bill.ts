import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { addMoney, addQty, cmpMoney, cmpQty, pctOf, qtyTimesRate, subMoney, subQty } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, text, toDbDate, uuid } from "@/lib/validations/common";
import { dec2, dec3, dec4, getCommercialSettings, parseInput, projectRequiredScoped, requirePermission, segregationBlocks, transition } from "@/modules/commercial/core";
import { optMoney, qtyOrZero } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { RA_CERTIFIED, cpoLineBilled, lockClientPo, netRate } from "./shared";

/**
 * Running account (RA) bills against a client PO:
 *   DRAFT → INTERNAL_REVIEW → SUBMITTED (to client) → CLIENT_CERTIFIED / DISPUTED → INVOICED → (PARTIALLY_)PAID
 * Ceiling per contract line: everything already billed (certified, or claimed while pending) + this claim ≤ contract qty.
 * All checks run under a row lock on the client PO, so two bills cannot over-claim the same quantity.
 */

const raLineSchema = z.object({ clientPoLineId: uuid, claimedQty: qtyOrZero, measurementRef: optionalText("Measurement ref", 100), remarks: optionalText("Remarks", 300) });
export const raSchema = z.object({
  clientPoId: uuid,
  billDate: dateString,
  periodFrom: dateString,
  periodTo: dateString,
  otherDeductions: optMoney,
  deductionNotes: optionalText("Deduction notes", 1000),
  remarks: optionalText("Remarks", 2000),
  lines: z.array(raLineSchema).min(1, "Claim at least one line.").max(500),
});
export const certifySchema = z.object({
  clientCertRef: text("Client certificate reference", 100),
  clientCertDate: dateString,
  otherDeductions: optMoney,
  deductionNotes: optionalText("Deduction notes", 1000),
  lines: z.array(z.object({ lineId: uuid, certifiedQty: qtyOrZero })).min(1).max(500),
});

const OPEN = ["DRAFT", "INTERNAL_REVIEW", "SUBMITTED", "DISPUTED"] as const;
const scoped = (actor: Actor) => projectRequiredScoped(actor) as Prisma.RaBillWhereInput;

async function loadScoped(actor: Actor, id: string, client: Tx | typeof db = db) {
  const r = await client.raBill.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: { lines: true } });
  if (!r) throw new NotFoundError("Running bill");
  return r;
}

/**
 * Gross → deductions → net. Retention at the contract %; advance recovery at the contract % but never
 * more than the advance still outstanding (advance − recovered on other live bills).
 */
export async function raAmounts(tx: Tx | typeof db, opts: { clientPoId: string; excludeRaBillId?: string; gross: string; gst: string; otherDeductions: string }) {
  const cpo = await tx.clientPo.findUniqueOrThrow({ where: { id: opts.clientPoId }, select: { retentionPct: true, advanceAmount: true, advanceRecoveryPct: true } });
  const recovered = await tx.raBill.aggregate({ where: { clientPoId: opts.clientPoId, status: { not: "CANCELLED" }, ...(opts.excludeRaBillId ? { id: { not: opts.excludeRaBillId } } : {}) }, _sum: { advanceRecovery: true } });
  const outstanding = subMoney(dec2(cpo.advanceAmount), dec2(recovered._sum.advanceRecovery));
  const retention = pctOf(opts.gross, dec2(cpo.retentionPct));
  const byPct = pctOf(opts.gross, dec2(cpo.advanceRecoveryPct));
  const advance = cmpMoney(outstanding, "0") <= 0 ? "0.00" : cmpMoney(byPct, outstanding) > 0 ? outstanding : byPct;
  const net = subMoney(subMoney(subMoney(addMoney(opts.gross, opts.gst), retention), advance), opts.otherDeductions);
  if (cmpMoney(net, "0") < 0) throw new ValidationError("Deductions exceed the bill value. Reduce the other deductions.", { otherDeductions: "Too high." });
  return { retentionPct: dec2(cpo.retentionPct), retention, advance, advanceOutstanding: outstanding, net };
}

async function buildLines(tx: Tx, actor: Actor, data: z.output<typeof raSchema>, excludeRaBillId?: string) {
  const cpo = await tx.clientPo.findFirst({ where: { AND: [{ id: data.clientPoId }, scoped(actor) as Prisma.ClientPoWhereInput] }, include: { lines: true } });
  if (!cpo) throw new NotFoundError("Client PO");
  if (cpo.status !== "ACTIVE") throw new ValidationError("Running bills can only be raised on an active (approved) client PO.");
  if (data.periodTo < data.periodFrom) throw new ValidationError("The period ends before it starts.", { periodTo: "Before period start." });
  const billed = await cpoLineBilled(tx, cpo.id, { excludeRaBillId });
  const certifiedRows = await tx.raBillLine.findMany({ where: { raBill: { clientPoId: cpo.id, status: { in: [...RA_CERTIFIED] } } }, select: { clientPoLineId: true, certifiedQty: true } });
  const prevCert = new Map<string, string>();
  for (const r of certifiedRows) prevCert.set(r.clientPoLineId, addQty(prevCert.get(r.clientPoLineId) ?? "0", dec3(r.certifiedQty)));
  const map = new Map(cpo.lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const lines = data.lines
    .map((l, i) => {
      const cl = map.get(l.clientPoLineId);
      if (!cl) throw new ValidationError("A line does not belong to this client PO.", { [`lines.${i}.clientPoLineId`]: "Not on this contract." });
      if (seen.has(cl.id)) throw new ValidationError(`Contract line ${cl.lineNo} appears twice.`);
      seen.add(cl.id);
      return { l, cl, i };
    })
    .filter(({ l }) => cmpQty(l.claimedQty, "0") > 0)
    .map(({ l, cl, i }) => {
      const used = billed.get(cl.id) ?? "0";
      const left = subQty(dec3(cl.quantity), used);
      if (cmpQty(l.claimedQty, left) > 0) throw new ValidationError(`Line ${cl.lineNo} (${cl.description}): claim ${l.claimedQty} exceeds what is left to bill (${cmpQty(left, "0") > 0 ? left : "0"} of ${dec3(cl.quantity)} ${cl.unit}).`, { [`lines.${i}.claimedQty`]: `Max ${cmpQty(left, "0") > 0 ? left : "0"}.` });
      const rate = netRate(dec4(cl.rate), dec2(cl.discountPct));
      return { clientPoLineId: cl.id, contractQty: dec3(cl.quantity), prevCertifiedQty: prevCert.get(cl.id) ?? "0", rate, gstRate: dec2(cl.gstRate), claimedQty: l.claimedQty, claimedAmount: qtyTimesRate(l.claimedQty, rate), measurementRef: l.measurementRef, remarks: l.remarks };
    });
  if (!lines.length) throw new ValidationError("Enter a claimed quantity on at least one line.", { lines: "Nothing claimed." });
  const gross = lines.reduce((a, l) => addMoney(a, l.claimedAmount), "0.00");
  const gst = lines.reduce((a, l) => addMoney(a, pctOf(l.claimedAmount, l.gstRate)), "0.00");
  const amounts = await raAmounts(tx, { clientPoId: cpo.id, excludeRaBillId, gross, gst, otherDeductions: data.otherDeductions });
  return { cpo, lines, gross, gst, amounts };
}

export async function createRaBill(actor: Actor, input: unknown) {
  requirePermission(actor, "rabill.manage");
  const data = parseInput(raSchema, input);
  return db.$transaction(async (tx) => {
    await lockClientPo(tx, data.clientPoId);
    const { cpo, lines, gross, gst, amounts } = await buildLines(tx, actor, data);
    const last = await tx.raBill.aggregate({ where: { clientPoId: cpo.id }, _max: { raNumber: true } });
    const raNumber = (last._max.raNumber ?? 0) + 1;
    const number = await nextDocNumber(tx, actor.organizationId, "RAB", toDbDate(data.billDate)!);
    const bill = await tx.raBill.create({
      data: {
        organizationId: actor.organizationId,
        number,
        raNumber,
        projectId: cpo.projectId,
        clientPoId: cpo.id,
        partyId: cpo.partyId,
        billDate: toDbDate(data.billDate)!,
        periodFrom: toDbDate(data.periodFrom)!,
        periodTo: toDbDate(data.periodTo)!,
        taxMode: cpo.taxMode,
        claimedAmount: gross,
        retentionPct: amounts.retentionPct,
        retentionAmount: amounts.retention,
        advanceRecovery: amounts.advance,
        otherDeductions: data.otherDeductions,
        deductionNotes: data.deductionNotes,
        gstAmount: gst,
        netPayable: amounts.net,
        remarks: data.remarks,
        createdById: actor.id,
        lines: { create: lines },
      },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rabill.created", entityType: "ra_bill", entityId: bill.id, projectId: cpo.projectId, summary: `Prepared RA-${raNumber} (${number}) on ${cpo.number}: claimed ₹${gross}` }, tx);
    return bill;
  });
}

export async function updateRaBill(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "rabill.manage");
  const data = parseInput(raSchema, input);
  const before = await loadScoped(actor, id);
  if (before.status !== "DRAFT") throw new ValidationError("Only a draft running bill can be edited.");
  if (data.clientPoId !== before.clientPoId) throw new ValidationError("A running bill cannot move to another client PO.");
  return db.$transaction(async (tx) => {
    await lockClientPo(tx, data.clientPoId);
    const { lines, gross, gst, amounts } = await buildLines(tx, actor, data, id);
    await tx.raBillLine.deleteMany({ where: { raBillId: id } });
    await tx.raBillLine.createMany({ data: lines.map((l) => ({ ...l, raBillId: id })) });
    await transition(tx.raBill, { id, organizationId: actor.organizationId, version }, ["DRAFT"], { billDate: toDbDate(data.billDate)!, periodFrom: toDbDate(data.periodFrom)!, periodTo: toDbDate(data.periodTo)!, claimedAmount: gross, retentionPct: amounts.retentionPct, retentionAmount: amounts.retention, advanceRecovery: amounts.advance, otherDeductions: data.otherDeductions, deductionNotes: data.deductionNotes, gstAmount: gst, netPayable: amounts.net, remarks: data.remarks }, "running bill");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rabill.updated", entityType: "ra_bill", entityId: id, projectId: before.projectId, summary: `Edited ${before.number}: claimed ₹${gross}` }, tx);
  });
}

export type RaAction = "submit_review" | "return" | "approve" | "dispute" | "resubmit" | "cancel";

export async function raBillAction(actor: Actor, id: string, action: RaAction, opts: { version: number; note?: string | null }) {
  const r = await loadScoped(actor, id);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  const log = (tx: Tx, verb: string) => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `rabill.${action}`, entityType: "ra_bill", entityId: id, projectId: r.projectId, summary: `${verb} ${r.number} (RA-${r.raNumber})${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const need = (cond: unknown, msg: string) => {
    if (!cond) throw new ValidationError(msg, { note: msg });
  };
  switch (action) {
    case "submit_review":
      requirePermission(actor, "rabill.manage");
      return db.$transaction(async (tx) => {
        await transition(tx.raBill, w, ["DRAFT"], { status: "INTERNAL_REVIEW", statusNote: null }, "running bill");
        await log(tx, "Sent for internal review");
      });
    case "return":
      requirePermission(actor, "rabill.approve");
      need(opts.note, "Say what needs correcting.");
      return db.$transaction(async (tx) => {
        await transition(tx.raBill, w, ["INTERNAL_REVIEW"], { status: "DRAFT", statusNote: opts.note }, "running bill");
        await log(tx, "Returned for correction");
      });
    case "approve": {
      requirePermission(actor, "rabill.approve", "You do not have permission to review running bills.");
      const settings = await getCommercialSettings(actor.organizationId);
      if (segregationBlocks(actor, settings.enforceSegregation, r.createdById)) throw new ForbiddenError("Separation of duties: you prepared this bill, so another reviewer must approve it.");
      return db.$transaction(async (tx) => {
        await transition(tx.raBill, w, ["INTERNAL_REVIEW"], { status: "SUBMITTED", engineerCertifiedById: actor.id, engineerCertifiedAt: new Date(), submittedById: actor.id, submittedAt: new Date(), statusNote: null }, "running bill");
        await log(tx, "Reviewed and submitted to client");
      });
    }
    case "dispute":
      requirePermission(actor, "rabill.certify");
      need(opts.note, "Describe the client's objection.");
      return db.$transaction(async (tx) => {
        await transition(tx.raBill, w, ["SUBMITTED"], { status: "DISPUTED", disputeNote: opts.note }, "running bill");
        await log(tx, "Recorded client dispute on");
      });
    case "resubmit":
      requirePermission(actor, "rabill.approve");
      return db.$transaction(async (tx) => {
        await transition(tx.raBill, w, ["DISPUTED"], { status: "SUBMITTED", submittedAt: new Date() }, "running bill");
        await log(tx, "Resubmitted to client");
      });
    case "cancel":
      requirePermission(actor, "rabill.approve");
      need(opts.note, "Give a reason for cancelling.");
      return db.$transaction(async (tx) => {
        const inv = await tx.clientInvoice.count({ where: { raBillId: id, status: { not: "CANCELLED" } } });
        if (inv) throw new ValidationError("This bill has been invoiced. Cancel the invoice first.");
        await transition(tx.raBill, w, [...OPEN, "CLIENT_CERTIFIED"], { status: "CANCELLED", statusNote: opts.note }, "running bill");
        await log(tx, "Cancelled");
      });
  }
}

/** Records the client's certification: certified qty per line (≤ claimed), certificate ref and final deductions. */
export async function certifyRaBill(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "rabill.certify", "You do not have permission to record client certification.");
  const data = parseInput(certifySchema, input);
  const r = await loadScoped(actor, id);
  if (!["SUBMITTED", "DISPUTED"].includes(r.status)) throw new ValidationError("Only a bill submitted to the client can be certified.");
  return db.$transaction(async (tx) => {
    await lockClientPo(tx, r.clientPoId);
    const byId = new Map(r.lines.map((l) => [l.id, l]));
    let gross = "0.00";
    let gst = "0.00";
    for (const [i, c] of data.lines.entries()) {
      const l = byId.get(c.lineId);
      if (!l) throw new ValidationError("A line does not belong to this bill.");
      if (cmpQty(c.certifiedQty, dec3(l.claimedQty)) > 0) throw new ValidationError(`Certified quantity cannot exceed the claimed quantity (${dec3(l.claimedQty)}).`, { [`lines.${i}.certifiedQty`]: `Max ${dec3(l.claimedQty)}.` });
      const amount = qtyTimesRate(c.certifiedQty, dec4(l.rate));
      gross = addMoney(gross, amount);
      gst = addMoney(gst, pctOf(amount, dec2(l.gstRate)));
      await tx.raBillLine.update({ where: { id: l.id }, data: { certifiedQty: c.certifiedQty, certifiedAmount: amount } });
    }
    if (data.lines.length !== r.lines.length) throw new ValidationError("Enter a certified quantity (0 if not certified) for every line.");
    const amounts = await raAmounts(tx, { clientPoId: r.clientPoId, excludeRaBillId: id, gross, gst, otherDeductions: data.otherDeductions });
    await transition(tx.raBill, { id, organizationId: actor.organizationId, version }, ["SUBMITTED", "DISPUTED"], { status: "CLIENT_CERTIFIED", certifiedAmount: gross, gstAmount: gst, retentionAmount: amounts.retention, advanceRecovery: amounts.advance, otherDeductions: data.otherDeductions, deductionNotes: data.deductionNotes, netPayable: amounts.net, clientCertRef: data.clientCertRef, clientCertDate: toDbDate(data.clientCertDate), certifiedById: actor.id, statusNote: cmpMoney(gross, dec2(r.claimedAmount)) < 0 ? `Certified ₹${gross} of ₹${dec2(r.claimedAmount)} claimed` : null }, "running bill");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rabill.certified", entityType: "ra_bill", entityId: id, projectId: r.projectId, summary: `Client certified ${r.number} (RA-${r.raNumber}): ₹${gross} of ₹${dec2(r.claimedAmount)} claimed, ref ${data.clientCertRef}` }, tx);
  });
}

// ─────────────────────────── Queries ───────────────────────────

const raInclude = {
  project: { select: { id: true, code: true, name: true } },
  party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true } },
  clientPo: { select: { id: true, number: true, clientPoNumber: true, retentionPct: true, advanceAmount: true, advanceRecoveryPct: true } },
  createdBy: { select: { id: true, fullName: true } },
  engineerCertifiedBy: { select: { fullName: true } },
  certifiedBy: { select: { fullName: true } },
  invoice: { select: { id: true, number: true, status: true, total: true, receivedAmount: true } },
  lines: { include: { clientPoLine: { select: { lineNo: true, boqRef: true, description: true, unit: true, hsnSac: true } } } },
} satisfies Prisma.RaBillInclude;

export async function getRaBill(actor: Actor, id: string) {
  requirePermission(actor, "rabill.view");
  const r = await db.raBill.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: raInclude });
  if (!r) throw new NotFoundError("Running bill");
  const settings = await getCommercialSettings(actor.organizationId);
  const lines = [...r.lines].sort((a, b) => a.clientPoLine.lineNo - b.clientPoLine.lineNo);
  return {
    bill: {
      ...r,
      claimedAmount: dec2(r.claimedAmount),
      certifiedAmount: dec2(r.certifiedAmount),
      retentionPct: dec2(r.retentionPct),
      retentionAmount: dec2(r.retentionAmount),
      advanceRecovery: dec2(r.advanceRecovery),
      otherDeductions: dec2(r.otherDeductions),
      gstAmount: dec2(r.gstAmount),
      netPayable: dec2(r.netPayable),
      gross: (RA_CERTIFIED as readonly string[]).includes(r.status) ? dec2(r.certifiedAmount) : dec2(r.claimedAmount),
      certified: (RA_CERTIFIED as readonly string[]).includes(r.status),
      invoice: r.invoice && r.invoice.status !== "CANCELLED" ? { ...r.invoice, total: dec2(r.invoice.total), receivedAmount: dec2(r.invoice.receivedAmount) } : null,
      lines: lines.map((l) => ({ ...l, contractQty: dec3(l.contractQty), prevCertifiedQty: dec3(l.prevCertifiedQty), rate: dec4(l.rate), gstRate: dec2(l.gstRate), claimedQty: dec3(l.claimedQty), claimedAmount: dec2(l.claimedAmount), certifiedQty: l.certifiedQty ? dec3(l.certifiedQty) : null, certifiedAmount: l.certifiedAmount ? dec2(l.certifiedAmount) : null, cumulativeQty: addQty(dec3(l.prevCertifiedQty), l.certifiedQty ? dec3(l.certifiedQty) : dec3(l.claimedQty)) })),
    },
    can: {
      edit: can(actor, "rabill.manage") && r.status === "DRAFT",
      submitReview: can(actor, "rabill.manage") && r.status === "DRAFT",
      approve: can(actor, "rabill.approve") && r.status === "INTERNAL_REVIEW" && !segregationBlocks(actor, settings.enforceSegregation, r.createdById),
      approveBlockedReason: r.status === "INTERNAL_REVIEW" && segregationBlocks(actor, settings.enforceSegregation, r.createdById) ?"You prepared this bill; another reviewer must approve it." : null,
      returnForCorrection: can(actor, "rabill.approve") && r.status === "INTERNAL_REVIEW",
      certify: can(actor, "rabill.certify") && ["SUBMITTED", "DISPUTED"].includes(r.status),
      dispute: can(actor, "rabill.certify") && r.status === "SUBMITTED",
      resubmit: can(actor, "rabill.approve") && r.status === "DISPUTED",
      cancel: can(actor, "rabill.approve") && [...OPEN, "CLIENT_CERTIFIED"].includes(r.status),
      invoice: can(actor, "invoice.manage") && r.status === "CLIENT_CERTIFIED",
    },
  };
}

/** Lines for a new running bill: contract qty, already billed and what is left, per contract line. */
export async function raPrefill(actor: Actor, clientPoId: string) {
  requirePermission(actor, "rabill.manage");
  const cpo = await db.clientPo.findFirst({ where: { AND: [{ id: clientPoId }, projectRequiredScoped(actor) as Prisma.ClientPoWhereInput] }, include: { lines: { orderBy: { lineNo: "asc" } }, project: { select: { code: true, name: true } }, party: { select: { name: true } } } });
  if (!cpo) throw new NotFoundError("Client PO");
  if (cpo.status !== "ACTIVE") throw new ValidationError("Running bills can only be raised on an active (approved) client PO.");
  const billed = await cpoLineBilled(db as unknown as Tx, cpo.id);
  const certifiedRows = await db.raBillLine.findMany({ where: { raBill: { clientPoId: cpo.id, status: { in: [...RA_CERTIFIED] } } }, select: { clientPoLineId: true, certifiedQty: true } });
  const prev = new Map<string, string>();
  for (const c of certifiedRows) prev.set(c.clientPoLineId, addQty(prev.get(c.clientPoLineId) ?? "0", dec3(c.certifiedQty)));
  const last = await db.raBill.findFirst({ where: { clientPoId: cpo.id, status: { not: "CANCELLED" } }, orderBy: { raNumber: "desc" }, select: { periodTo: true, raNumber: true } });
  const pending = await db.raBill.count({ where: { clientPoId: cpo.id, status: { in: [...OPEN] } } });
  return {
    clientPo: { id: cpo.id, number: cpo.number, clientPoNumber: cpo.clientPoNumber, project: cpo.project, party: cpo.party.name, retentionPct: dec2(cpo.retentionPct), advanceAmount: dec2(cpo.advanceAmount), advanceRecoveryPct: dec2(cpo.advanceRecoveryPct) },
    nextRa: (last?.raNumber ?? 0) + 1,
    pendingBills: pending,
    periodFrom: last ? new Date(last.periodTo.getTime() + 86400000).toISOString().slice(0, 10) : (cpo.startDate ?? cpo.poDate).toISOString().slice(0, 10),
    lines: cpo.lines.map((l) => {
      const used = billed.get(l.id) ?? "0";
      const left = subQty(dec3(l.quantity), used);
      return { clientPoLineId: l.id, lineNo: l.lineNo, boqRef: l.boqRef, description: l.description, unit: l.unit, contractQty: dec3(l.quantity), prevCertifiedQty: prev.get(l.id) ?? "0", billedQty: used, leftQty: cmpQty(left, "0") > 0 ? left : "0", rate: netRate(dec4(l.rate), dec2(l.discountPct)), gstRate: dec2(l.gstRate) };
    }),
  };
}

export const raListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  clientPoId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listRaBills(actor: Actor, raw: unknown) {
  requirePermission(actor, "rabill.view");
  const q = raListQuerySchema.parse(raw ?? {});
  const base: Prisma.RaBillWhereInput = { AND: [scoped(actor), q.projectId ? { projectId: q.projectId } : {}] };
  const where: Prisma.RaBillWhereInput = { AND: [base, q.status ? { status: q.status as Prisma.EnumRaBillStatusFilter["equals"] } : {}, q.clientPoId ? { clientPoId: q.clientPoId } : {}, q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }, { clientPo: { clientPoNumber: { contains: q.q, mode: "insensitive" } } }] } : {}] };
  const [total, rows, byStatus] = await Promise.all([
    db.raBill.count({ where }),
    db.raBill.findMany({ where, orderBy: [{ billDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { id: true, name: true } }, clientPo: { select: { id: true, number: true } } } }),
    db.raBill.groupBy({ by: ["status"], where: base, _count: true, _sum: { claimedAmount: true, certifiedAmount: true } }),
  ]);
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((r) => ({ id: r.id, number: r.number, raNumber: r.raNumber, status: r.status, billDate: r.billDate.toISOString(), claimed: dec2(r.claimedAmount), certified: dec2(r.certifiedAmount), net: dec2(r.netPayable), party: r.party, project: r.project, clientPo: r.clientPo })),
    byStatus: Object.fromEntries(byStatus.map((b) => [b.status, { count: b._count, claimed: dec2(b._sum.claimedAmount), certified: dec2(b._sum.certifiedAmount) }])) as Record<string, { count: number; claimed: string; certified: string }>,
  };
}

export async function raBillAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "rabill.view")) return null;
  const r = await db.raBill.findFirst({ where: { AND: [{ id }, scoped(actor)] }, select: { number: true, raNumber: true, projectId: true, status: true } });
  if (!r) return null;
  return { projectId: r.projectId, label: `${r.number} (RA-${r.raNumber})`, canView: true, canUpload: can(actor, "rabill.manage") || can(actor, "rabill.certify"), locked: !["DRAFT", "INTERNAL_REVIEW", "SUBMITTED", "DISPUTED"].includes(r.status) };
}
