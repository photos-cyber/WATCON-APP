import "server-only";
import { db } from "@/lib/db";
import { addMoney, cmpMoney, fmtMoney, money, percent, qtyTimesRate, subMoney } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { assertProjectVisible, dec2, requirePermission } from "@/modules/commercial/core";
import { getMrp } from "@/modules/planning/service";
import { clientAccount, type ClientAccount } from "@/modules/sales/client-account";

/**
 * Project Accounts dashboard (workflow v2 · Phase 8) — operational, not a general ledger.
 *
 * Client side: from `clientAccount` (contract, billed, received, outstanding, unbilled, advances, remaining).
 * Supplier side:
 *   poValue        approved purchase-order lines for this project — incl. lines of combined / general
 *                  POs allocated to this project's requirements (a commitment, NOT an expense)
 *   supplierBills  approved supplier bills of this project (incl. GST)
 *   paymentsMade   supplier payments of this project (refunds to clients excluded)
 *   advances       supplier payments not yet set against bills
 *   outstanding    approved bills' net payable − paid − supplier notes
 * Financial summary (all excl. GST):
 *   materialCost   material that actually reached the project — site receipts at their purchase cost,
 *                  issues / client deliveries from stock at the average purchase cost, net of returns.
 *                  General-stock purchases become project cost only when issued to the project.
 *   otherExpenses  approved supplier bills of this project for non-stock lines (services, labour)
 *                  and freight / charges — material lines are already in materialCost
 *   estRemaining   open requirements still to be issued × last purchase rate (estimate)
 *   estProfit      contract value (excl. GST) − (materialCost + otherExpenses + estRemaining)
 *   revenue        recognised revenue = issued tax invoices (excl. GST); contract value is not revenue
 *   actualMargin   revenue − (materialCost + otherExpenses), only once something is invoiced
 */
export type SupplierSide = { poValue: string; supplierBills: string; paymentsMade: string; advances: string; outstanding: string };
export type FinancialSummary = {
  contractTaxable: string;
  revenue: string;
  materialCost: string;
  otherExpenses: string;
  estRemaining: string;
  unpricedLines: number;
  estProfit: string;
  estProfitPct: string | null;
  actualMargin: string | null;
  actualMarginPct: string | null;
};

const BILL_APPROVED = ["APPROVED", "PARTIALLY_PAID", "PAID"] as const;
const PO_COMMITTED = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"];
const max0 = (v: string) => (cmpMoney(v, "0") > 0 ? v : "0.00");
const m2 = (v: string | null | undefined) => fmtMoney(money(v ?? "0"));

export async function projectMaterialCost(organizationId: string, projectId: string) {
  const [row] = await db.$queryRaw<{ v: string }[]>`
    WITH avg AS (
      SELECT item_brand_id, SUM(quantity * unit_cost) / NULLIF(SUM(quantity), 0) AS c
      FROM stock_transactions WHERE organization_id = ${organizationId}::uuid AND type = 'RECEIPT' AND unit_cost IS NOT NULL
      GROUP BY 1
    )
    SELECT ROUND(COALESCE(SUM(
      (CASE WHEN m.type = 'REVERSAL' THEN -m.quantity ELSE m.quantity END) *
      (CASE
        WHEN l.type = 'SITE' AND l.project_id = ${projectId}::uuid AND COALESCE(o.type, m.type) IN ('RECEIPT', 'TRANSFER_IN') THEN 1
        WHEN l.type = 'SITE' AND l.project_id = ${projectId}::uuid AND COALESCE(o.type, m.type) IN ('TRANSFER_OUT', 'RETURN_TO_SUPPLIER') THEN -1
        WHEN l.type <> 'SITE' AND m.project_id = ${projectId}::uuid AND COALESCE(o.type, m.type) = 'CLIENT_DELIVERY' THEN 1
        ELSE 0 END) *
      COALESCE(CASE WHEN COALESCE(o.type, m.type) = 'RECEIPT' THEN COALESCE(o.unit_cost, m.unit_cost) END, a.c, 0)
    ), 0), 2)::text AS v
    FROM stock_transactions m
    JOIN stock_locations l ON l.id = m.location_id
    LEFT JOIN stock_transactions o ON o.id = m.reversal_of_id
    LEFT JOIN avg a ON a.item_brand_id = m.item_brand_id
    WHERE m.organization_id = ${organizationId}::uuid`;
  return m2(row?.v);
}

export async function projectAccountsDashboard(actor: Actor, projectId: string) {
  requirePermission(actor, "accounts.view");
  await assertProjectVisible(actor, projectId);
  const org = actor.organizationId;
  const client: ClientAccount | null = await clientAccount(actor, { projectId }).catch(() => null);

  const [po, bills, payOut, otherRows, contract, revenue, materialCost] = await Promise.all([
    db.$queryRaw<{ v: string }[]>`
      SELECT COALESCE(SUM(pl.total), 0)::text AS v
      FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      LEFT JOIN pr_lines prl ON prl.id = pl.pr_line_id
      LEFT JOIN material_requirements mr ON mr.id = COALESCE(pl.requirement_id, prl.requirement_id)
      WHERE po.organization_id = ${org}::uuid AND po.status::text = ANY(${PO_COMMITTED}::text[])
        AND (po.project_id = ${projectId}::uuid OR (po.project_id IS NULL AND mr.project_id = ${projectId}::uuid))`,
    db.supplierBill.aggregate({ where: { organizationId: org, projectId, status: { in: [...BILL_APPROVED] } }, _sum: { total: true, netPayable: true, paidAmount: true, adjustedAmount: true, charges: true } }),
    db.payment.findMany({ where: { organizationId: org, projectId, direction: "OUT", status: "POSTED", refundOfId: null }, select: { amount: true, allocatedAmount: true } }),
    db.supplierBillLine.aggregate({ where: { itemBrandId: null, bill: { organizationId: org, projectId, status: { in: [...BILL_APPROVED] } } }, _sum: { taxable: true } }),
    Promise.all([
      db.clientPo.aggregate({ where: { organizationId: org, projectId, status: { in: ["ACTIVE", "COMPLETED", "CLOSED"] }, salesOrders: { none: { status: { in: ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] } } } }, _sum: { taxable: true } }),
      db.salesOrder.aggregate({ where: { organizationId: org, projectId, status: { in: ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] } }, _sum: { taxable: true } }),
    ]),
    db.clientInvoice.aggregate({ where: { organizationId: org, projectId, kind: "TAX_INVOICE", status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } }, _sum: { taxable: true } }),
    projectMaterialCost(org, projectId),
  ]);

  const supplier: SupplierSide = {
    poValue: m2(po[0]?.v),
    supplierBills: dec2(bills._sum.total),
    paymentsMade: addMoney("0", ...payOut.map((p) => dec2(p.amount))),
    advances: addMoney("0", ...payOut.map((p) => max0(subMoney(dec2(p.amount), dec2(p.allocatedAmount))))),
    outstanding: max0(subMoney(subMoney(dec2(bills._sum.netPayable), dec2(bills._sum.paidAmount)), dec2(bills._sum.adjustedAmount))),
  };

  // Estimated remaining material cost from the project's open requirements (when planning is visible).
  let estRemaining = "0.00";
  let unpricedLines = 0;
  if (can(actor, "mrp.view")) {
    const plan = await getMrp(actor, { projectId, view: "open" });
    for (const r of plan.rows) {
      const left = Number(r.requiredQty) - Number(r.issuedQty);
      if (left <= 0) continue;
      if (!r.lastPurchaseRate) {
        unpricedLines++;
        continue;
      }
      estRemaining = addMoney(estRemaining, qtyTimesRate(String(Math.round(left * 1000) / 1000), r.lastPurchaseRate));
    }
  }
  const otherExpenses = addMoney(dec2(otherRows._sum.taxable), dec2(bills._sum.charges));
  const contractTaxable = addMoney(dec2(contract[0]._sum.taxable), dec2(contract[1]._sum.taxable));
  const rev = dec2(revenue._sum.taxable);
  const estCost = addMoney(materialCost, otherExpenses, estRemaining);
  const estProfit = subMoney(contractTaxable, estCost);
  const actual = cmpMoney(rev, "0") > 0 ? subMoney(rev, addMoney(materialCost, otherExpenses)) : null;
  const summary: FinancialSummary = {
    contractTaxable,
    revenue: rev,
    materialCost,
    otherExpenses,
    estRemaining,
    unpricedLines,
    estProfit,
    estProfitPct: cmpMoney(contractTaxable, "0") > 0 ? percent(estProfit, contractTaxable) : null,
    actualMargin: actual,
    actualMarginPct: actual !== null ? percent(actual, rev) : null,
  };
  return { client, supplier, summary };
}

// ─────────────────────────── Transaction history ───────────────────────────

export type ProjectTxn = { key: string; date: string; kind: string; number: string; party: string | null; amount: string | null; flow: "IN" | "OUT" | "NONE"; status: string; href: string; proofs: number };

/** Chronological money and material history of a project, newest first, linked to each record and its proofs. */
export async function projectTransactions(actor: Actor, projectId: string, limit = 200): Promise<ProjectTxn[]> {
  requirePermission(actor, "accounts.view");
  await assertProjectVisible(actor, projectId);
  const where = { organizationId: actor.organizationId, projectId };
  const [inv, pays, ras, bills, notes, grns, challans] = await Promise.all([
    db.clientInvoice.findMany({ where: { ...where, status: { not: "DRAFT" } }, select: { id: true, number: true, kind: true, invoiceDate: true, total: true, status: true, party: { select: { name: true } } }, orderBy: { invoiceDate: "desc" }, take: limit }),
    db.payment.findMany({ where, select: { id: true, number: true, direction: true, refundOfId: true, paymentDate: true, amount: true, tdsAmount: true, status: true, party: { select: { name: true } } }, orderBy: { paymentDate: "desc" }, take: limit }),
    db.raBill.findMany({ where: { ...where, status: { not: "DRAFT" } }, select: { id: true, number: true, raNumber: true, billDate: true, netPayable: true, status: true, party: { select: { name: true } } }, orderBy: { billDate: "desc" }, take: limit }),
    db.supplierBill.findMany({ where: { ...where, status: { not: "DRAFT" } }, select: { id: true, number: true, supplierInvoiceNo: true, invoiceDate: true, total: true, status: true, party: { select: { name: true } } }, orderBy: { invoiceDate: "desc" }, take: limit }),
    db.adjustmentNote.findMany({ where: { ...where, status: { not: "DRAFT" } }, select: { id: true, number: true, noteType: true, partyRole: true, noteDate: true, total: true, status: true, party: { select: { name: true } } }, orderBy: { noteDate: "desc" }, take: limit }),
    db.grn.findMany({ where: { ...where, status: { in: ["POSTED", "REVERSED"] } }, select: { id: true, number: true, receiptDate: true, status: true, poId: true, party: { select: { name: true } }, lines: { select: { acceptedQty: true, unitCost: true } } }, orderBy: { receiptDate: "desc" }, take: limit }),
    db.challan.findMany({ where: { ...where, status: { notIn: ["DRAFT", "CANCELLED"] } }, select: { id: true, number: true, type: true, dispatchDate: true, status: true }, orderBy: { dispatchDate: "desc" }, take: limit }),
  ]);
  const iso = (d: Date | null) => (d ?? new Date(0)).toISOString();
  const rows: (Omit<ProjectTxn, "proofs"> & { entity: string; id: string })[] = [
    ...inv.map((r) => ({ id: r.id, entity: "client_invoice", key: `inv:${r.id}`, date: iso(r.invoiceDate), kind: r.kind === "PROFORMA" ? "Proforma (advance request)" : "Client invoice", number: r.number, party: r.party.name, amount: dec2(r.total), flow: (r.kind === "PROFORMA" ? "NONE" : "IN") as ProjectTxn["flow"], status: r.status, href: `/client-invoices/${r.id}` })),
    ...pays.map((r) => ({ id: r.id, entity: "payment", key: `pay:${r.id}`, date: iso(r.paymentDate), kind: r.direction === "IN" ? "Client receipt" : r.refundOfId ? "Refund to client" : "Supplier payment", number: r.number, party: r.party.name, amount: addMoney(dec2(r.amount), dec2(r.tdsAmount)), flow: (r.direction === "IN" ? "IN" : "OUT") as ProjectTxn["flow"], status: r.status, href: `/payments/${r.id}` })),
    ...ras.map((r) => ({ id: r.id, entity: "ra_bill", key: `ra:${r.id}`, date: iso(r.billDate), kind: `Running bill RA-${r.raNumber}`, number: r.number, party: r.party.name, amount: dec2(r.netPayable), flow: "NONE" as const, status: r.status, href: `/running-bills/${r.id}` })),
    ...bills.map((r) => ({ id: r.id, entity: "supplier_bill", key: `bill:${r.id}`, date: iso(r.invoiceDate), kind: "Supplier bill", number: `${r.number} (${r.supplierInvoiceNo})`, party: r.party.name, amount: dec2(r.total), flow: "OUT" as const, status: r.status, href: `/supplier-bills/${r.id}` })),
    ...notes.map((r) => ({ id: r.id, entity: "adjustment_note", key: `note:${r.id}`, date: iso(r.noteDate), kind: `${r.noteType === "CREDIT" ? "Credit" : "Debit"} note (${r.partyRole === "CLIENT" ? "client" : "supplier"})`, number: r.number, party: r.party.name, amount: dec2(r.total), flow: "NONE" as const, status: r.status, href: `/notes/${r.id}` })),
    ...grns.map((r) => ({ id: r.id, entity: "grn", key: `grn:${r.id}`, date: iso(r.receiptDate), kind: r.poId ? "Material received from supplier" : "Material received at site", number: r.number, party: r.party?.name ?? null, amount: r.poId ? fmtMoney(r.lines.reduce((a, l) => a + money(qtyTimesRate(String(l.acceptedQty), l.unitCost?.toString() ?? "0")), BigInt(0))) : null, flow: "NONE" as const, status: r.status, href: `/site-receipts/${r.id}` })),
    ...challans.map((r) => ({ id: r.id, entity: "challan", key: `dc:${r.id}`, date: iso(r.dispatchDate), kind: r.type === "CLIENT_DELIVERY" ? "Delivery to client" : "Site challan", number: r.number, party: null, amount: null, flow: "NONE" as const, status: r.status, href: `/challans/${r.id}` })),
  ];
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
  const top = rows.slice(0, limit);
  const counts = top.length ? await db.attachment.groupBy({ by: ["entityType", "entityId"], where: { organizationId: actor.organizationId, deletedAt: null, OR: top.map((r) => ({ entityType: r.entity, entityId: r.id })) }, _count: true }) : [];
  const proof = new Map(counts.map((c) => [`${c.entityType}:${c.entityId}`, c._count]));
  return top.map(({ entity, id, ...r }) => ({ ...r, proofs: proof.get(`${entity}:${id}`) ?? 0 }));
}

// ─────────────────────────── Reconciliation ───────────────────────────

/**
 * Stored settlement counters vs their authoritative records (allocations / refunds). Must be empty.
 * Read-only; also printed by scripts/audit-stock-postings.ts.
 */
export async function accountsReconciliation(organizationId: string) {
  const q = <T>(sql: TemplateStringsArray, ...v: unknown[]) => db.$queryRaw<T[]>(sql, ...v);
  const [inv, bills, pays, refunds] = await Promise.all([
    q<{ id: string; number: string; stored: string; actual: string }>`
      SELECT i.id::text, i.number, i.received_amount::text AS stored, COALESCE(SUM(a.amount) FILTER (WHERE a.reversed_at IS NULL), 0)::text AS actual
      FROM client_invoices i LEFT JOIN payment_allocations a ON a.client_invoice_id = i.id
      WHERE i.organization_id = ${organizationId}::uuid GROUP BY i.id HAVING i.received_amount <> COALESCE(SUM(a.amount) FILTER (WHERE a.reversed_at IS NULL), 0)`,
    q<{ id: string; number: string; stored: string; actual: string }>`
      SELECT b.id::text, b.number, b.paid_amount::text AS stored, COALESCE(SUM(a.amount) FILTER (WHERE a.reversed_at IS NULL), 0)::text AS actual
      FROM supplier_bills b LEFT JOIN payment_allocations a ON a.supplier_bill_id = b.id
      WHERE b.organization_id = ${organizationId}::uuid GROUP BY b.id HAVING b.paid_amount <> COALESCE(SUM(a.amount) FILTER (WHERE a.reversed_at IS NULL), 0)`,
    q<{ id: string; number: string; stored: string; actual: string }>`
      SELECT p.id::text, p.number, p.allocated_amount::text AS stored, COALESCE(SUM(a.amount) FILTER (WHERE a.reversed_at IS NULL), 0)::text AS actual
      FROM payments p LEFT JOIN payment_allocations a ON a.payment_id = p.id
      WHERE p.organization_id = ${organizationId}::uuid GROUP BY p.id HAVING p.allocated_amount <> COALESCE(SUM(a.amount) FILTER (WHERE a.reversed_at IS NULL), 0)`,
    q<{ id: string; number: string; stored: string; actual: string }>`
      SELECT p.id::text, p.number, p.refunded_amount::text AS stored, COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'POSTED'), 0)::text AS actual
      FROM payments p LEFT JOIN payments r ON r.refund_of_id = p.id
      WHERE p.organization_id = ${organizationId}::uuid GROUP BY p.id HAVING p.refunded_amount <> COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'POSTED'), 0)`,
  ]);
  const issues = [
    ...inv.map((r) => ({ code: "invoice_received", detail: `Invoice ${r.number}: stored received ${r.stored}, allocations ${r.actual}` })),
    ...bills.map((r) => ({ code: "bill_paid", detail: `Bill ${r.number}: stored paid ${r.stored}, allocations ${r.actual}` })),
    ...pays.map((r) => ({ code: "payment_allocated", detail: `Payment ${r.number}: stored allocated ${r.stored}, allocations ${r.actual}` })),
    ...refunds.map((r) => ({ code: "payment_refunded", detail: `Receipt ${r.number}: stored refunded ${r.stored}, refunds ${r.actual}` })),
  ];
  return { errors: issues.length, issues };
}
