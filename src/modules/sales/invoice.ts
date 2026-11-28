import "server-only";
import { raiseShortageCreditNotesTx } from "@/modules/payables/notes";
import { shortageCredit, soBillingPosition } from "./so-running-bill";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addMoney, addQty, cmpMoney, cmpQty, subMoney, subQty, taxModeFor } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { dec2, dec3, dec4, getCommercialSettings, parseInput, projectRequiredScoped, requireAnyPermission, requirePermission, transition } from "@/modules/commercial/core";
import { priceDocument, qtyOrZero } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { cpoLineBilled, lockClientPo, netRate, optDate } from "./shared";

/**
 * Client tax invoices. Three sources, all checked against the same ceilings:
 *   RA   — one invoice per client-certified running bill (certified quantities, its deductions)
 *   SO   — supply invoice for delivered, not-yet-invoiced sales-order quantity (so_lines.invoiced_qty)
 *   CPO  — direct billing of contract lines, within contract − already billed
 * Drafts carry a provisional reference; the GST invoice number (INV/FY/####) is allocated on issue,
 * so cancelled drafts never leave gaps in the tax-invoice series.
 */

export const invoiceSchema = z.object({
  source: z.enum(["RA", "SO", "CPO"]),
  raBillId: uuid.optional().nullable(),
  soId: uuid.optional().nullable(),
  clientPoId: uuid.optional().nullable(),
  invoiceDate: dateString,
  dueDate: optDate,
  notes: optionalText("Notes", 2000),
  lines: z.array(z.object({ sourceLineId: uuid, quantity: qtyOrZero })).max(500).optional().default([]),
});
const editSchema = z.object({ invoiceDate: dateString, dueDate: optDate, notes: optionalText("Notes", 2000) });

const scoped = (actor: Actor) => projectRequiredScoped(actor) as Prisma.ClientInvoiceWhereInput;

type DraftLine = { description: string; hsnSac: string | null; unit: string | null; quantity: string; rate: string; discountPct: string; gstRate: string; soLineId: string | null; clientPoLineId: string | null };

async function dueFrom(tx: Tx, partyId: string, invoiceDate: string, dueDate: string | null) {
  if (dueDate) return toDbDate(dueDate);
  const p = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { paymentTermsDays: true } });
  if (p.paymentTermsDays === null) return null;
  const d = toDbDate(invoiceDate)!;
  d.setUTCDate(d.getUTCDate() + p.paymentTermsDays);
  return d;
}

export async function createClientInvoice(actor: Actor, input: unknown) {
  requirePermission(actor, "invoice.manage");
  const data = parseInput(invoiceSchema, input);
  const settings = await getCommercialSettings(actor.organizationId);
  return db.$transaction(async (tx) => {
    let projectId: string;
    let partyId: string;
    let clientPoId: string | null = null;
    let raBillId: string | null = null;
    let soId: string | null = null;
    let placeOfSupply: string | null = null;
    let deductions = { retention: "0.00", advance: "0.00", other: "0.00" };
    let lines: DraftLine[] = [];
    let label = "";

    if (data.source === "RA") {
      if (!data.raBillId) throw new ValidationError("Choose the certified running bill.", { raBillId: "Required." });
      const ra = await tx.raBill.findFirst({ where: { AND: [{ id: data.raBillId }, projectRequiredScoped(actor) as Prisma.RaBillWhereInput] }, include: { lines: { include: { clientPoLine: true, soLine: true } }, clientPo: { select: { placeOfSupply: true } }, invoice: { select: { id: true, number: true, status: true } } } });
      if (!ra) throw new NotFoundError("Running bill");
      await tx.$queryRaw`SELECT id FROM ra_bills WHERE id = ${ra.id}::uuid FOR UPDATE`;
      if (ra.invoice && ra.invoice.status !== "CANCELLED") throw new ValidationError(`This running bill is already invoiced (${ra.invoice.number}).`);
      if (ra.status !== "CLIENT_CERTIFIED") throw new ValidationError("Only a client-certified running bill can be invoiced.");
      projectId = ra.projectId;
      partyId = ra.partyId;
      clientPoId = ra.clientPoId;
      soId = ra.soId;
      raBillId = ra.id;
      placeOfSupply = ra.clientPo?.placeOfSupply ?? null;
      // A final bill's shortage credit is NOT a deduction here: a GST credit note is raised for it when this invoice is issued.
      deductions = { retention: dec2(ra.retentionAmount), advance: dec2(ra.advanceRecovery), other: dec2(ra.otherDeductions) };
      // Only this bill's certified quantities are invoiced (cumulative / previous figures are statement only),
      // so nothing billed before is invoiced — or taxed — again.
      lines = [...ra.lines]
        .sort((a, b) => (a.clientPoLine?.lineNo ?? a.soLine?.lineNo ?? 0) - (b.clientPoLine?.lineNo ?? b.soLine?.lineNo ?? 0))
        .filter((l) => l.certifiedQty && cmpQty(dec3(l.certifiedQty), "0") > 0)
        .map((l) =>
          l.clientPoLine
            ? { description: `${l.clientPoLine.boqRef ? `${l.clientPoLine.boqRef} – ` : ""}${l.clientPoLine.description}`, hsnSac: l.clientPoLine.hsnSac, unit: l.clientPoLine.unit, quantity: dec3(l.certifiedQty), rate: dec4(l.rate), discountPct: "0", gstRate: dec2(l.gstRate), soLineId: null, clientPoLineId: l.clientPoLineId }
            : { description: l.soLine!.description, hsnSac: l.soLine!.hsnSac, unit: l.soLine!.unit, quantity: dec3(l.certifiedQty), rate: dec4(l.rate), discountPct: "0", gstRate: dec2(l.gstRate), soLineId: l.soLineId, clientPoLineId: null },
        );
      if (!lines.length) throw new ValidationError("Nothing was certified on this running bill.");
      label = `RA-${ra.raNumber} (${ra.number})`;
    } else if (data.source === "SO") {
      if (!data.soId) throw new ValidationError("Choose the sales order.", { soId: "Required." });
      const so = await tx.salesOrder.findFirst({ where: { AND: [{ id: data.soId }, projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput] }, include: { clientPo: { select: { placeOfSupply: true } } } });
      if (!so) throw new NotFoundError("Sales order");
      if (!["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"].includes(so.status)) throw new ValidationError("Only an approved sales order can be invoiced.");
      // One billing basis per order: with a payment schedule, bill through its milestones (prevents double billing).
      if (await tx.paymentMilestone.count({ where: { soId: so.id } })) throw new ValidationError(`${so.number} is billed by its payment milestones. Use “Raise invoice” on the sales order's payment schedule.`);
      if (await tx.raBill.count({ where: { soId: so.id, status: { not: "CANCELLED" } } })) throw new ValidationError(`${so.number} is billed by cumulative running bills. Generate the next running bill instead.`);
      if (so.clientPoId) await lockClientPo(tx, so.clientPoId);
      const soLines = await tx.$queryRaw<{ id: string; line_no: number; delivered_qty: string; returned_qty: string; invoiced_qty: string }[]>`SELECT id::text, line_no, delivered_qty::text, returned_qty::text, invoiced_qty::text FROM so_lines WHERE so_id = ${so.id}::uuid FOR UPDATE`;
      const full = await tx.soLine.findMany({ where: { soId: so.id } });
      const billed = so.clientPoId ? await cpoLineBilled(tx, so.clientPoId) : new Map<string, string>();
      const cpoLines = so.clientPoId ? new Map((await tx.clientPoLine.findMany({ where: { clientPoId: so.clientPoId } })).map((l) => [l.id, l])) : new Map();
      projectId = so.projectId;
      partyId = so.partyId;
      clientPoId = so.clientPoId;
      soId = so.id;
      placeOfSupply = so.clientPo?.placeOfSupply ?? null;
      for (const [i, r] of data.lines.entries()) {
        if (cmpQty(r.quantity, "0") <= 0) continue;
        const raw = soLines.find((s) => s.id === r.sourceLineId);
        const l = full.find((s) => s.id === r.sourceLineId);
        if (!raw || !l) throw new ValidationError("A line does not belong to this sales order.");
        const open = subQty(subQty(raw.delivered_qty, raw.returned_qty), raw.invoiced_qty);
        if (cmpQty(r.quantity, open) > 0) throw new ValidationError(`Line ${raw.line_no}: only ${cmpQty(open, "0") > 0 ? open : "0"} delivered and not yet invoiced.`, { [`lines.${i}.quantity`]: `Max ${cmpQty(open, "0") > 0 ? open : "0"}.` });
        if (l.clientPoLineId) {
          const cl = cpoLines.get(l.clientPoLineId)!;
          const used = billed.get(cl.id) ?? "0";
          if (cmpQty(addQty(used, r.quantity), dec3(cl.quantity)) > 0) throw new ValidationError(`Line ${raw.line_no}: the client PO line would be over-billed (contract ${dec3(cl.quantity)}, already billed ${used}).`, { [`lines.${i}.quantity`]: "Over the contract." });
          billed.set(cl.id, addQty(used, r.quantity));
        }
        await tx.soLine.update({ where: { id: l.id }, data: { invoicedQty: { increment: r.quantity } } });
        lines.push({ description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: r.quantity, rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), soLineId: l.id, clientPoLineId: l.clientPoLineId });
      }
      label = so.number;
    } else {
      if (!data.clientPoId) throw new ValidationError("Choose the client PO.", { clientPoId: "Required." });
      const cpo = await tx.clientPo.findFirst({ where: { AND: [{ id: data.clientPoId }, projectRequiredScoped(actor) as Prisma.ClientPoWhereInput] }, include: { lines: true } });
      if (!cpo) throw new NotFoundError("Client PO");
      if (cpo.status !== "ACTIVE") throw new ValidationError("Only an active client PO can be invoiced.");
      await lockClientPo(tx, cpo.id);
      const billed = await cpoLineBilled(tx, cpo.id);
      projectId = cpo.projectId;
      partyId = cpo.partyId;
      clientPoId = cpo.id;
      placeOfSupply = cpo.placeOfSupply;
      for (const [i, r] of data.lines.entries()) {
        if (cmpQty(r.quantity, "0") <= 0) continue;
        const cl = cpo.lines.find((l) => l.id === r.sourceLineId);
        if (!cl) throw new ValidationError("A line does not belong to this client PO.");
        const used = billed.get(cl.id) ?? "0";
        const left = subQty(dec3(cl.quantity), used);
        if (cmpQty(r.quantity, left) > 0) throw new ValidationError(`Line ${cl.lineNo}: only ${cmpQty(left, "0") > 0 ? left : "0"} ${cl.unit} is left to bill.`, { [`lines.${i}.quantity`]: `Max ${cmpQty(left, "0") > 0 ? left : "0"}.` });
        billed.set(cl.id, addQty(used, r.quantity));
        lines.push({ description: `${cl.boqRef ? `${cl.boqRef} – ` : ""}${cl.description}`, hsnSac: cl.hsnSac, unit: cl.unit, quantity: r.quantity, rate: netRate(dec4(cl.rate), dec2(cl.discountPct)), discountPct: "0", gstRate: dec2(cl.gstRate), soLineId: null, clientPoLineId: cl.id });
      }
      label = cpo.number;
    }
    if (!lines.length) throw new ValidationError("Enter a quantity to invoice on at least one line.", { lines: "Nothing to invoice." });

    const party = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { name: true, stateCode: true } });
    const pos = placeOfSupply ?? party.stateCode;
    if (!pos) {
      throw new ValidationError(`Set the state (place of supply) on ${party.name} before invoicing — it decides CGST + SGST or IGST.`, { partyId: "Client has no state." });
    }
    const mode = taxModeFor(settings.stateCode, pos);
    const priced = priceDocument(lines, mode, { roundToRupee: true });
    const t = priced.totals;
    const net = subMoney(subMoney(subMoney(t.total, deductions.retention), deductions.advance), deductions.other);
    if (cmpMoney(net, "0") < 0) throw new ValidationError("Deductions exceed the invoice value.");
    const inv = await tx.clientInvoice.create({
      data: {
        organizationId: actor.organizationId,
        number: `DRAFT/${randomUUID().slice(0, 8).toUpperCase()}`,
        projectId,
        partyId,
        clientPoId,
        raBillId,
        soId,
        invoiceDate: toDbDate(data.invoiceDate)!,
        dueDate: await dueFrom(tx, partyId, data.invoiceDate, data.dueDate),
        placeOfSupply: pos,
        taxMode: mode,
        taxable: t.taxable,
        cgst: t.cgst,
        sgst: t.sgst,
        igst: t.igst,
        roundOff: t.roundOff,
        total: t.total,
        retentionAmount: deductions.retention,
        advanceRecovery: deductions.advance,
        otherDeductions: deductions.other,
        netReceivable: net,
        notes: data.notes,
        createdById: actor.id,
        lines: { create: priced.lines.map((l, i) => ({ lineNo: i + 1, soLineId: l.soLineId, clientPoLineId: l.clientPoLineId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax, total: l.amounts.total })) },
      },
    });
    if (raBillId) {
      await tx.raBill.update({ where: { id: raBillId }, data: { status: "INVOICED", version: { increment: 1 } } });
      // Sales-order bills: keep the order's invoiced counters in step (reversed when the invoice is cancelled).
      if (data.source === "RA") for (const l of lines) if (l.soLineId) await tx.soLine.update({ where: { id: l.soLineId }, data: { invoicedQty: { increment: l.quantity } } });
    }
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "invoice.created", entityType: "client_invoice", entityId: inv.id, projectId, summary: `Drafted invoice for ${party.name} from ${label} – ₹${t.total}` }, tx);
    return inv;
  });
}

export async function updateClientInvoice(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "invoice.manage");
  const data = parseInput(editSchema, input);
  const inv = await db.clientInvoice.findFirst({ where: { AND: [{ id }, scoped(actor)] } });
  if (!inv) throw new NotFoundError("Invoice");
  await db.$transaction(async (tx) => {
    await transition(tx.clientInvoice, { id, organizationId: actor.organizationId, version }, ["DRAFT"], { invoiceDate: toDbDate(data.invoiceDate)!, dueDate: await dueFrom(tx, inv.partyId, data.invoiceDate, data.dueDate), notes: data.notes }, "invoice");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "invoice.updated", entityType: "client_invoice", entityId: id, projectId: inv.projectId, summary: `Edited draft invoice ${inv.number}` }, tx);
  });
}

export type InvoiceAction = "issue" | "cancel";

export async function clientInvoiceAction(actor: Actor, id: string, action: InvoiceAction, opts: { version: number; note?: string | null }) {
  requireAnyPermission(actor, ["invoice.manage", "invoice.approve"], "You do not have permission to issue or cancel invoices.");
  const inv = await db.clientInvoice.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: { lines: true, raBill: { select: { number: true, raNumber: true } } } });
  if (!inv) throw new NotFoundError("Invoice");
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  if (action === "issue") {
    if (!inv.placeOfSupply) throw new ValidationError("This invoice has no place of supply. Set the client's state, then cancel this draft and create the invoice again.");
    // Simplified workflow: the person who prepared the invoice may issue it (no second person).
    return db.$transaction(async (tx) => {
      // Proformas (advance requests) have their own PI series and never consume a tax-invoice number.
      const proforma = inv.kind === "PROFORMA";
      const number = await nextDocNumber(tx, actor.organizationId, proforma ? "PI" : "INV", inv.invoiceDate);
      await transition(tx.clientInvoice, w, ["DRAFT"], { status: "ISSUED", number, issuedById: actor.id, issuedAt: new Date() }, "invoice");
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "invoice.issued", entityType: "client_invoice", entityId: id, projectId: inv.projectId, summary: `Issued ${proforma ? "proforma / advance request" : "tax invoice"} ${number} – ₹${dec2(inv.total)} (net receivable ₹${dec2(inv.netReceivable)})` }, tx);
      const creditNotes = proforma ? null : await finalBillCreditNotesTx(tx, actor, id, inv.invoiceDate);
      return { number, creditNotes };
    });
  }
  if (!opts.note?.trim()) throw new ValidationError("Give a reason for cancelling.", { note: "Reason required." });
  if (inv.status !== "DRAFT") requirePermission(actor, "invoice.approve", "You do not have permission to cancel an issued invoice.");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM client_invoices WHERE id = ${id}::uuid FOR UPDATE`;
    const fresh = await tx.clientInvoice.findUniqueOrThrow({ where: { id } });
    const allocs = await tx.paymentAllocation.count({ where: { clientInvoiceId: id, reversedAt: null } });
    const notes = await tx.adjustmentNote.count({ where: { clientInvoiceId: id, status: "APPROVED" } });
    if (allocs || cmpMoney(dec2(fresh.receivedAmount), "0") > 0) throw new ValidationError("Receipts are allocated to this invoice. Reverse those allocations first, or raise a credit note.");
    if (notes) throw new ValidationError("Credit / debit notes exist against this invoice. Cancel them first.");
    for (const l of inv.lines) {
      if (!l.soLineId) continue;
      const [sl] = await tx.$queryRaw<{ invoiced_qty: string }[]>`SELECT invoiced_qty::text FROM so_lines WHERE id = ${l.soLineId}::uuid FOR UPDATE`;
      if (cmpQty(sl!.invoiced_qty, dec3(l.quantity)) < 0) throw new ValidationError("Sales-order counters are inconsistent; contact an administrator.");
      await tx.soLine.update({ where: { id: l.soLineId }, data: { invoicedQty: { decrement: dec3(l.quantity) } } });
    }
    const raNote = inv.raBill ? ` (was for RA-${inv.raBill.raNumber} ${inv.raBill.number})` : "";
    await transition(tx.clientInvoice, w, ["DRAFT", "ISSUED"], { status: "CANCELLED", statusNote: `${opts.note}${raNote}`, raBillId: null }, "invoice");
    if (inv.raBillId) await tx.raBill.update({ where: { id: inv.raBillId }, data: { status: "CLIENT_CERTIFIED", version: { increment: 1 } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "invoice.cancelled", entityType: "client_invoice", entityId: id, projectId: inv.projectId, summary: `Cancelled invoice ${inv.number}${raNote} – ${opts.note}` }, tx);
  });
}

// ─────────────────────────── Queries ───────────────────────────

const invInclude = {
  project: { select: { id: true, code: true, name: true, siteAddress: true } },
  party: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, address: true, city: true, phone: true, email: true, whatsappNumber: true } },
  clientPo: { select: { id: true, number: true, clientPoNumber: true, poDate: true } },
  raBill: { select: { id: true, number: true, raNumber: true, periodFrom: true, periodTo: true, clientCertRef: true } },
  so: { select: { id: true, number: true } },
  createdBy: { select: { id: true, fullName: true } },
  issuedBy: { select: { fullName: true } },
  lines: { orderBy: { lineNo: "asc" as const } },
  allocations: { where: { reversedAt: null }, select: { id: true, amount: true, allocatedAt: true, payment: { select: { id: true, number: true, paymentDate: true, mode: true } } } },
} satisfies Prisma.ClientInvoiceInclude;

export async function getClientInvoice(actor: Actor, id: string) {
  requirePermission(actor, "invoice.view");
  const inv = await db.clientInvoice.findFirst({ where: { AND: [{ id }, scoped(actor)] }, include: invInclude });
  if (!inv) throw new NotFoundError("Invoice");
  const outstanding = subMoney(subMoney(dec2(inv.netReceivable), dec2(inv.receivedAmount)), dec2(inv.adjustedAmount));
  const overdue = !!inv.dueDate && inv.dueDate < new Date() && ["ISSUED", "PARTIALLY_PAID"].includes(inv.status) && cmpMoney(outstanding, "0") > 0;
  const manager = can(actor, "invoice.manage") || can(actor, "invoice.approve");
  const issueBlocked = inv.status !== "DRAFT" ? null : !inv.placeOfSupply ? "No place of supply — set the client's state, then recreate this invoice." : null;
  return {
    invoice: {
      ...inv,
      taxable: dec2(inv.taxable),
      cgst: dec2(inv.cgst),
      sgst: dec2(inv.sgst),
      igst: dec2(inv.igst),
      roundOff: dec2(inv.roundOff),
      total: dec2(inv.total),
      retentionAmount: dec2(inv.retentionAmount),
      advanceRecovery: dec2(inv.advanceRecovery),
      otherDeductions: dec2(inv.otherDeductions),
      netReceivable: dec2(inv.netReceivable),
      receivedAmount: dec2(inv.receivedAmount),
      adjustedAmount: dec2(inv.adjustedAmount),
      outstanding,
      overdue,
      lines: inv.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), taxable: dec2(l.taxable), taxAmount: dec2(l.taxAmount), total: dec2(l.total) })),
      allocations: inv.allocations.map((a) => ({ ...a, amount: dec2(a.amount) })),
    },
    can: {
      edit: can(actor, "invoice.manage") && inv.status === "DRAFT",
      issue: manager && inv.status === "DRAFT" && !!inv.placeOfSupply,
      issueBlocked,
      cancel: (inv.status === "DRAFT" ? manager : can(actor, "invoice.approve") && inv.status === "ISSUED") && cmpMoney(dec2(inv.receivedAmount), "0") === 0 && inv.allocations.length === 0,
      requestChange: !can(actor, "invoice.approve") && manager && inv.status !== "DRAFT" && inv.status !== "CANCELLED",
      receive: can(actor, "payments.manage") && ["ISSUED", "PARTIALLY_PAID"].includes(inv.status) && cmpMoney(outstanding, "0") > 0,
    },
  };
}

/** Due date for a new invoice: today plus the client's payment terms (30 days when unset). */
export function defaultDueDate(paymentTermsDays: number | null) {
  return new Date(Date.now() + (paymentTermsDays ?? 30) * 86400000).toISOString().slice(0, 10);
}

/** Source data for the new-invoice form. */
export async function invoicePrefill(actor: Actor, opts: { raBillId?: string | null; soId?: string | null; clientPoId?: string | null }) {
  requirePermission(actor, "invoice.manage");
  if (opts.raBillId) {
    const ra = await db.raBill.findFirst({ where: { AND: [{ id: opts.raBillId }, projectRequiredScoped(actor) as Prisma.RaBillWhereInput] }, include: { party: { select: { name: true, stateCode: true, paymentTermsDays: true } }, project: { select: { id: true, code: true, name: true } }, lines: { include: { clientPoLine: { select: { lineNo: true, description: true, unit: true } }, soLine: { select: { lineNo: true, description: true, unit: true } } } } } });
    if (!ra) throw new NotFoundError("Running bill");
    return { source: "RA" as const, id: ra.id, title: `${ra.number} (RA-${ra.raNumber})`, project: ra.project, party: ra.party.name, partyState: ra.party.stateCode, paymentTermsDays: ra.party.paymentTermsDays, ready: ra.status === "CLIENT_CERTIFIED", blocker: ra.status === "CLIENT_CERTIFIED" ? null : ra.status === "INVOICED" ? "This running bill is already invoiced." : "Record the client's certification before invoicing.", deductions: { retention: dec2(ra.retentionAmount), advance: dec2(ra.advanceRecovery), other: dec2(ra.otherDeductions) }, lines: [...ra.lines].sort((a, b) => (a.clientPoLine ?? a.soLine)!.lineNo - (b.clientPoLine ?? b.soLine)!.lineNo).filter((l) => l.certifiedQty && cmpQty(dec3(l.certifiedQty), "0") > 0).map((l) => ({ sourceLineId: l.id, label: (l.clientPoLine ?? l.soLine)!.description, unit: (l.clientPoLine ?? l.soLine)!.unit, max: l.certifiedQty ? dec3(l.certifiedQty) : "0", quantity: l.certifiedQty ? dec3(l.certifiedQty) : "0", rate: dec4(l.rate), discountPct: "0", gstRate: dec2(l.gstRate), fixed: true })) };
  }
  if (opts.soId) {
    const so = await db.salesOrder.findFirst({ where: { AND: [{ id: opts.soId }, projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput] }, include: { party: { select: { name: true, stateCode: true, paymentTermsDays: true } }, project: { select: { id: true, code: true, name: true } }, lines: { orderBy: { lineNo: "asc" } } } });
    if (!so) throw new NotFoundError("Sales order");
    const lines = so.lines.map((l) => {
      const open = subQty(subQty(dec3(l.deliveredQty), dec3(l.returnedQty)), dec3(l.invoicedQty));
      const max = cmpQty(open, "0") > 0 ? open : "0";
      return { sourceLineId: l.id, label: l.description, unit: l.unit, max, quantity: max, rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: dec2(l.gstRate), fixed: false, note: `Ordered ${dec3(l.quantity)} · delivered ${subQty(dec3(l.deliveredQty), dec3(l.returnedQty))} · invoiced ${dec3(l.invoicedQty)}` };
    });
    const any = lines.some((l) => cmpQty(l.max, "0") > 0);
    return { source: "SO" as const, id: so.id, title: so.number, project: so.project, party: so.party.name, partyState: so.party.stateCode, paymentTermsDays: so.party.paymentTermsDays, ready: any, blocker: any ? null : "Nothing has been delivered that is not already invoiced. Deliver against the order (delivery challan) first.", deductions: null, lines };
  }
  if (opts.clientPoId) {
    const cpo = await db.clientPo.findFirst({ where: { AND: [{ id: opts.clientPoId }, projectRequiredScoped(actor) as Prisma.ClientPoWhereInput] }, include: { party: { select: { name: true, stateCode: true, paymentTermsDays: true } }, project: { select: { id: true, code: true, name: true } }, lines: { orderBy: { lineNo: "asc" } } } });
    if (!cpo) throw new NotFoundError("Client PO");
    const billed = await cpoLineBilled(db as unknown as Tx, cpo.id);
    const lines = cpo.lines.map((l) => {
      const left = subQty(dec3(l.quantity), billed.get(l.id) ?? "0");
      return { sourceLineId: l.id, label: `${l.boqRef ? `${l.boqRef} – ` : ""}${l.description}`, unit: l.unit, max: cmpQty(left, "0") > 0 ? left : "0", quantity: "", rate: netRate(dec4(l.rate), dec2(l.discountPct)), discountPct: "0", gstRate: dec2(l.gstRate), fixed: false, note: `Contract ${dec3(l.quantity)} · billed ${billed.get(l.id) ?? "0"}` };
    });
    return { source: "CPO" as const, id: cpo.id, title: `${cpo.number} · ${cpo.clientPoNumber}`, project: cpo.project, party: cpo.party.name, partyState: cpo.party.stateCode, paymentTermsDays: cpo.party.paymentTermsDays, ready: cpo.status === "ACTIVE", blocker: cpo.status === "ACTIVE" ? null : "Only an active client PO can be invoiced.", deductions: null, lines };
  }
  return null;
}

export const invListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  partyId: uuid.optional().catch(undefined),
  overdue: z.enum(["1"]).optional().catch(undefined),
  /** Issued and not fully paid (workflow v2 · Phase 9 action links). */
  outstanding: z.enum(["1"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(20).default(20),
});

export async function listClientInvoices(actor: Actor, raw: unknown) {
  requirePermission(actor, "invoice.view");
  const q = invListQuerySchema.parse(raw ?? {});
  const base: Prisma.ClientInvoiceWhereInput = { AND: [scoped(actor), q.projectId ? { projectId: q.projectId } : {}] };
  const today = new Date();
  const where: Prisma.ClientInvoiceWhereInput = {
    AND: [
      base,
      q.status ? { status: q.status as Prisma.EnumInvoiceStatusFilter["equals"] } : {},
      q.partyId ? { partyId: q.partyId } : {},
      q.overdue ? { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: today } } : {},
      q.outstanding ? { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, kind: "TAX_INVOICE" } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { party: { name: { contains: q.q, mode: "insensitive" } } }] } : {},
    ],
  };
  const [total, rows, byStatus, open] = await Promise.all([
    db.clientInvoice.count({ where }),
    db.clientInvoice.findMany({ where, orderBy: [{ invoiceDate: "desc" }, { createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, party: { select: { id: true, name: true } } } }),
    db.clientInvoice.groupBy({ by: ["status"], where: base, _count: true, _sum: { total: true } }),
    db.clientInvoice.aggregate({ where: { AND: [base, { status: { in: ["ISSUED", "PARTIALLY_PAID"] } }] }, _sum: { netReceivable: true, receivedAmount: true, adjustedAmount: true } }),
  ]);
  const overdueCount = await db.clientInvoice.count({ where: { AND: [base, { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: today } }] } });
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    overdueCount,
    receivable: subMoney(subMoney(dec2(open._sum.netReceivable), dec2(open._sum.receivedAmount)), dec2(open._sum.adjustedAmount)),
    rows: rows.map((r) => ({ id: r.id, number: r.number, status: r.status, invoiceDate: r.invoiceDate.toISOString(), dueDate: r.dueDate?.toISOString() ?? null, total: dec2(r.total), net: dec2(r.netReceivable), received: dec2(r.receivedAmount), outstanding: subMoney(subMoney(dec2(r.netReceivable), dec2(r.receivedAmount)), dec2(r.adjustedAmount)), party: r.party, project: r.project, overdue: !!r.dueDate && r.dueDate < today && ["ISSUED", "PARTIALLY_PAID"].includes(r.status) })),
    byStatus: Object.fromEntries(byStatus.map((b) => [b.status, { count: b._count, total: dec2(b._sum.total) }])) as Record<string, { count: number; total: string }>,
  };
}

export async function clientInvoiceAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "invoice.view")) return null;
  const r = await db.clientInvoice.findFirst({ where: { AND: [{ id }, scoped(actor)] }, select: { number: true, projectId: true, status: true } });
  if (!r) return null;
  return { projectId: r.projectId, label: r.number, canView: true, canUpload: can(actor, "invoice.manage") || can(actor, "invoice.approve"), locked: r.status !== "DRAFT" };
}

/**
 * Final running bill → GST credit note(s) for material billed earlier that never fully reached the site.
 * Recomputed at issue time from the current positions (so damage recorded after the bill was prepared counts),
 * raised and applied in the issuing transaction; the bill keeps the amount actually credited.
 */
async function finalBillCreditNotesTx(tx: Tx, actor: Actor, invoiceId: string, invoiceDate: Date) {
  const inv = await tx.clientInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { raBill: { select: { id: true, number: true, raNumber: true, isFinal: true, soId: true, salesOrder: { select: { number: true } } } } } });
  const ra = inv.raBill;
  if (!ra?.isFinal || !ra.soId) return null;
  const credit = shortageCredit((await soBillingPosition(tx, ra.soId)).lines);
  if (!credit.groups.length) {
    await tx.raBill.update({ where: { id: ra.id }, data: { shortageCredit: "0" } });
    return null;
  }
  const raLabel = `RA-${ra.raNumber} ${ra.number}`;
  const res = await raiseShortageCreditNotesTx(tx, actor, { soId: ra.soId, soNumber: ra.salesOrder?.number ?? "", finalInvoiceId: invoiceId, raLabel, groups: credit.groups, reason: `Shortage / damage on ${ra.salesOrder?.number ?? "sales order"} (final bill ${raLabel}). ${(credit.note ?? "").replace(" (GST credit note on invoicing)", "")}`.trim(), noteDate: invoiceDate });
  const credited = res.notes.reduce((a, n) => addMoney(a, n.total), "0.00");
  await tx.raBill.update({ where: { id: ra.id }, data: { shortageCredit: credited, ...(cmpMoney(res.unapplied, "0") > 0 ? { statusNote: `₹${res.unapplied} of the shortage / damage credit could not be set off — every invoice of the order is already settled. Refund it to the client or keep it as their credit.` } : {}) } });
  return res;
}
