import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addMoney, addQty, cmpMoney, cmpQty, divRound, fmtMoney, fmtQty, money, pctOf, qtyTimesRate, qtyUnits, subMoney, subQty } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, uuid } from "@/lib/validations/common";
import { dec2, dec3, dec4, parseInput, projectRequiredScoped, requirePermission } from "@/modules/commercial/core";
import { optMoney, optPct, qtyOrZero } from "@/modules/commercial/pricing";
import { startOfToday } from "@/modules/tasks/rules";
import { RA_CERTIFIED, cpoLineBilled, lockClientPo, netRate } from "./shared";

/**
 * Cumulative running bills on a SALES ORDER (workflow v2 · Phase 6; client PO optional).
 *
 * Material lines are billed from what physically reached the project (posted site receipts of challans
 * and direct supplier-to-site deliveries, net of returns / transfers out, plus client deliveries from a
 * warehouse) — never more than the SO line quantity, never what was already billed. Services and
 * installation are billed by quantity up to the SO line. Rates are always the SO's selling rates
 * (net of line discount); GST at the SO line rate.
 *
 * Each bill is cumulative: previous material value + this bill = cumulative value; the statement also
 * shows what was billed before, what is still outstanding and the total now payable. Only THIS bill's
 * net amount becomes a receivable (via its invoice) — previous outstanding is shown, never re-billed.
 *
 * One DRAFT per sales order: generating again refreshes (consolidates) that draft. Everything runs
 * under a row lock on the sales order.
 */

const DRIVING = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] as const;
const LIVE_RA = { not: "CANCELLED" as const };
const Z = "0";
const max0q = (v: string) => (cmpQty(v, Z) > 0 ? v : Z);
const minq = (a: string, b: string) => (cmpQty(a, b) < 0 ? a : b);

export const soRunningBillSchema = z.object({
  soId: uuid,
  billDate: dateString.optional(),
  periodFrom: dateString.optional(),
  periodTo: dateString.optional(),
  isFinal: z.boolean().default(false),
  retentionPct: optPct,
  /** Empty = automatic (advance received × share of the order billed now; all of it on the final bill). */
  advanceRecovery: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.null(), z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, "Amount: up to 2 decimals.")])),
  otherDeductions: optMoney,
  deductionNotes: optionalText("Deduction notes", 1000),
  remarks: optionalText("Remarks", 2000),
  /** Optional overrides; omitted lines use the default (material: all unbilled delivered qty; services: 0, or the rest on a final bill). */
  lines: z.array(z.object({ soLineId: uuid, claimedQty: qtyOrZero })).max(500).optional(),
});

export type SoLinePosition = {
  soLineId: string;
  lineNo: number;
  kind: "MATERIAL" | "SERVICE" | "INSTALLATION";
  description: string;
  unit: string;
  hsnSac: string | null;
  contractQty: string;
  delivered: string;
  billed: string;
  /** Most that can be billed now (contract and, for material, delivery limits). */
  billable: string;
  rate: string;
  gstRate: string;
};

async function lockSo(tx: Tx, soId: string) {
  // Client PO first (same order as invoices / client-PO bills), then the order.
  const linked = await tx.salesOrder.findUnique({ where: { id: soId }, select: { clientPoId: true } });
  if (linked?.clientPoId) await lockClientPo(tx, linked.clientPoId);
  await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${soId}::uuid FOR UPDATE`;
}

/**
 * Billing position of every SO line: delivered (material), already billed (live running bills — certified
 * qty once certified, else claimed — plus tax invoices raised outside running bills) and billable now.
 */
export async function soBillingPosition(client: Tx | typeof db, soId: string, opts: { excludeRaBillId?: string } = {}) {
  const so = await client.salesOrder.findUniqueOrThrow({ where: { id: soId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  const ibIds = [...new Set(so.lines.filter((l) => l.kind === "MATERIAL" && l.itemBrandId).map((l) => l.itemBrandId!))];
  // Material that reached the project (effective type of reversals counts against what they reversed).
  const delivered = ibIds.length
    ? await client.$queryRaw<{ ib: string; qty: string }[]>`
        SELECT m.item_brand_id::text AS ib, COALESCE(SUM(
          (CASE WHEN m.type = 'REVERSAL' THEN -m.quantity ELSE m.quantity END) *
          (CASE
            WHEN l.type = 'SITE' AND l.project_id = ${so.projectId}::uuid AND COALESCE(o.type, m.type) IN ('RECEIPT', 'TRANSFER_IN') THEN 1
            WHEN l.type = 'SITE' AND l.project_id = ${so.projectId}::uuid AND COALESCE(o.type, m.type) IN ('TRANSFER_OUT', 'RETURN_TO_SUPPLIER') THEN -1
            WHEN l.type <> 'SITE' AND m.project_id = ${so.projectId}::uuid AND COALESCE(o.type, m.type) = 'CLIENT_DELIVERY' THEN 1
            ELSE 0 END)), 0)::text AS qty
        FROM stock_transactions m JOIN stock_locations l ON l.id = m.location_id
        LEFT JOIN stock_transactions o ON o.id = m.reversal_of_id
        WHERE m.organization_id = ${so.organizationId}::uuid AND m.item_brand_id = ANY(${ibIds}::uuid[])
        GROUP BY 1`
    : [];
  const projectLines = ibIds.length ? await client.soLine.findMany({ where: { kind: "MATERIAL", itemBrandId: { in: ibIds }, so: { projectId: so.projectId, status: { in: [...DRIVING] } } }, select: { id: true, itemBrandId: true, quantity: true }, orderBy: [{ so: { createdAt: "asc" } }, { lineNo: "asc" }] }) : [];
  // 1) Traced: posted site receipts of challan lines issued for a specific sales-order line go to that line.
  const traced = projectLines.length
    ? await client.$queryRaw<{ so_line_id: string; qty: string }[]>`
        SELECT cl.so_line_id::text, COALESCE(SUM(gl.accepted_qty), 0)::text AS qty
        FROM grn_lines gl JOIN grns g ON g.id = gl.grn_id JOIN challan_lines cl ON cl.id = gl.challan_line_id
        WHERE g.status = 'POSTED' AND cl.so_line_id = ANY(${projectLines.map((l) => l.id)}::uuid[])
        GROUP BY 1`
    : [];
  const tracedBy = new Map(traced.map((t) => [t.so_line_id, max0q(fmtQty(qtyUnits(t.qty)))]));
  const pool = new Map(delivered.map((d) => [d.ib, max0q(fmtQty(qtyUnits(d.qty)))]));
  const deliveredByLine = new Map<string, string>();
  for (const pl of projectLines) {
    const left = pool.get(pl.itemBrandId!) ?? Z;
    const take = minq(minq(left, tracedBy.get(pl.id) ?? Z), dec3(pl.quantity));
    deliveredByLine.set(pl.id, take);
    pool.set(pl.itemBrandId!, subQty(left, take));
  }
  // 2) Untraced deliveries (direct supplier-to-site, client deliveries, legacy challans) are shared FIFO
  //    across the project's approved orders that carry the same material, up to each line's open quantity.
  for (const pl of projectLines) {
    const left = pool.get(pl.itemBrandId!) ?? Z;
    const have = deliveredByLine.get(pl.id) ?? Z;
    const take = minq(left, max0q(subQty(dec3(pl.quantity), have)));
    deliveredByLine.set(pl.id, addQty(have, take));
    pool.set(pl.itemBrandId!, subQty(left, take));
  }
  const lineIds = so.lines.map((l) => l.id);
  const [raLines, invLines] = await Promise.all([
    client.raBillLine.findMany({ where: { soLineId: { in: lineIds }, raBill: { status: LIVE_RA, ...(opts.excludeRaBillId ? { id: { not: opts.excludeRaBillId } } : {}) } }, select: { soLineId: true, claimedQty: true, certifiedQty: true, raBill: { select: { status: true } } } }),
    client.invoiceLine.findMany({ where: { soLineId: { in: lineIds }, invoice: { status: { not: "CANCELLED" }, raBillId: null, kind: "TAX_INVOICE" } }, select: { soLineId: true, quantity: true } }),
  ]);
  const billed = new Map<string, string>();
  const bump = (k: string, q: string) => billed.set(k, addQty(billed.get(k) ?? Z, q));
  for (const r of raLines) bump(r.soLineId!, (RA_CERTIFIED as readonly string[]).includes(r.raBill.status) ? dec3(r.certifiedQty) : dec3(r.claimedQty));
  for (const i of invLines) bump(i.soLineId!, dec3(i.quantity));
  // Optional client PO: when the order is linked to one, its line quantities stay a shared ceiling for every
  // billing path (this order's running bills, other orders on the same client PO, legacy client-PO bills).
  const cpoLeft = new Map<string, string>();
  if (so.clientPoId) {
    const [cpoLines, cpoBilled] = await Promise.all([client.clientPoLine.findMany({ where: { clientPoId: so.clientPoId }, select: { id: true, quantity: true } }), cpoLineBilled(client as Tx, so.clientPoId, { excludeRaBillId: opts.excludeRaBillId })]);
    for (const c of cpoLines) cpoLeft.set(c.id, max0q(subQty(dec3(c.quantity), cpoBilled.get(c.id) ?? Z)));
  }
  const lines: SoLinePosition[] = so.lines.map((l) => {
    const contract = dec3(l.quantity);
    const b = billed.get(l.id) ?? Z;
    const d = l.kind === "MATERIAL" ? (deliveredByLine.get(l.id) ?? Z) : contract;
    let billable = max0q(subQty(minq(d, contract), b));
    if (l.clientPoLineId && cpoLeft.has(l.clientPoLineId)) billable = minq(billable, cpoLeft.get(l.clientPoLineId)!);
    return { soLineId: l.id, lineNo: l.lineNo, kind: l.kind, description: l.description, unit: l.unit, hsnSac: l.hsnSac, contractQty: contract, delivered: d, billed: b, billable, rate: netRate(dec4(l.rate), dec2(l.discountPct)), gstRate: dec2(l.gstRate) };
  });
  return { so, lines };
}

/** Previous bills, outstanding receivables and advance available for a sales order (excluding one bill). */
async function soStatement(client: Tx | typeof db, soId: string, excludeRaBillId?: string) {
  const [prev, invoices, soReceipts] = await Promise.all([
    client.raBill.findMany({ where: { soId, status: LIVE_RA, ...(excludeRaBillId ? { id: { not: excludeRaBillId } } : {}) }, select: { id: true, number: true, raNumber: true, status: true, billDate: true, claimedAmount: true, certifiedAmount: true, netPayable: true, advanceRecovery: true, isFinal: true }, orderBy: { raNumber: "asc" } }),
    client.clientInvoice.findMany({ where: { soId, status: { not: "CANCELLED" } }, select: { id: true, raBillId: true, kind: true, status: true, netReceivable: true, receivedAmount: true, adjustedAmount: true } }),
    client.payment.findMany({ where: { soId, direction: "IN", status: "POSTED" }, select: { amount: true, tdsAmount: true, allocatedAmount: true, refundedAmount: true } }),
  ]);
  const invoicedRa = new Set(invoices.filter((i) => i.raBillId).map((i) => i.raBillId!));
  const certified = (s: string) => (RA_CERTIFIED as readonly string[]).includes(s);
  const previousValue = addMoney(Z, ...prev.map((p) => (certified(p.status) ? dec2(p.certifiedAmount) : dec2(p.claimedAmount))));
  const previousBilled = addMoney(Z, ...prev.map((p) => dec2(p.netPayable)));
  const taxInvoices = invoices.filter((i) => i.kind === "TAX_INVOICE");
  // Outstanding: issued tax invoices (net − received − adjusted), draft invoices in full, and previous
  // running bills that are not invoiced yet (their net payable). Proformas are requests, not receivables.
  const invOutstanding = taxInvoices.map((i) => (i.status === "DRAFT" ? dec2(i.netReceivable) : subMoney(subMoney(dec2(i.netReceivable), dec2(i.receivedAmount)), dec2(i.adjustedAmount))));
  const raNotInvoiced = prev.filter((p) => !invoicedRa.has(p.id)).map((p) => dec2(p.netPayable));
  const previousOutstanding = addMoney(Z, ...invOutstanding, ...raNotInvoiced);
  // Received = settled on this order's invoices + the unallocated part of receipts recorded against the order
  // (an advance held for it). Allocated rupees are already in invoice.receivedAmount, so none is counted twice.
  const soAdvanceHeld = addMoney(Z, ...soReceipts.map((p) => {
    const free = subMoney(subMoney(addMoney(dec2(p.amount), dec2(p.tdsAmount)), dec2(p.allocatedAmount)), dec2(p.refundedAmount));
    return cmpMoney(free, Z) > 0 ? free : Z;
  }));
  const receivedToDate = addMoney(Z, ...invoices.map((i) => dec2(i.receivedAmount)), soAdvanceHeld);
  const advanceReceived = addMoney(Z, ...invoices.filter((i) => i.kind === "PROFORMA").map((i) => dec2(i.receivedAmount)));
  const advanceRecovered = addMoney(Z, ...prev.map((p) => dec2(p.advanceRecovery)));
  const advanceAvailable = cmpMoney(advanceReceived, advanceRecovered) > 0 ? subMoney(advanceReceived, advanceRecovered) : "0.00";
  return { prev, previousValue, previousBilled, previousOutstanding, receivedToDate, advanceReceived, advanceAvailable, hasFinal: prev.some((p) => p.isFinal) };
}

type Data = z.output<typeof soRunningBillSchema>;

async function build(tx: Tx, actor: Actor, data: Data, excludeRaBillId?: string) {
  const so = await tx.salesOrder.findFirst({ where: { AND: [{ id: data.soId }, projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput] }, select: { id: true, number: true, status: true, projectId: true, partyId: true, clientPoId: true, taxMode: true, taxable: true, orderDate: true } });
  if (!so) throw new NotFoundError("Sales order");
  if (!(DRIVING as readonly string[]).includes(so.status)) throw new ValidationError("Running bills can only be raised on an approved sales order.");
  // A client PO is optional. Only a legacy contract already billed on the client PO's own running bills
  // continues there, so one cumulative statement is kept (and nothing is billed twice).
  if (so.clientPoId) {
    const legacy = await tx.raBill.findFirst({ where: { clientPoId: so.clientPoId, status: LIVE_RA }, select: { number: true, raNumber: true } });
    if (legacy) throw new ValidationError(`${so.number}'s client PO is already billed on its own running bills (RA-${legacy.raNumber}, ${legacy.number}). Continue billing there so the contract keeps one cumulative statement.`);
  }
  if (await tx.clientInvoice.count({ where: { soId: so.id, milestoneId: { not: null }, kind: "TAX_INVOICE", status: { not: "CANCELLED" } } })) throw new ValidationError(`${so.number} is already billed by payment-milestone tax invoices. Continue billing there (advance proformas are fine with running bills).`);
  const { lines: pos } = await soBillingPosition(tx, so.id, { excludeRaBillId });
  const st = await soStatement(tx, so.id, excludeRaBillId);
  if (st.hasFinal) throw new ValidationError("The final running bill for this sales order has already been raised.");
  const overrides = new Map((data.lines ?? []).map((l) => [l.soLineId, l.claimedQty]));
  for (const id of overrides.keys()) if (!pos.some((p) => p.soLineId === id)) throw new ValidationError("A line does not belong to this sales order.");
  const lines = pos.map((p, i) => {
    const def = p.kind === "MATERIAL" || data.isFinal ? p.billable : Z;
    const qty = overrides.get(p.soLineId) ?? def;
    if (cmpQty(qty, p.billable) > 0) {
      const why = p.kind === "MATERIAL" ? `delivered ${p.delivered}, contract ${p.contractQty}, already billed ${p.billed}` : `contract ${p.contractQty}, already billed ${p.billed}`;
      throw new ValidationError(`Line ${p.lineNo} (${p.description}): only ${p.billable} ${p.unit} can be billed now (${why}).`, { [`lines.${i}.claimedQty`]: `Max ${p.billable}.` });
    }
    return { soLineId: p.soLineId, contractQty: p.contractQty, prevCertifiedQty: p.billed, deliveredQty: p.delivered, rate: p.rate, gstRate: p.gstRate, claimedQty: qty, claimedAmount: qtyTimesRate(qty, p.rate) };
  });
  const current = lines.filter((l) => cmpQty(l.claimedQty, Z) > 0);
  if (!current.length) throw new ValidationError("Nothing new to bill: no delivered material or service quantity is left unbilled on this sales order.", { lines: "Nothing to bill." });
  // Keep lines with history too, so the bill shows previous / current / cumulative for each item.
  const kept = lines.filter((l) => cmpQty(l.claimedQty, Z) > 0 || cmpQty(l.prevCertifiedQty, Z) > 0);
  const gross = addMoney(Z, ...current.map((l) => l.claimedAmount));
  const gst = addMoney(Z, ...current.map((l) => pctOf(l.claimedAmount, l.gstRate)));
  const amounts = deductions({ gross, gst, retentionPct: data.retentionPct, otherDeductions: data.otherDeductions, advanceRecovery: data.advanceRecovery, advanceAvailable: st.advanceAvailable, advanceReceived: st.advanceReceived, soTaxable: dec2(so.taxable), isFinal: data.isFinal });
  return { so, lines: kept, gross, gst, amounts, st };
}

function deductions(o: { gross: string; gst: string; retentionPct: string; otherDeductions: string; advanceRecovery: string | null; advanceAvailable: string; advanceReceived: string; soTaxable: string; isFinal: boolean }) {
  const retention = pctOf(o.gross, o.retentionPct);
  let advance: string;
  if (o.advanceRecovery !== null) {
    if (cmpMoney(o.advanceRecovery, o.advanceAvailable) > 0) throw new ValidationError(`Advance recovery cannot exceed the advance still to recover (${o.advanceAvailable}).`, { advanceRecovery: `Max ${o.advanceAvailable}.` });
    advance = fmtMoney(money(o.advanceRecovery));
  } else if (o.isFinal || cmpMoney(o.soTaxable, Z) <= 0) {
    advance = o.advanceAvailable;
  } else {
    // Recover the advance in proportion to the share of the order billed now.
    const share = fmtMoney(divRound(money(o.advanceReceived) * money(o.gross), money(o.soTaxable)));
    advance = cmpMoney(share, o.advanceAvailable) > 0 ? o.advanceAvailable : share;
  }
  const net = subMoney(subMoney(subMoney(addMoney(o.gross, o.gst), retention), advance), o.otherDeductions);
  if (cmpMoney(net, Z) < 0) throw new ValidationError("Deductions exceed the bill value. Reduce the deductions.", { otherDeductions: "Too high." });
  return { retention, advance, net };
}

/**
 * Generates the next running bill for a sales order — or refreshes (consolidates) its existing draft
 * with everything delivered and unbilled so far. Returns the draft.
 */
export async function generateSoRunningBill(actor: Actor, input: unknown) {
  requirePermission(actor, "rabill.manage");
  const data = parseInput(soRunningBillSchema, input);
  return db.$transaction(
    async (tx) => {
      await lockSo(tx, data.soId);
      const draft = await tx.raBill.findFirst({ where: { soId: data.soId, status: "DRAFT" }, select: { id: true, number: true, raNumber: true, billDate: true, periodFrom: true, periodTo: true } });
      const { so, lines, gross, gst, amounts, st } = await build(tx, actor, data, draft?.id);
      const today = startOfToday().toISOString().slice(0, 10);
      const lastTo = st.prev.length ? await tx.raBill.findFirst({ where: { soId: so.id, status: LIVE_RA, ...(draft ? { id: { not: draft.id } } : {}) }, orderBy: { raNumber: "desc" }, select: { periodTo: true } }) : null;
      const billDate = data.billDate ?? draft?.billDate.toISOString().slice(0, 10) ?? today;
      const periodTo = data.periodTo ?? billDate;
      // Default: the day after the previous bill's period (never after this bill's end — same-day bills are fine).
      const nextFrom = (lastTo ? new Date(lastTo.periodTo.getTime() + 86_400_000) : so.orderDate).toISOString().slice(0, 10);
      const periodFrom = data.periodFrom ?? draft?.periodFrom.toISOString().slice(0, 10) ?? (nextFrom > periodTo ? periodTo : nextFrom);
      if (periodTo < periodFrom) throw new ValidationError("The period ends before it starts.", { periodTo: "Before period start." });
      const header = {
        billDate: new Date(`${billDate}T00:00:00Z`),
        periodFrom: new Date(`${periodFrom}T00:00:00Z`),
        periodTo: new Date(`${periodTo}T00:00:00Z`),
        taxMode: so.taxMode,
        claimedAmount: gross,
        retentionPct: data.retentionPct,
        retentionAmount: amounts.retention,
        advanceRecovery: amounts.advance,
        otherDeductions: data.otherDeductions,
        deductionNotes: data.deductionNotes,
        gstAmount: gst,
        netPayable: amounts.net,
        remarks: data.remarks,
        isFinal: data.isFinal,
        previousValue: st.previousValue,
        previousBilled: st.previousBilled,
        previousOutstanding: st.previousOutstanding,
        receivedToDate: st.receivedToDate,
      };
      if (draft) {
        await tx.raBillLine.deleteMany({ where: { raBillId: draft.id } });
        await tx.raBillLine.createMany({ data: lines.map((l) => ({ ...l, raBillId: draft.id })) });
        await tx.raBill.update({ where: { id: draft.id }, data: { ...header, version: { increment: 1 } } });
        await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rabill.updated", entityType: "ra_bill", entityId: draft.id, projectId: so.projectId, summary: `Refreshed draft ${draft.number} (RA-${draft.raNumber}) on ${so.number}: this bill ₹${gross}, cumulative ₹${addMoney(st.previousValue, gross)}` }, tx);
        return { id: draft.id, number: draft.number, consolidated: true };
      }
      const last = await tx.raBill.aggregate({ where: { soId: so.id }, _max: { raNumber: true } });
      const raNumber = (last._max.raNumber ?? 0) + 1;
      const number = await nextDocNumber(tx, actor.organizationId, "RAB", header.billDate);
      const bill = await tx.raBill.create({ data: { organizationId: actor.organizationId, number, raNumber, projectId: so.projectId, soId: so.id, partyId: so.partyId, ...header, createdById: actor.id, lines: { create: lines } } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "rabill.created", entityType: "ra_bill", entityId: bill.id, projectId: so.projectId, summary: `Prepared RA-${raNumber} (${number}) on ${so.number}: this bill ₹${gross}, cumulative ₹${addMoney(st.previousValue, gross)}, previous outstanding ₹${st.previousOutstanding}` }, tx);
      return { id: bill.id, number, consolidated: false };
    },
    { timeout: 20000 },
  );
}

/** Client certification of a sales-order bill (certified ≤ claimed); deductions and statement refreshed. */
export async function certifySoRunningBillTx(tx: Tx, bill: { id: string; soId: string; retentionPct: string; otherDeductions: string; advanceRecovery: string; isFinal: boolean }, certified: { lineId: string; certifiedQty: string; amount: string; gstRate: string }[], otherDeductions: string) {
  await lockSo(tx, bill.soId);
  const st = await soStatement(tx, bill.soId, bill.id);
  const so = await tx.salesOrder.findUniqueOrThrow({ where: { id: bill.soId }, select: { taxable: true } });
  const gross = addMoney(Z, ...certified.map((c) => c.amount));
  const gst = addMoney(Z, ...certified.map((c) => pctOf(c.amount, c.gstRate)));
  const keepAdvance = cmpMoney(bill.advanceRecovery, st.advanceAvailable) <= 0 ? bill.advanceRecovery : st.advanceAvailable;
  const amounts = deductions({ gross, gst, retentionPct: bill.retentionPct, otherDeductions, advanceRecovery: keepAdvance, advanceAvailable: st.advanceAvailable, advanceReceived: st.advanceReceived, soTaxable: dec2(so.taxable), isFinal: bill.isFinal });
  return { gross, gst, amounts, statement: { previousValue: st.previousValue, previousBilled: st.previousBilled, previousOutstanding: st.previousOutstanding, receivedToDate: st.receivedToDate } };
}

/** What a new / refreshed bill would contain — for the sales-order page and the bill editor. */
export async function soRunningBillPreview(actor: Actor, soId: string) {
  requirePermission(actor, "rabill.view");
  const so = await db.salesOrder.findFirst({ where: { AND: [{ id: soId }, projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput] }, select: { id: true } });
  if (!so) throw new NotFoundError("Sales order");
  const draft = await db.raBill.findFirst({ where: { soId, status: "DRAFT" }, select: { id: true, number: true } });
  const { lines } = await soBillingPosition(db, soId, { excludeRaBillId: draft?.id });
  const st = await soStatement(db, soId, draft?.id);
  return { draft, lines, statement: { previousValue: st.previousValue, previousBilled: st.previousBilled, previousOutstanding: st.previousOutstanding, receivedToDate: st.receivedToDate, advanceAvailable: st.advanceAvailable, hasFinal: st.hasFinal }, previousBills: st.prev.map((p) => ({ id: p.id, number: p.number, raNumber: p.raNumber, status: p.status, billDate: p.billDate.toISOString(), netPayable: dec2(p.netPayable) })) };
}

/** Previous bills of the same order with what is still outstanding on each — for the bill page / PDF. */
export async function previousBillsWithOutstanding(client: Tx | typeof db, soId: string, beforeRaNumber: number) {
  const bills = await client.raBill.findMany({ where: { soId, status: LIVE_RA, raNumber: { lt: beforeRaNumber } }, orderBy: { raNumber: "asc" }, select: { id: true, number: true, raNumber: true, billDate: true, netPayable: true, invoice: { select: { number: true, status: true, netReceivable: true, receivedAmount: true, adjustedAmount: true } } } });
  return bills.map((b) => {
    const inv = b.invoice && b.invoice.status !== "CANCELLED" ? b.invoice : null;
    const received = inv ? addMoney(dec2(inv.receivedAmount), dec2(inv.adjustedAmount)) : "0.00";
    const outstanding = inv ? (inv.status === "DRAFT" ? dec2(inv.netReceivable) : subMoney(dec2(inv.netReceivable), received)) : dec2(b.netPayable);
    return { id: b.id, number: b.number, raNumber: b.raNumber, billDate: b.billDate.toISOString(), netPayable: dec2(b.netPayable), invoice: inv?.number ?? null, received, outstanding };
  });
}

export const totalPayable = (previousOutstanding: string, netPayable: string) => addMoney(previousOutstanding, netPayable);
