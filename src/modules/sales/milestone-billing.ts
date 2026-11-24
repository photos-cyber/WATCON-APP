import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addMoney, cmpMoney, divRound, fmtMoney, formatINR, money, subMoney } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { dec2, dec3, getCommercialSettings, parseInput, projectRequiredScoped, requirePermission } from "@/modules/commercial/core";
import { computeMilestones, milestonesSchema, TRIGGERS, validateSchedule, type MilestoneInput, type Trigger } from "@/modules/commercial/payment-terms";
import { moneyField, priceDocument } from "@/modules/commercial/pricing";
import { todayString } from "@/modules/inventory/serialize";
import { optDate } from "./shared";

/**
 * Milestone billing for sales orders.
 *
 * Six separate figures, never conflated:
 *   contract value      — the sales order total
 *   eligible to invoice — what the milestones allow today (advance on approval, delivery share as
 *                         material is delivered, dated milestones on their date, event milestones
 *                         once confirmed as achieved)
 *   invoiced            — tax invoices raised (drafts included, so nothing can be billed twice)
 *   received            — money actually allocated to the order's invoices / proformas
 *   remaining to invoice— contract value − tax-invoiced
 *   outstanding         — issued, not yet received
 *
 * Advances: with the default "PROFORMA" setting an ADVANCE milestone raises a proforma / advance
 * request (not a tax invoice — GST is charged on the tax invoice for the supply). Advance received
 * on proformas is then adjusted ("less advance") on later tax invoices, whose gross includes the
 * adjusted portion, so the full order value is tax-invoiced exactly once. With "TAX_INVOICE"
 * (e.g. services, where GST is due on advances) every milestone is billed as a tax invoice.
 */

const ACTIVE_SO = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"];
const scopedSo = (actor: Actor) => projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput;

type SoForBilling = Prisma.SalesOrderGetPayload<{ include: { lines: true; milestones: true; invoices: true } }>;

/** Share of the material on the order delivered to the client (net of returns, by line value). */
function deliveredFraction(so: SoForBilling): { num: bigint; den: bigint } {
  let num = BigInt(0);
  let den = BigInt(0);
  for (const l of so.lines) {
    if (!l.itemBrandId) continue;
    const taxable = money(l.taxable.toFixed(2));
    const qty = Number(l.quantity);
    if (qty <= 0) continue;
    const net = Math.min(Math.max(Number(l.deliveredQty) - Number(l.returnedQty), 0), qty);
    den += taxable;
    num += divRound(taxable * BigInt(Math.round(net * 1000)), BigInt(Math.round(qty * 1000)));
  }
  return { num, den };
}

function eligibleFor(m: SoForBilling["milestones"][number], so: SoForBilling, frac: { num: bigint; den: bigint }): { amount: string; reason: string } {
  const amt = dec2(m.amount);
  if (m.achievedAt) return { amount: amt, reason: "Confirmed as reached" };
  if (!ACTIVE_SO.includes(so.status)) return { amount: "0.00", reason: "Order not approved yet" };
  switch (m.trigger as Trigger) {
    case "ADVANCE":
    case "ON_ORDER":
      return { amount: amt, reason: "Due on order approval" };
    case "ON_DELIVERY":
    case "NET_DAYS": {
      if (frac.den === BigInt(0)) return { amount: so.status === "FULFILLED" ? amt : "0.00", reason: so.status === "FULFILLED" ? "Order fully delivered" : "Becomes due as material is delivered" };
      const e = divRound(money(amt) * frac.num, frac.den);
      return { amount: fmtMoney(e), reason: `${Math.round(Number((frac.num * BigInt(10000)) / frac.den) / 100)}% delivered` };
    }
    case "ON_DATE":
      return m.dueDate && m.dueDate.toISOString().slice(0, 10) <= todayString() ? { amount: amt, reason: "Due date reached" } : { amount: "0.00", reason: m.dueDate ? `Due on ${m.dueDate.toISOString().slice(0, 10)}` : "No date set" };
    default:
      return { amount: "0.00", reason: "Confirm when reached" };
  }
}

/** Money requested by an invoice for its milestone (gross minus advance adjusted on it). */
const billedOf = (i: { total: Prisma.Decimal; advanceRecovery: Prisma.Decimal }) => subMoney(dec2(i.total), dec2(i.advanceRecovery));
const live = (i: { status: string }) => i.status !== "CANCELLED";

function summarise(so: SoForBilling, advanceDocument: string) {
  const frac = deliveredFraction(so);
  const invoices = so.invoices.filter(live);
  const tax = invoices.filter((i) => i.kind === "TAX_INVOICE");
  const proformas = invoices.filter((i) => i.kind === "PROFORMA");
  const milestones = [...so.milestones]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => {
      const mine = invoices.filter((i) => i.milestoneId === m.id);
      const billed = addMoney(...mine.map(billedOf));
      const received = addMoney(...mine.map((i) => dec2(i.receivedAmount)));
      const el = eligibleFor(m, so, frac);
      const remaining = cmpMoney(subMoney(el.amount, billed), "0") > 0 ? subMoney(el.amount, billed) : "0.00";
      const kind = m.trigger === "ADVANCE" && advanceDocument === "PROFORMA" ? "PROFORMA" : "TAX_INVOICE";
      return {
        id: m.id,
        label: m.label,
        basis: m.basis,
        percent: m.percent?.toFixed(4).replace(/\.?0+$/, "") ?? null,
        amount: dec2(m.amount),
        trigger: m.trigger,
        triggerLabel: TRIGGERS[m.trigger as Trigger] ?? m.trigger,
        dueDate: m.dueDate?.toISOString().slice(0, 10) ?? null,
        days: m.days,
        note: m.note,
        achievedAt: m.achievedAt?.toISOString() ?? null,
        eligible: el.amount,
        eligibleReason: el.reason,
        billed,
        received,
        billable: remaining,
        documentKind: kind,
        state: cmpMoney(received, dec2(m.amount)) >= 0 ? "PAID" : cmpMoney(billed, dec2(m.amount)) >= 0 ? (cmpMoney(received, "0") > 0 ? "PART_PAID" : "INVOICED") : cmpMoney(billed, "0") > 0 ? "PART_INVOICED" : cmpMoney(el.amount, "0") > 0 ? "DUE" : "NOT_DUE",
        invoices: mine.map((i) => ({ id: i.id, number: i.number, kind: i.kind, status: i.status, total: dec2(i.total), received: dec2(i.receivedAmount) })),
      };
    });
  const taxInvoiced = addMoney(...tax.map((i) => dec2(i.total)));
  const advanceReceived = addMoney(...proformas.map((i) => dec2(i.receivedAmount)));
  const advanceAdjusted = addMoney(...tax.map((i) => dec2(i.advanceRecovery)));
  const issued = invoices.filter((i) => i.status !== "DRAFT");
  const outstanding = addMoney(...issued.map((i) => subMoney(subMoney(dec2(i.netReceivable), dec2(i.receivedAmount)), dec2(i.adjustedAmount))));
  const contract = dec2(so.total);
  return {
    contractValue: contract,
    eligible: addMoney(...milestones.map((m) => m.eligible)),
    invoiced: taxInvoiced,
    proformaBilled: addMoney(...proformas.map((i) => dec2(i.total))),
    received: addMoney(...invoices.map((i) => dec2(i.receivedAmount))),
    remainingToInvoice: cmpMoney(subMoney(contract, taxInvoiced), "0") > 0 ? subMoney(contract, taxInvoiced) : "0.00",
    outstanding: cmpMoney(outstanding, "0") > 0 ? outstanding : "0.00",
    advanceAvailable: cmpMoney(subMoney(advanceReceived, advanceAdjusted), "0") > 0 ? subMoney(advanceReceived, advanceAdjusted) : "0.00",
    milestones,
  };
}

const soInclude = { lines: true, milestones: true, invoices: true } as const;

export async function getSoBilling(actor: Actor, soId: string) {
  requirePermission(actor, "so.view");
  const so = await db.salesOrder.findFirst({ where: { AND: [{ id: soId }, scopedSo(actor)] }, include: soInclude });
  if (!so) throw new NotFoundError("Sales order");
  const settings = await getCommercialSettings(actor.organizationId);
  const s = summarise(so, settings.advanceDocument);
  const anyMilestoneInvoice = so.invoices.some((i) => live(i) && i.milestoneId);
  return {
    ...s,
    advanceDocument: settings.advanceDocument,
    can: {
      editSchedule: can(actor, "so.manage") && !anyMilestoneInvoice && !["CANCELLED", "CLOSED"].includes(so.status),
      invoice: can(actor, "invoice.manage") && ACTIVE_SO.includes(so.status),
      markAchieved: can(actor, "so.manage") && ACTIVE_SO.includes(so.status),
    },
  };
}

/** Replaces the order's payment schedule (only before anything is billed against it). */
export async function setSoMilestones(actor: Actor, soId: string, input: unknown) {
  requirePermission(actor, "so.manage");
  const data = parseInput(z.object({ milestones: milestonesSchema }), input);
  const so = await db.salesOrder.findFirst({ where: { AND: [{ id: soId }, scopedSo(actor)] } });
  if (!so) throw new NotFoundError("Sales order");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${soId}::uuid FOR UPDATE`;
    if (await tx.clientInvoice.count({ where: { soId, milestoneId: { not: null }, status: { not: "CANCELLED" } } })) throw new ValidationError("Invoices are already raised against this schedule. Cancel them before changing it.");
    if (data.milestones.length && (await tx.clientInvoice.count({ where: { soId, milestoneId: null, status: { not: "CANCELLED" } } }))) throw new ValidationError("This order is already invoiced by delivered quantity, so it cannot switch to a payment schedule.");
    const total = dec2(so.total);
    const errors = data.milestones.length ? validateSchedule(total, data.milestones as MilestoneInput[]) : [];
    if (errors.length) throw new ValidationError(errors[0]!, { milestones: errors.join(" ") });
    const rows = computeMilestones(total, data.milestones as MilestoneInput[]).rows;
    await tx.paymentMilestone.deleteMany({ where: { soId } });
    if (rows.length) await tx.paymentMilestone.createMany({ data: rows.map((m, i) => ({ organizationId: actor.organizationId, soId, sortOrder: i, label: m.label, basis: m.basis, percent: m.percent, amount: m.amount, trigger: m.trigger, dueDate: toDbDate(m.dueDate ?? null), days: m.days ?? null, note: m.note ?? null })) });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.schedule_updated", entityType: "sales_order", entityId: soId, projectId: so.projectId, summary: `Set payment schedule on ${so.number}: ${rows.map((r) => `${r.label} ${r.basis === "PERCENT" ? `${r.percent}%` : ""} ${formatINR(r.amount)}`).join("; ") || "removed"}` }, tx);
  });
}

/** Confirms an event milestone (installation, completion, custom) has been reached. Not a payment. */
export async function markMilestoneAchieved(actor: Actor, milestoneId: string, note: string | null) {
  requirePermission(actor, "so.manage");
  const m = await db.paymentMilestone.findFirst({ where: { id: milestoneId, organizationId: actor.organizationId, so: { is: scopedSo(actor) } }, include: { so: { select: { id: true, number: true, projectId: true, status: true } } } });
  if (!m || !m.so) throw new NotFoundError("Milestone");
  if (!ACTIVE_SO.includes(m.so.status)) throw new ValidationError("The sales order must be approved first.");
  if (m.achievedAt) return;
  await db.$transaction(async (tx) => {
    await tx.paymentMilestone.update({ where: { id: m.id }, data: { achievedAt: new Date(), achievedById: actor.id } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "so.milestone_reached", entityType: "sales_order", entityId: m.so!.id, projectId: m.so!.projectId, summary: `Milestone “${m.label}” on ${m.so!.number} confirmed as reached${note ? ` – ${note}` : ""} (billing now allowed; not a payment)` }, tx);
  });
}

export const milestoneInvoiceSchema = z.object({
  milestoneId: uuid,
  amount: moneyField,
  adjustAdvance: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? "0" : String(v).trim())).pipe(z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, "Amount: up to 2 decimals.")),
  invoiceDate: dateString,
  dueDate: optDate,
  notes: optionalText("Notes", 2000),
});

/**
 * Drafts an invoice (or proforma) for a milestone. The order row is locked; the amount must fit
 * within the milestone's eligible-and-unbilled amount, and tax invoices within the order value.
 */
export async function createMilestoneInvoice(actor: Actor, input: unknown) {
  requirePermission(actor, "invoice.manage");
  const data = parseInput(milestoneInvoiceSchema, input);
  if (cmpMoney(data.amount, "0") <= 0) throw new ValidationError("Enter the amount to bill.", { amount: "Above zero." });
  const settings = await getCommercialSettings(actor.organizationId);
  return db.$transaction(async (tx) => {
    const m0 = await tx.paymentMilestone.findFirst({ where: { id: data.milestoneId, organizationId: actor.organizationId }, select: { soId: true } });
    if (!m0?.soId) throw new NotFoundError("Milestone");
    const [lock] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM sales_orders WHERE id = ${m0.soId}::uuid FOR UPDATE`;
    if (!lock) throw new NotFoundError("Sales order");
    const so = await tx.salesOrder.findFirst({ where: { AND: [{ id: m0.soId }, scopedSo(actor)] }, include: { ...soInclude, party: { select: { name: true, paymentTermsDays: true } } } });
    if (!so) throw new NotFoundError("Sales order");
    if (!ACTIVE_SO.includes(so.status)) throw new ValidationError("Only an approved sales order can be billed.");
    const cpo = so.clientPoId ? await tx.clientPo.findUnique({ where: { id: so.clientPoId }, select: { placeOfSupply: true } }) : null;
    const partyState = (await tx.party.findUniqueOrThrow({ where: { id: so.partyId }, select: { stateCode: true } })).stateCode;
    const placeOfSupply = cpo?.placeOfSupply ?? partyState;
    if (!placeOfSupply) throw new ValidationError("Set the client's state (place of supply) before invoicing.");
    const s = summarise(so, settings.advanceDocument);
    const ms = s.milestones.find((x) => x.id === data.milestoneId)!;
    if (cmpMoney(data.amount, ms.billable) > 0) throw new ValidationError(cmpMoney(ms.billable, "0") > 0 ? `Only ${formatINR(ms.billable)} of “${ms.label}” can be billed now (${ms.eligibleReason}; ${formatINR(ms.billed)} already billed).` : `Nothing on “${ms.label}” can be billed now — ${ms.eligibleReason.toLowerCase()}${cmpMoney(ms.billed, "0") > 0 ? `; ${formatINR(ms.billed)} already billed` : ""}.`, { amount: `Max ${ms.billable}` });
    const kind = ms.documentKind as "PROFORMA" | "TAX_INVOICE";
    const adjust = kind === "PROFORMA" ? "0" : data.adjustAdvance;
    if (cmpMoney(adjust, s.advanceAvailable) > 0) throw new ValidationError(`Only ${formatINR(s.advanceAvailable)} of advance received is available to adjust.`, { adjustAdvance: `Max ${s.advanceAvailable}` });
    const gross = addMoney(data.amount, adjust);
    if (kind === "TAX_INVOICE" && cmpMoney(addMoney(s.invoiced, gross), s.contractValue) > 0) throw new ValidationError(`This would tax-invoice more than the order value (${formatINR(s.contractValue)}; already ${formatINR(s.invoiced)}).`, { amount: "Over the order value." });

    // Split the gross (incl. GST) across the order's GST rates in proportion to their value.
    const groups = new Map<string, bigint>();
    for (const l of so.lines) groups.set(dec2(l.gstRate), (groups.get(dec2(l.gstRate)) ?? BigInt(0)) + money(dec2(l.total)));
    const orderTotal = [...groups.values()].reduce((a, b) => a + b, BigInt(0));
    const G = money(gross);
    const entries = [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    let used = BigInt(0);
    const lines = entries.map(([rate, value], i) => {
      const share = i === entries.length - 1 ? G - used : divRound(G * value, orderTotal);
      used += share;
      const taxable = divRound(share * BigInt(10000), BigInt(10000) + money(rate));
      const pct = ms.basis === "PERCENT" && ms.percent ? `${ms.percent}% ` : "";
      return { description: `${ms.label} — ${pct}${so.number}${entries.length > 1 ? ` (items at ${Number(rate)}% GST)` : ""}`, hsnSac: null, unit: "Lot", quantity: "1", rate: fmtMoney(taxable), discountPct: "0", gstRate: rate };
    });
    const priced = priceDocument(lines, so.taxMode, { roundToRupee: false });
    const t = priced.totals;
    const net = subMoney(t.total, adjust);
    const invDate = toDbDate(data.invoiceDate)!;
    let due = toDbDate(data.dueDate);
    if (!due) {
      const days = ms.trigger === "NET_DAYS" && ms.days !== null ? ms.days : so.party.paymentTermsDays;
      if (days !== null && days !== undefined) {
        due = new Date(invDate);
        due.setUTCDate(due.getUTCDate() + days);
      }
    }
    const inv = await tx.clientInvoice.create({
      data: {
        organizationId: actor.organizationId,
        number: `DRAFT/${randomUUID().slice(0, 8).toUpperCase()}`,
        kind,
        milestoneId: ms.id,
        projectId: so.projectId,
        partyId: so.partyId,
        clientPoId: so.clientPoId,
        soId: so.id,
        invoiceDate: invDate,
        dueDate: due,
        placeOfSupply,
        taxMode: so.taxMode,
        taxable: t.taxable,
        cgst: t.cgst,
        sgst: t.sgst,
        igst: t.igst,
        roundOff: t.roundOff,
        total: t.total,
        advanceRecovery: adjust,
        netReceivable: net,
        notes: data.notes ?? (kind === "PROFORMA" ? "Advance request — this is not a tax invoice. A tax invoice will be issued on supply; the advance received will be adjusted against it." : null),
        createdById: actor.id,
        lines: { create: priced.lines.map((l, i) => ({ lineNo: i + 1, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: "0", gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax, total: l.amounts.total })) },
      },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "invoice.created", entityType: "client_invoice", entityId: inv.id, projectId: so.projectId, summary: `Drafted ${kind === "PROFORMA" ? "proforma / advance request" : "milestone tax invoice"} for “${ms.label}” on ${so.number} – ${formatINR(t.total)}${cmpMoney(adjust, "0") > 0 ? `, less advance ${formatINR(adjust)}` : ""}` }, tx);
    return { id: inv.id, kind };
  });
}

/** Receivables across a project's sales orders (for project accounts). */
export async function projectReceivables(actor: Actor, projectId: string) {
  requirePermission(actor, "so.view");
  const sos = await db.salesOrder.findMany({ where: { AND: [{ projectId }, scopedSo(actor), { status: { in: ACTIVE_SO as never } }] }, include: soInclude });
  const settings = await getCommercialSettings(actor.organizationId);
  const rows = sos.map((so) => ({ id: so.id, number: so.number, status: so.status, milestoneBilling: so.milestones.length > 0, ...summarise(so, settings.advanceDocument) }));
  const sum = (k: "contractValue" | "eligible" | "invoiced" | "received" | "remainingToInvoice" | "outstanding" | "proformaBilled") => addMoney(...rows.map((r) => r[k]));
  return { rows: rows.map(({ milestones: _m, ...r }) => r), totals: { contractValue: sum("contractValue"), eligible: sum("eligible"), invoiced: sum("invoiced"), proformaBilled: sum("proformaBilled"), received: sum("received"), remainingToInvoice: sum("remainingToInvoice"), outstanding: sum("outstanding") } };
}


