import "server-only";
import { db } from "@/lib/db";

/**
 * Read-only inventory posting audit (workflow v2 · Phase 4). Finds duplicate or inconsistent stock
 * postings in existing (legacy) data; changes nothing. Run with `scripts/audit-stock-postings.ts`.
 *
 * Errors (must be zero):
 *   ledger_vs_balance   location balance ≠ signed sum of its ledger entries
 *   balance_vs_total    item–brand current_qty ≠ sum of its location balances
 *   grn_duplicate       a receipt line posted more than one live receipt movement
 *   grn_orphan          stock movements from a receipt that is not POSTED / REVERSED
 *   grn_missing         a posted receipt line with accepted qty but no stock movement
 *   po_accepted         PO line accepted_qty ≠ Σ accepted qty of its posted receipts
 *   bill_stock          any stock movement sourced from a supplier bill (bills never move stock)
 * Warnings (review by hand):
 *   manual_after_grn    a manual INWARD of the same item–brand, same location and same quantity
 *                       within 7 days of a posted receipt — possibly the same delivery entered twice
 */
export type IntegrityIssue = { code: string; severity: "error" | "warning"; detail: string; ref: Record<string, string | null> };

export async function inventoryIntegrityReport(organizationId: string) {
  const q = <T>(sql: TemplateStringsArray, ...v: unknown[]) => db.$queryRaw<T[]>(sql, ...v);
  const [ledger, totals, dupes, orphans, missing, poAccepted, billMoves, manual] = await Promise.all([
    q<{ item_brand_id: string; location_id: string; balance: string; ledger: string }>`
      SELECT b.item_brand_id::text, b.location_id::text, b.on_hand::text AS balance, COALESCE(t.s, 0)::text AS ledger
      FROM stock_balances b
      LEFT JOIN (SELECT item_brand_id, location_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS s FROM stock_transactions WHERE organization_id = ${organizationId}::uuid GROUP BY 1, 2) t
        ON t.item_brand_id = b.item_brand_id AND t.location_id = b.location_id
      WHERE b.organization_id = ${organizationId}::uuid AND b.on_hand <> COALESCE(t.s, 0)`,
    q<{ item_brand_id: string; current: string; balances: string }>`
      SELECT ib.id::text AS item_brand_id, ib.current_qty::text AS current, COALESCE(SUM(b.on_hand), 0)::text AS balances
      FROM item_brands ib LEFT JOIN stock_balances b ON b.item_brand_id = ib.id
      WHERE ib.organization_id = ${organizationId}::uuid
      GROUP BY ib.id HAVING ib.current_qty <> COALESCE(SUM(b.on_hand), 0)`,
    q<{ grn_id: string; idempotency_key: string; n: number }>`
      SELECT m.source_id::text AS grn_id, split_part(m.idempotency_key, ':', 3) AS idempotency_key, COUNT(*)::int AS n
      FROM stock_transactions m
      WHERE m.organization_id = ${organizationId}::uuid AND m.source_type = 'grn' AND m.type IN ('RECEIPT', 'INWARD')
        AND NOT EXISTS (SELECT 1 FROM stock_transactions r WHERE r.reversal_of_id = m.id)
      GROUP BY 1, 2 HAVING COUNT(*) > 1`,
    q<{ grn_id: string; number: string; status: string; n: number }>`
      SELECT g.id::text AS grn_id, g.number, g.status::text, COUNT(m.id)::int AS n
      FROM grns g JOIN stock_transactions m ON m.source_type = 'grn' AND m.source_id = g.id::text
      WHERE g.organization_id = ${organizationId}::uuid AND g.status NOT IN ('POSTED', 'REVERSED')
      GROUP BY 1, 2, 3`,
    q<{ grn_id: string; number: string; line_id: string }>`
      SELECT g.id::text AS grn_id, g.number, gl.id::text AS line_id
      FROM grns g JOIN grn_lines gl ON gl.grn_id = g.id
      WHERE g.organization_id = ${organizationId}::uuid AND g.status = 'POSTED' AND gl.accepted_qty > 0
        AND NOT EXISTS (SELECT 1 FROM stock_transactions m WHERE m.source_type = 'grn' AND m.source_id = g.id::text AND m.item_brand_id = gl.item_brand_id AND m.direction = 'IN')`,
    q<{ po_line_id: string; po_number: string; accepted: string; posted: string }>`
      SELECT pl.id::text AS po_line_id, po.number AS po_number, pl.accepted_qty::text AS accepted, COALESCE(SUM(gl.accepted_qty) FILTER (WHERE g.status = 'POSTED'), 0)::text AS posted
      FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      LEFT JOIN grn_lines gl ON gl.po_line_id = pl.id LEFT JOIN grns g ON g.id = gl.grn_id
      WHERE po.organization_id = ${organizationId}::uuid
      GROUP BY pl.id, po.number HAVING pl.accepted_qty <> COALESCE(SUM(gl.accepted_qty) FILTER (WHERE g.status = 'POSTED'), 0)`,
    q<{ id: string; code: string }>`
      SELECT id::text, code FROM stock_transactions WHERE organization_id = ${organizationId}::uuid AND source_type IN ('supplier_bill', 'bill')`,
    q<{ txn_id: string; code: string; grn_number: string; qty: string }>`
      SELECT m.id::text AS txn_id, m.code, g.number AS grn_number, m.quantity::text AS qty
      FROM stock_transactions m
      JOIN stock_transactions r ON r.source_type = 'grn' AND r.type = 'RECEIPT' AND r.item_brand_id = m.item_brand_id AND r.location_id = m.location_id
        AND r.quantity = m.quantity AND ABS(m.txn_date - r.txn_date) <= 7
      JOIN grns g ON g.id::text = r.source_id AND g.status = 'POSTED'
      WHERE m.organization_id = ${organizationId}::uuid AND m.type = 'INWARD' AND m.source_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM stock_transactions x WHERE x.reversal_of_id = m.id)`,
  ]);
  const issues: IntegrityIssue[] = [
    ...ledger.map((r) => ({ code: "ledger_vs_balance", severity: "error" as const, detail: `Balance ${r.balance} but ledger sums to ${r.ledger}`, ref: { itemBrandId: r.item_brand_id, locationId: r.location_id } })),
    ...totals.map((r) => ({ code: "balance_vs_total", severity: "error" as const, detail: `Item–brand total ${r.current} but location balances sum to ${r.balances}`, ref: { itemBrandId: r.item_brand_id } })),
    ...dupes.map((r) => ({ code: "grn_duplicate", severity: "error" as const, detail: `Receipt line posted ${r.n} live receipt movements`, ref: { grnId: r.grn_id, lineId: r.idempotency_key } })),
    ...orphans.map((r) => ({ code: "grn_orphan", severity: "error" as const, detail: `${r.n} stock movement(s) from receipt ${r.number} which is ${r.status}`, ref: { grnId: r.grn_id } })),
    ...missing.map((r) => ({ code: "grn_missing", severity: "error" as const, detail: `Posted receipt ${r.number} has an accepted line without a stock movement`, ref: { grnId: r.grn_id, lineId: r.line_id } })),
    ...poAccepted.map((r) => ({ code: "po_accepted", severity: "error" as const, detail: `PO ${r.po_number}: line accepted ${r.accepted} but posted receipts total ${r.posted}`, ref: { poLineId: r.po_line_id } })),
    ...billMoves.map((r) => ({ code: "bill_stock", severity: "error" as const, detail: `Stock movement ${r.code} was posted from a supplier bill`, ref: { txnId: r.id } })),
    ...manual.map((r) => ({ code: "manual_after_grn", severity: "warning" as const, detail: `Manual inward ${r.code} (${r.qty}) matches receipt ${r.grn_number} — check it is not the same delivery twice`, ref: { txnId: r.txn_id } })),
  ];
  return { organizationId, errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length, issues };
}
