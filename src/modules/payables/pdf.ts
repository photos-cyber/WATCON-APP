import "server-only";
import type { PdfDoc } from "@/components/documents/pdf/types";
import { formatDate } from "@/lib/format";
import { addMoney, amountInWords } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { docState, humanize, isZero, loadPdfOrg, partyPanel, pct, projectLabel, qty, rate, rs, signDate, taxByRate } from "@/modules/documents/pdf-kit";
import { loadParty } from "@/modules/documents/pdf-models";
import { getBill } from "./bills";
import { getNote } from "./notes";
import { PAYMENT_MODE_LABELS, getPayment } from "./payments";

// ───────────── Supplier bill (purchase bill voucher) ─────────────
export async function supplierBillPdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { bill: b, outstanding } = await getBill(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, b.partyId)]);
  const intra = b.taxMode === "INTRA";
  return {
    docType: "SB",
    title: "Purchase Bill Voucher",
    number: b.number,
    date: formatDate(b.invoiceDate),
    dateLabel: "Invoice date",
    ...docState(b.status),
    org,
    panels: [
      partyPanel("Supplier", party ?? b.party),
      {
        title: "Bill reference",
        heading: `Supplier invoice ${b.supplierInvoiceNo}`,
        fields: [
          { label: "Project", value: projectLabel(b.project) },
          { label: "Purchase order", value: b.po?.number ?? "Without PO" },
          { label: "PO matching", value: b.matchStatus === "MATCHED" ? "Matched with PO / receipts" : b.matchStatus === "EXCEPTION" ? `Exceptions${b.overrideReason ? ` – overridden: ${b.overrideReason}` : ""}` : "Not matched (no PO)" },
        ],
      },
    ],
    facts: [
      { label: "Due date", value: formatDate(b.dueDate), strong: true },
      { label: "TDS", value: b.tdsSection ? `${b.tdsSection} @ ${pct(b.tdsRate ?? "0")}` : null },
      { label: "Net payable", value: rs(b.netPayable), strong: true },
      { label: "Outstanding", value: rs(outstanding) },
    ],
    tableTitle: "Bill lines",
    columns: [
      { key: "n", label: "S.No", width: 4.5, align: "center" },
      { key: "item", label: "Description", width: 38 },
      { key: "hsn", label: "HSN", width: 9 },
      { key: "qty", label: "Qty", width: 8, align: "right" },
      { key: "unit", label: "Unit", width: 6 },
      { key: "rate", label: "Rate (₹)", width: 11, align: "right" },
      { key: "gst", label: "GST", width: 6, align: "right" },
      { key: "amt", label: "Amount (₹)", width: 13, align: "right" },
    ],
    rows: b.lines.map((l) => ({ n: String(l.lineNo), item: { text: l.description, sub: l.grnLine ? `Receipt ${l.grnLine.grn.number}` : null }, hsn: l.hsnCode ?? "", qty: qty(l.quantity), unit: l.unit ?? "", rate: rate(l.rate), gst: pct(l.gstRate), amt: rate(l.taxable) })),
    totals: [
      { label: "Taxable value", value: rs(b.taxable) },
      ...(isZero(b.charges) ? [] : [{ label: "Freight / charges", value: rs(b.charges) }]),
      ...(intra ? [{ label: "CGST", value: rs(b.cgst) }, { label: "SGST", value: rs(b.sgst) }] : [{ label: "IGST", value: rs(b.igst) }]),
      ...(isZero(b.roundOff) ? [] : [{ label: "Round off", value: rs(b.roundOff) }]),
      { label: "Invoice total", value: rs(b.total), kind: "grand" as const },
      ...(isZero(b.tdsAmount) ? [] : [{ label: "Less TDS", value: `- ${rs(b.tdsAmount)}`, kind: "deduction" as const }]),
      { label: "Net payable", value: rs(b.netPayable), kind: "net" as const },
      { label: "Paid / adjusted to date", value: rs(addMoney(b.paidAmount, b.adjustedAmount)), kind: "info" as const },
      { label: "Outstanding", value: rs(outstanding), kind: "info" as const },
    ],
    amountInWords: amountInWords(b.netPayable),
    taxSummary: taxByRate(b.lines),
    sections: b.remarks ? [{ title: "Remarks", body: b.remarks }] : [],
    signatures: [
      { label: "Entered by", name: b.createdBy.fullName, date: signDate(b.createdAt) },
      { label: "Submitted by", name: b.submittedBy?.fullName ?? null, date: signDate(b.submittedAt) },
      { label: "Approved for payment", name: b.approvedBy?.fullName ?? null, date: signDate(b.approvedAt), note: b.approvedBy ? "Approved in ERP" : null, company: true },
    ],
  };
}

// ───────────── Payment / receipt voucher ─────────────
export async function paymentPdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { payment: p, unallocated } = await getPayment(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, p.partyId)]);
  const out = p.direction === "OUT";
  const active = p.allocations.filter((a) => !a.reversedAt);
  return {
    docType: out ? "PV" : "RV",
    title: out ? "Payment Voucher" : "Receipt Voucher",
    number: p.number,
    date: formatDate(p.paymentDate),
    dateLabel: out ? "Paid on" : "Received on",
    ...docState(p.status, { label: p.status === "POSTED" ? "Posted" : undefined }),
    org,
    panels: [
      party ? partyPanel(out ? "Paid to (payee)" : "Received from (payer)", party) : { title: out ? "Paid to" : "Received from", heading: p.party.name },
      {
        title: "Transaction",
        heading: rs(p.amount),
        fields: [
          { label: "Method", value: PAYMENT_MODE_LABELS[p.mode], strong: true },
          { label: "Reference", value: p.reference },
          { label: "Bank account", value: p.bankAccount },
          { label: "Project", value: projectLabel(p.project) },
        ],
      },
    ],
    tableTitle: out ? "Allocated against supplier bills" : "Allocated against invoices",
    emptyText: "Not yet allocated — held as an advance.",
    columns: [
      { key: "n", label: "S.No", width: 6, align: "center" },
      { key: "doc", label: out ? "Bill" : "Invoice", width: 64 },
      { key: "amt", label: "Amount (₹)", width: 30, align: "right" },
    ],
    rows: active.map((a, i) => ({ n: String(i + 1), doc: a.supplierBill ? { text: a.supplierBill.number, sub: `Supplier invoice ${a.supplierBill.supplierInvoiceNo}` } : (a.clientInvoice?.number ?? ""), amt: rate(a.amount) })),
    totals: [
      { label: out ? "Amount paid" : "Amount received", value: rs(p.amount) },
      ...(isZero(p.tdsAmount) ? [] : [{ label: "TDS deducted by client", value: rs(p.tdsAmount) }]),
      { label: "Total settled", value: rs(p.gross), kind: "grand" as const },
      ...(isZero(unallocated) ? [] : [{ label: "Unallocated (advance)", value: rs(unallocated), kind: "info" as const }]),
    ],
    amountInWords: amountInWords(p.amount),
    sections: p.remarks ? [{ title: "Remarks", body: p.remarks }] : [],
    signatures: out
      ? [
          { label: "Prepared by", name: p.createdBy.fullName, date: signDate(p.createdAt) },
          { label: "Authorised by", company: true },
          { label: "Receiver's signature", note: "Name, sign & date" },
        ]
      : [
          { label: "Prepared by", name: p.createdBy.fullName, date: signDate(p.createdAt) },
          { label: "Authorised by", company: true },
        ],
  };
}

// ───────────── Debit / credit note ─────────────
export async function notePdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { note: n } = await getNote(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, n.partyId)]);
  const credit = n.noteType === "CREDIT";
  return {
    docType: credit ? "CN" : "DN",
    title: credit ? "Credit Note" : "Debit Note",
    number: n.number,
    date: formatDate(n.noteDate),
    ...docState(n.status),
    org,
    panels: [
      party ? partyPanel(n.partyRole === "SUPPLIER" ? "Supplier" : "Client", party) : { title: humanize(n.partyRole), heading: n.party.name },
      {
        title: "Reference",
        heading: n.supplierBill ? `Bill ${n.supplierBill.number}` : n.clientInvoice ? `Invoice ${n.clientInvoice.number}` : "—",
        fields: [
          { label: "Supplier invoice", value: n.supplierBill?.supplierInvoiceNo },
          { label: "Project", value: projectLabel(n.project) },
          { label: "Party reference", value: n.partyNoteRef },
        ],
      },
    ],
    tableTitle: "Particulars",
    columns: [
      { key: "d", label: "Reason", width: 62 },
      { key: "gst", label: "GST", width: 10, align: "right" },
      { key: "amt", label: "Taxable (₹)", width: 28, align: "right" },
    ],
    rows: [{ d: n.reason, gst: pct(n.gstRate), amt: rate(n.taxable) }],
    totals: [
      { label: "Taxable value", value: rs(n.taxable) },
      { label: n.taxMode === "INTRA" ? "CGST + SGST" : "IGST", value: rs(n.taxAmount) },
      { label: credit ? "Credit amount" : "Debit amount", value: rs(n.total), kind: "grand" as const },
    ],
    amountInWords: amountInWords(n.total),
    signatures: [
      { label: "Prepared by", name: n.createdBy.fullName, date: signDate(n.createdAt) },
      { label: "Approved by", name: n.approvedBy?.fullName ?? null, date: signDate(n.approvedAt), note: n.approvedBy ? "Approved in ERP" : null, company: true },
    ],
  };
}
