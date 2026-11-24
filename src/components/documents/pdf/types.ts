/**
 * Print model for every WATCON PDF. Builders (src/modules/** /pdf*.ts) fill it from the
 * module's own authorised getters; templates only lay it out — they never recalculate money.
 */

export type PdfTone = "draft" | "pending" | "approved" | "done" | "cancelled" | "neutral";

export type PdfOrg = {
  name: string;
  legalName: string | null;
  address: string | null;
  officeAddress: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  gstin: string | null;
  pan: string | null;
  /** e.g. "Maharashtra (27)" */
  state: string | null;
  /** PNG/JPEG data URL — the uploaded logo, or the standard WATCON logo. Null = text letterhead. */
  logoDataUrl: string | null;
  footer: string | null;
  bank: { name: string | null; accountName: string | null; accountNo: string | null; ifsc: string | null; branch: string | null } | null;
  signatory: { name: string | null; designation: string | null; signatureDataUrl: string | null; stampDataUrl: string | null };
};

export type PdfField = { label: string; value: string | null | undefined; strong?: boolean };

/** One information card (Supplier, Project & delivery, Bill to, …). Empty fields are skipped. */
export type PdfPanel = { title: string; heading?: string | null; lines?: (string | null | undefined)[]; fields?: PdfField[] };

export type PdfColumn = { key: string; label: string; /** relative width (flex weight) */ width: number; align?: "left" | "right" | "center"; nowrap?: boolean };

export type PdfCell = string | { text: string; sub?: string | null };

export type PdfTotal = { label: string; value: string; kind?: "line" | "grand" | "deduction" | "net" | "info" };

export type PdfSection = { title: string; body?: string | null; items?: string[] };

/**
 * A signature / approval block. `name` + `date` are printed only when they come from a real
 * record. `company` blocks may carry the configured signature image — and only when the
 * document is final (approved / issued).
 */
export type PdfSign = { label: string; name?: string | null; date?: string | null; note?: string | null; company?: boolean };

export type PdfTaxRow = { rate: string; taxable: string; tax: string };

export type PdfDoc = {
  /** Short type code for the file name, e.g. "PO", "INV". */
  docType: string;
  title: string;
  number: string;
  revision?: number | null;
  date: string;
  dateLabel?: string;
  status?: { label: string; tone: PdfTone } | null;
  /** Diagonal mark across every page, e.g. DRAFT / CANCELLED. */
  watermark?: string | null;
  /** True only when the document is approved / issued — gates the signature image. */
  final: boolean;
  org: PdfOrg;
  panels: PdfPanel[];
  /** Compact key facts strip under the panels. */
  facts?: PdfField[];
  tableTitle?: string;
  columns: PdfColumn[];
  rows: Record<string, PdfCell>[];
  emptyText?: string;
  totals?: PdfTotal[];
  amountInWords?: string | null;
  taxSummary?: PdfTaxRow[] | null;
  sections?: PdfSection[];
  attachments?: string[];
  signatures?: PdfSign[];
  showBank?: boolean;
  orientation?: "portrait" | "landscape";
};
