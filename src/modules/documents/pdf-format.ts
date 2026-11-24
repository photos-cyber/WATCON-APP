import type { PdfDoc, PdfOrg, PdfPanel, PdfTaxRow, PdfTone } from "@/components/documents/pdf/types";
import { formatDate } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { addMoney, formatINR } from "@/lib/money";

/** Pure formatting helpers for PDF builders (no database access — also used by the PDF layout tests). */

// ─────────────────────────── Formatting ───────────────────────────

/** ₹ with Indian digit grouping, e.g. ₹1,05,817.68 (negative: -₹500.00). */
export const rs = (v: string | null | undefined) => formatINR(v);
/** Rate without the symbol (table columns are already labelled ₹). */
export const rate = (v: string | null | undefined) => formatINR(v, { symbol: false });
/** Quantity / percent without trailing zeros: "12.500" → "12.5". */
export const qty = (v: string | null | undefined) => (v == null ? "—" : v.includes(".") ? v.replace(/\.?0+$/, "") : v);
export const pct = (v: string | null | undefined) => (v == null ? "—" : `${qty(v)}%`);
export const isZero = (v: string | null | undefined) => !v || /^-?0+(\.0+)?$/.test(v);
export const humanize = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const signDate = (d: Date | string | null | undefined) => (d ? formatDate(d) : null);
export const projectLabel = (p: { code: string; name: string } | null | undefined) => (p ? `${p.code} – ${p.name}` : null);

type PartyLike = { name: string; legalName?: string | null; address?: string | null; city?: string | null; pincode?: string | null; gstin?: string | null; stateCode?: string | null; phone?: string | null; email?: string | null; contactPerson?: string | null; pan?: string | null };

/** Party card: legal name, address, GSTIN / state, contact. Missing fields are skipped. */
export function partyPanel(title: string, p: PartyLike, extra: PdfPanel["fields"] = []): PdfPanel {
  const cityLine = [p.city, p.pincode].filter(Boolean).join(" – ");
  return {
    title,
    heading: p.legalName || p.name,
    lines: [p.address, cityLine || null],
    fields: [
      { label: "GSTIN", value: [p.gstin ?? "Unregistered", p.stateCode ? `${stateName(p.stateCode)} (${p.stateCode})` : null].filter(Boolean).join("  ·  "), strong: !!p.gstin },
      { label: "Contact", value: [p.contactPerson, p.phone].filter(Boolean).join("  ·  ") || null },
      { label: "Email", value: p.email },
      ...extra,
    ],
  };
}

// ─────────────────────────── Status ───────────────────────────

const PENDING_DEFAULT = ["PENDING_APPROVAL", "INTERNAL_REVIEW", "AWARD_PENDING"];
const DONE = ["CLOSED", "FULLY_RECEIVED", "FULFILLED", "PAID", "COMPLETED", "ORDERED", "DELIVERED", "RECEIVED", "INVOICED"];

/**
 * Status badge, watermark and "final" flag (final = approved / issued; gates the signature
 * image). Drafts print DRAFT, unapproved documents PENDING APPROVAL, cancelled CANCELLED.
 */
export function docState(status: string, opts: { pending?: string[]; label?: string; pendingMark?: string } = {}): Pick<PdfDoc, "status" | "watermark" | "final"> {
  const pending = opts.pending ?? PENDING_DEFAULT;
  const label = opts.label ?? humanize(status);
  let tone: PdfTone = "approved";
  let watermark: string | null = null;
  if (status === "DRAFT") [tone, watermark] = ["draft", "DRAFT"];
  else if (pending.includes(status)) [tone, watermark] = ["pending", opts.pendingMark ?? "PENDING APPROVAL"];
  else if (status === "REJECTED") [tone, watermark] = ["cancelled", "REJECTED"];
  else if (status === "CANCELLED") [tone, watermark] = ["cancelled", "CANCELLED"];
  else if (status === "REVERSED") [tone, watermark] = ["cancelled", "REVERSED"];
  else if (status === "DISPUTED") tone = "pending";
  else if (DONE.includes(status)) tone = "done";
  return { status: { label, tone }, watermark, final: watermark === null && status !== "DISPUTED" };
}

// ─────────────────────────── Tax ───────────────────────────

/** GST grouped by rate from the saved line values (no recalculation of the line maths). */
export function taxByRate(lines: { gstRate: string; taxable: string; taxAmount: string }[]): PdfTaxRow[] {
  const map = new Map<string, { taxable: string; tax: string }>();
  for (const l of lines) {
    const key = qty(l.gstRate);
    const cur = map.get(key) ?? { taxable: "0", tax: "0" };
    map.set(key, { taxable: addMoney(cur.taxable, l.taxable), tax: addMoney(cur.tax, l.taxAmount) });
  }
  return [...map.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([r, v]) => ({ rate: `${r}%`, taxable: rs(v.taxable), tax: rs(v.tax) }));
}

/** Splits saved terms text into numbered clauses when it is written one clause per line. */
export function termsSection(title: string, text: string | null | undefined) {
  if (!text?.trim()) return null;
  const items = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(\d+[.)]|[-•*])\s*/, "").trim())
    .filter(Boolean);
  return items.length > 1 ? { title, items } : { title, body: text.trim() };
}

// ─────────────────────────── File name ───────────────────────────

/** WATCON_PO_2026-27_0001[_Rev2].pdf — company + actual document number. */
export function pdfFileName(org: PdfOrg, doc: Pick<PdfDoc, "number" | "revision">) {
  const company = (org.name.split(/\s+/)[0] ?? "DOC").toUpperCase().replace(/[^A-Z0-9]/g, "") || "DOC";
  const num = doc.number.replace(/[\\/\s]+/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
  return `${company}_${num}${doc.revision ? `_Rev${doc.revision}` : ""}.pdf`;
}
