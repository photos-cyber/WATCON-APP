import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { addMoney, cmpMoney, subMoney } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { projectAccessWhere } from "@/lib/permissions/scopes";
import { requirePermission, dec2 } from "@/modules/commercial/core";
import { projectFinancials, sumFinancials, type ProjectFinancials } from "./finance";

/** Project accounts (one row per accessible project) and party ledgers. Operational sub-ledger, not a GL. */

export async function projectAccountsSummary(actor: Actor, opts: { includeArchived?: boolean } = {}) {
  requirePermission(actor, "accounts.view");
  const projects = await db.project.findMany({
    where: { AND: [projectAccessWhere(actor), opts.includeArchived ? {} : { archivedAt: null }] },
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true, status: true },
  });
  const fin = await projectFinancials(actor.organizationId, projects.map((p) => p.id));
  const rows = projects.map((p) => ({ project: p, ...(fin.get(p.id) as ProjectFinancials) }));
  return { rows, totals: sumFinancials(rows) };
}

export type LedgerEntry = {
  key: string;
  date: string;
  type: string;
  number: string;
  href: string;
  project: string | null;
  description: string;
  debit: string;
  credit: string;
  balance: string;
};

const ledgerQuery = z.object({ partyId: z.string().uuid(), projectId: z.string().uuid().optional().catch(undefined) });

/**
 * Party ledger: every live bill, invoice, payment, receipt and note with this party, oldest first.
 * Debit = the party owes us more (invoice, our payment to them, notes reducing what we owe).
 * Credit = we owe them more / they paid us (supplier bill, client receipt, client credit note).
 * Balance > 0 → receivable from the party (Dr); < 0 → payable to the party (Cr).
 */
export async function partyLedger(actor: Actor, raw: unknown) {
  requirePermission(actor, "accounts.view");
  const q = ledgerQuery.parse(raw);
  const party = await db.party.findFirst({ where: { id: q.partyId, organizationId: actor.organizationId }, select: { id: true, code: true, name: true, gstin: true, isClient: true, isSupplier: true } });
  if (!party) throw new NotFoundError("Party");
  const projectScope = can(actor, "projects.view_all") ? {} : { OR: [{ projectId: null }, { project: { is: projectAccessWhere(actor) } }] };
  const w = { organizationId: actor.organizationId, partyId: party.id, ...(q.projectId ? { projectId: q.projectId } : {}), ...projectScope };
  const proj = { select: { code: true } } as const;

  const [bills, invoices, payments, notes] = await Promise.all([
    db.supplierBill.findMany({ where: { ...w, status: { in: ["APPROVED", "PARTIALLY_PAID", "PAID"] } }, include: { project: proj } }),
    db.clientInvoice.findMany({ where: { organizationId: actor.organizationId, partyId: party.id, ...(q.projectId ? { projectId: q.projectId } : {}), ...(can(actor, "projects.view_all") ? {} : { project: { is: projectAccessWhere(actor) } }), status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } }, include: { project: proj } }),
    db.payment.findMany({ where: { ...w, status: "POSTED" }, include: { project: proj } }),
    db.adjustmentNote.findMany({ where: { ...w, status: "APPROVED" }, include: { project: proj } }),
  ]);

  type Raw = Omit<LedgerEntry, "balance"> & { sort: string };
  const raw_: Raw[] = [];
  const z0 = "0.00";
  for (const b of bills) raw_.push({ key: `sb-${b.id}`, sort: `${b.invoiceDate.toISOString()}-1`, date: b.invoiceDate.toISOString(), type: "Supplier bill", number: b.number, href: `/supplier-bills/${b.id}`, project: b.project?.code ?? null, description: `Invoice ${b.supplierInvoiceNo}${cmpMoney(dec2(b.tdsAmount), z0) > 0 ? ` (net of TDS ${dec2(b.tdsAmount)})` : ""}`, debit: z0, credit: dec2(b.netPayable) });
  for (const i of invoices) raw_.push({ key: `inv-${i.id}`, sort: `${i.invoiceDate.toISOString()}-1`, date: i.invoiceDate.toISOString(), type: "Client invoice", number: i.number, href: `/client-invoices/${i.id}`, project: i.project.code, description: cmpMoney(dec2(i.total), dec2(i.netReceivable)) !== 0 ? `Invoice ${dec2(i.total)} less retention / deductions` : "Tax invoice", debit: dec2(i.netReceivable), credit: z0 });
  for (const p of payments) {
    const total = addMoney(dec2(p.amount), dec2(p.tdsAmount));
    raw_.push({ key: `pay-${p.id}`, sort: `${p.paymentDate.toISOString()}-2`, date: p.paymentDate.toISOString(), type: p.direction === "OUT" ? "Payment" : "Receipt", number: p.number, href: `/payments/${p.id}`, project: p.project?.code ?? null, description: `${p.mode.replace(/_/g, " ").toLowerCase()}${p.reference ? ` · ${p.reference}` : ""}${cmpMoney(dec2(p.tdsAmount), z0) > 0 ? ` (incl. TDS ${dec2(p.tdsAmount)})` : ""}`, debit: p.direction === "OUT" ? total : z0, credit: p.direction === "IN" ? total : z0 });
  }
  for (const n of notes) {
    const supplierSide = n.partyRole === "SUPPLIER";
    const isDebit = supplierSide || n.noteType === "DEBIT";
    raw_.push({ key: `note-${n.id}`, sort: `${n.noteDate.toISOString()}-3`, date: n.noteDate.toISOString(), type: `${n.noteType === "CREDIT" ? "Credit" : "Debit"} note`, number: n.number, href: `/notes/${n.id}`, project: n.project?.code ?? null, description: n.reason, debit: isDebit ? dec2(n.total) : z0, credit: isDebit ? z0 : dec2(n.total) });
  }
  raw_.sort((a, b) => a.sort.localeCompare(b.sort) || a.number.localeCompare(b.number));
  let bal = z0;
  let totalDebit = z0;
  let totalCredit = z0;
  const entries: LedgerEntry[] = raw_.map((r) => {
    const e = { key: r.key, date: r.date, type: r.type, number: r.number, href: r.href, project: r.project, description: r.description, debit: r.debit, credit: r.credit };
    bal = subMoney(addMoney(bal, e.debit), e.credit);
    totalDebit = addMoney(totalDebit, e.debit);
    totalCredit = addMoney(totalCredit, e.credit);
    return { ...e, balance: bal };
  });
  return { party, entries, totalDebit, totalCredit, closing: bal };
}
