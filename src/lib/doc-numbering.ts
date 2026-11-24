import type { Tx } from "@/lib/db";

/**
 * Commercial document numbering: PREFIX/FY/0001 (e.g. "PO/2026-27/0001").
 *
 * Defaults below apply when the organisation has no `document_series` row for a type;
 * admins can override prefix, width and yearly reset in Settings → Commercial.
 * Counters are allocated with one atomic UPSERT … RETURNING inside the creating
 * transaction, so concurrent creators never get the same number and a rolled-back
 * transaction does not leave a duplicate.
 */

export const DOC_TYPES = {
  PR: { label: "Purchase requisition", prefix: "PR" },
  RFQ: { label: "Rate enquiry", prefix: "RFQ" },
  SQ: { label: "Supplier quotation", prefix: "SQ" },
  PO: { label: "Purchase order", prefix: "PO" },
  GRN: { label: "Goods receipt note", prefix: "GRN" },
  DC: { label: "Delivery challan", prefix: "DC" },
  SB: { label: "Supplier bill", prefix: "SB" },
  PAY: { label: "Supplier payment", prefix: "PAY" },
  RCPT: { label: "Client receipt", prefix: "RCPT" },
  QT: { label: "Client quotation", prefix: "QT" },
  PI: { label: "Proforma / advance request", prefix: "PI" },
  CPO: { label: "Client purchase order", prefix: "CPO" },
  SO: { label: "Sales order", prefix: "SO" },
  RAB: { label: "Running account bill", prefix: "RAB" },
  INV: { label: "Tax invoice", prefix: "INV" },
  CN: { label: "Credit note", prefix: "CN" },
  DN: { label: "Debit note", prefix: "DN" },
  SC: { label: "Stock count", prefix: "SC" },
} as const;

export type DocType = keyof typeof DOC_TYPES;
export const DOC_TYPE_KEYS = Object.keys(DOC_TYPES) as DocType[];

/** Indian financial year (April–March) of a calendar date: 2026-11-20 → "2026-27". */
export function fiscalYearOf(date: Date, startMonth = 4): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const start = m >= startMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function formatDocNumber(prefix: string, fiscalYear: string | null, value: number, width: number): string {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid document sequence value: ${value}`);
  const n = String(value).padStart(width, "0");
  return fiscalYear ? `${prefix}/${fiscalYear}/${n}` : `${prefix}/${n}`;
}

/** Allocates the next number for `docType`, using the document date's financial year. */
export async function nextDocNumber(tx: Tx, organizationId: string, docType: DocType, docDate: Date): Promise<string> {
  const series = await tx.documentSeries.findUnique({ where: { organizationId_docType: { organizationId, docType } } });
  const prefix = series?.prefix ?? DOC_TYPES[docType].prefix;
  const width = series?.width ?? 4;
  const yearly = series?.includeFiscalYear ?? true;
  const fy = yearly ? fiscalYearOf(docDate) : "ALL";
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO document_counters (organization_id, doc_type, fiscal_year, value)
    VALUES (${organizationId}::uuid, ${docType}, ${fy}, 1)
    ON CONFLICT (organization_id, doc_type, fiscal_year)
    DO UPDATE SET value = document_counters.value + 1
    RETURNING value`;
  const value = rows[0]?.value;
  if (typeof value !== "number") throw new Error("Failed to allocate document number");
  return formatDocNumber(prefix, yearly ? fy : null, value, width);
}
