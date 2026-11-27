import "server-only";
import type { PdfColumn, PdfDoc } from "@/components/documents/pdf/types";
import { formatDate } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { amountInWords } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { docState, isZero, loadPdfOrg, partyPanel, pct, projectLabel, qty, rate, rs, signDate, taxByRate, termsSection } from "@/modules/documents/pdf-kit";
import { loadParty } from "@/modules/documents/pdf-models";
import { getClientPo } from "./client-po";
import { getClientInvoice } from "./invoice";
import { getRaBill } from "./ra-bill";
import { getSalesOrder } from "./sales-order";

const priced: PdfColumn[] = [
  { key: "n", label: "S.No", width: 4.5, align: "center" },
  { key: "item", label: "Description", width: 37 },
  { key: "hsn", label: "HSN/SAC", width: 9 },
  { key: "qty", label: "Qty", width: 8, align: "right" },
  { key: "unit", label: "Unit", width: 6 },
  { key: "rate", label: "Rate (₹)", width: 11, align: "right" },
  { key: "gst", label: "GST", width: 6, align: "right" },
  { key: "amt", label: "Amount (₹)", width: 13, align: "right" },
];

const sections = (...s: (PdfDoc["sections"] extends (infer T)[] | undefined ? T | null | false : never)[]) => s.filter(Boolean) as NonNullable<PdfDoc["sections"]>;

// ───────────── Client PO (contract) ─────────────
export async function clientPoPdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { cpo } = await getClientPo(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, cpo.partyId)]);
  return {
    docType: "CPO",
    title: "Client Purchase Order",
    number: cpo.number,
    revision: cpo.revision || null,
    date: formatDate(cpo.poDate),
    dateLabel: "PO date",
    ...docState(cpo.status),
    org,
    panels: [
      partyPanel("Client", party ?? cpo.party),
      { title: "Contract", heading: `Client PO ${cpo.clientPoNumber}`, fields: [{ label: "Project", value: projectLabel(cpo.project), strong: true }, { label: "Period", value: `${formatDate(cpo.startDate)} – ${formatDate(cpo.endDate)}` }] },
    ],
    facts: [
      { label: "Contract value", value: rs(cpo.total), strong: true },
      { label: "Retention", value: pct(cpo.retentionPct) },
      { label: "Advance", value: isZero(cpo.advanceAmount) ? null : `${rs(cpo.advanceAmount)} (recovery ${pct(cpo.advanceRecoveryPct)})` },
      { label: "Payment terms", value: cpo.paymentTerms },
    ],
    tableTitle: "Scope / bill of quantities",
    columns: priced,
    rows: cpo.lines.map((l) => ({ n: String(l.lineNo), item: { text: l.description, sub: l.boqRef ? `BOQ ${l.boqRef}` : null }, hsn: l.hsnSac ?? "", qty: qty(l.quantity), unit: l.unit, rate: rate(l.rate), gst: pct(l.gstRate), amt: rate(l.taxable) })),
    totals: [{ label: "Taxable value", value: rs(cpo.taxable) }, { label: "GST", value: rs(cpo.taxAmount) }, { label: "Contract value", value: rs(cpo.total), kind: "grand" }],
    amountInWords: amountInWords(cpo.total),
    taxSummary: taxByRate(cpo.lines),
    sections: sections(cpo.scope ? { title: "Scope of work", body: cpo.scope } : null, termsSection("Notes", cpo.notes)),
    signatures: [
      { label: "Prepared by", name: cpo.createdBy.fullName, date: signDate(cpo.createdAt) },
      { label: "Approved by", name: cpo.approvedBy?.fullName ?? null, date: signDate(cpo.approvedAt), note: cpo.approvedBy ? "Approved in ERP" : null, company: true },
    ],
  };
}

// ───────────── Sales order ─────────────
export async function salesOrderPdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { so } = await getSalesOrder(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, so.partyId)]);
  return {
    docType: "SO",
    title: "Sales Order",
    number: so.number,
    revision: so.revision || null,
    date: formatDate(so.orderDate),
    dateLabel: "Order date",
    ...docState(so.status),
    org,
    panels: [
      partyPanel("Client", party ?? so.party),
      { title: "Project & delivery", heading: projectLabel(so.project), fields: [{ label: "Deliver to", value: so.deliveryAddress ?? so.project.siteAddress }, { label: "Client PO", value: so.clientPo ? `${so.clientPo.clientPoNumber} (${so.clientPo.number})` : null }] },
    ],
    facts: [
      { label: "Delivery by", value: formatDate(so.deliveryDate), strong: true },
      { label: "Payment terms", value: so.paymentTerms },
      { label: "Order value", value: rs(so.total) },
    ],
    tableTitle: "Order items",
    columns: priced,
    rows: so.lines.map((l) => ({ n: String(l.lineNo), item: l.description, hsn: l.hsnSac ?? "", qty: qty(l.quantity), unit: l.unit, rate: rate(l.rate), gst: pct(l.gstRate), amt: rate(l.taxable) })),
    totals: [{ label: "Taxable value", value: rs(so.taxable) }, { label: "GST", value: rs(so.taxAmount) }, { label: "Order total", value: rs(so.total), kind: "grand" }],
    amountInWords: amountInWords(so.total),
    taxSummary: taxByRate(so.lines),
    sections: sections(termsSection("Delivery schedule", so.deliverySchedule), termsSection("Billing schedule", so.billingSchedule), termsSection("Notes", so.notes)),
    signatures: [
      { label: "Prepared by", name: so.createdBy.fullName, date: signDate(so.createdAt) },
      { label: "Approved by", name: so.approvedBy?.fullName ?? null, date: signDate(so.approvedAt), note: so.approvedBy ? "Approved in ERP" : null, company: true },
      { label: "Client acceptance", note: "Sign & stamp" },
    ],
  };
}

// ───────────── Running account bill ─────────────
export async function raBillPdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { bill } = await getRaBill(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, bill.partyId)]);
  const so = bill.basis === "SO";
  const st = bill.statement;
  const deductions = [
    { label: `Less retention (${pct(bill.retentionPct)})`, v: bill.retentionAmount },
    { label: "Less advance recovery", v: bill.advanceRecovery },
    { label: "Less other deductions", v: bill.otherDeductions },
  ].filter((d) => !isZero(d.v));
  const contractRef = bill.clientPo ? `Client PO ${bill.clientPo.clientPoNumber} (${bill.clientPo.number})` : bill.salesOrder ? `Sales order ${bill.salesOrder.number}` : null;
  return {
    docType: "RAB",
    title: so ? `Running Bill${bill.isFinal ? " (Final)" : ""}` : "Running Account Bill",
    number: bill.number,
    date: formatDate(bill.billDate),
    dateLabel: "Bill date",
    ...docState(bill.status),
    org,
    orientation: "landscape",
    panels: [
      partyPanel("Client", party ?? bill.party),
      {
        title: "Contract",
        heading: `Running bill no. ${bill.raNumber}${bill.isFinal ? " — final bill" : ""}`,
        fields: [
          { label: "Project", value: projectLabel(bill.project), strong: true },
          { label: so ? "Sales order" : "Client PO", value: contractRef },
          // Client PO is optional on a sales-order bill: printed only as a reference when one is linked.
          ...(so && bill.salesOrder?.clientPo ? [{ label: "Client PO (ref.)", value: `${bill.salesOrder.clientPo.clientPoNumber} (${bill.salesOrder.clientPo.number})` }] : []),
          { label: "Period", value: `${formatDate(bill.periodFrom)} – ${formatDate(bill.periodTo)}` },
          { label: "Client certificate", value: bill.clientCertRef ? `${bill.clientCertRef} · ${formatDate(bill.clientCertDate)}` : null },
        ],
      },
    ],
    // Cumulative statement (sales-order bills): previous + this bill = cumulative; what is owed in total.
    facts: so
      ? [
          { label: "Previous material value", value: rs(st.previousValue) },
          { label: "New material value", value: rs(st.currentValue) },
          { label: "Cumulative value", value: rs(st.cumulativeValue), strong: true },
          { label: "Previously billed", value: rs(st.previousBilled) },
          { label: "Received to date", value: rs(st.receivedToDate) },
          { label: "Previous outstanding", value: rs(st.previousOutstanding) },
        ]
      : undefined,
    tableTitle: so ? "Material, services & installation (previous / this bill / cumulative)" : "Measurement & billing (quantities)",
    columns: [
      { key: "n", label: "S.No", width: 4, align: "center" },
      { key: "item", label: so ? "Item" : "Contract item", width: 28 },
      { key: "unit", label: "Unit", width: 5 },
      { key: "contract", label: so ? "Order qty" : "Contract qty", width: 7.5, align: "right" },
      ...(so ? [{ key: "deliv", label: "Delivered", width: 7.5, align: "right" as const }] : []),
      { key: "prev", label: "Previous", width: 7.5, align: "right" },
      { key: "claim", label: "This bill", width: 7.5, align: "right" },
      { key: "cum", label: "Cumulative", width: 8, align: "right" },
      { key: "cert", label: "Certified", width: 7.5, align: "right" },
      { key: "rate", label: "Rate (₹)", width: 8.5, align: "right" },
      { key: "amt", label: "This bill (₹)", width: 10, align: "right" },
    ],
    rows: bill.lines.map((l) => ({
      n: String(l.ref.lineNo),
      item: { text: l.ref.description, sub: [l.ref.kind === "SERVICE" ? "Service" : l.ref.kind === "INSTALLATION" ? "Installation" : null, l.measurementRef ? `MB ref: ${l.measurementRef}` : null, `GST ${pct(l.gstRate)}`].filter(Boolean).join(" · ") },
      unit: l.ref.unit,
      contract: qty(l.contractQty),
      deliv: l.ref.kind === "MATERIAL" ? qty(l.deliveredQty) : "—",
      prev: qty(l.prevCertifiedQty),
      claim: qty(l.claimedQty),
      cum: qty(l.cumulativeQty),
      cert: l.certifiedQty ? qty(l.certifiedQty) : "—",
      rate: rate(l.rate),
      amt: rate(l.certifiedAmount ?? l.claimedAmount),
    })),
    totals: [
      { label: bill.certified ? "Certified value (this bill)" : "Value (this bill)", value: rs(bill.gross) },
      { label: "GST", value: rs(bill.gstAmount) },
      ...deductions.map((d) => ({ label: d.label, value: `- ${rs(d.v)}`, kind: "deduction" as const })),
      { label: so ? "Current new billing (net)" : "Net payable", value: rs(bill.netPayable), kind: "net" },
      ...(so && !isZero(st.previousOutstanding)
        ? [
            { label: "Add: previous outstanding", value: rs(st.previousOutstanding), kind: "info" as const },
            { label: "Total payable", value: rs(st.totalPayable), kind: "grand" as const },
          ]
        : []),
    ],
    amountInWords: amountInWords(so ? st.totalPayable : bill.netPayable),
    sections: sections(
      so && bill.previousBills.length > 0
        ? { title: "Previous running bills (status today)", items: bill.previousBills.map((p) => `RA-${p.raNumber} ${p.number} (${formatDate(p.billDate)}): billed ${rs(p.netPayable)}${p.invoice ? `, invoice ${p.invoice}` : ", not yet invoiced"}, received ${rs(p.received)}, outstanding ${rs(p.outstanding)}`) }
        : null,
      so ? { title: "How this bill is calculated", body: "Only material delivered to site / the client and services not billed before, at sales-order rates. Previous outstanding is shown for information only and is not billed again." } : null,
      bill.deductionNotes ? { title: "Deductions", body: bill.deductionNotes } : null,
      bill.remarks ? { title: "Remarks", body: bill.remarks } : null,
    ),
    signatures: [
      { label: "Prepared by", name: bill.createdBy.fullName, date: signDate(bill.createdAt) },
      { label: "Reviewed", name: bill.engineerCertifiedBy?.fullName ?? null, date: signDate(bill.engineerCertifiedAt), company: true },
      { label: "Client certification", name: bill.certifiedBy?.fullName ?? null, date: signDate(bill.clientCertDate), note: bill.clientCertRef ? `Certificate ${bill.clientCertRef}` : "Name, sign & stamp" },
    ],
  };
}

// ───────────── Tax invoice ─────────────
export async function clientInvoicePdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { invoice: inv } = await getClientInvoice(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, inv.partyId)]);
  const intra = inv.taxMode === "INTRA";
  const deductions = [
    { label: "Less retention", v: inv.retentionAmount },
    { label: "Less advance recovery", v: inv.advanceRecovery },
    { label: "Less other deductions", v: inv.otherDeductions },
  ].filter((d) => !isZero(d.v));
  return {
    docType: inv.kind === "PROFORMA" ? "PI" : "INV",
    title: inv.kind === "PROFORMA" ? "Proforma Invoice" : "Tax Invoice",
    number: inv.number,
    date: formatDate(inv.invoiceDate),
    dateLabel: "Invoice date",
    ...docState(inv.status, { label: inv.kind === "PROFORMA" ? "Advance request – not a tax invoice" : inv.status === "DRAFT" ? "Draft – not a valid tax invoice" : undefined }),
    org,
    showBank: inv.status !== "DRAFT" && inv.status !== "CANCELLED",
    panels: [
      partyPanel("Bill to", party ?? inv.party),
      {
        title: "Supply details",
        heading: projectLabel(inv.project),
        fields: [
          { label: "Place of supply", value: inv.placeOfSupply ? `${stateName(inv.placeOfSupply)} (${inv.placeOfSupply})` : null, strong: true },
          { label: "Client PO", value: inv.clientPo ? `${inv.clientPo.clientPoNumber} dt ${formatDate(inv.clientPo.poDate)}` : null },
          { label: "Running bill", value: inv.raBill ? `RA-${inv.raBill.raNumber} (${formatDate(inv.raBill.periodFrom)} – ${formatDate(inv.raBill.periodTo)})${inv.raBill.clientCertRef ? `, cert ${inv.raBill.clientCertRef}` : ""}` : null },
          { label: "Sales order", value: inv.so?.number },
        ],
      },
    ],
    facts: [
      { label: "Due date", value: formatDate(inv.dueDate), strong: true },
      { label: "Tax type", value: intra ? "CGST + SGST" : "IGST" },
      { label: deductions.length ? "Net receivable" : "Invoice total", value: rs(deductions.length ? inv.netReceivable : inv.total), strong: true },
    ],
    tableTitle: "Particulars",
    columns: priced,
    rows: inv.lines.map((l) => ({ n: String(l.lineNo), item: l.description, hsn: l.hsnSac ?? "", qty: qty(l.quantity), unit: l.unit ?? "", rate: rate(l.rate), gst: pct(l.gstRate), amt: rate(l.taxable) })),
    totals: [
      { label: "Taxable value", value: rs(inv.taxable) },
      ...(intra ? [{ label: "CGST", value: rs(inv.cgst) }, { label: "SGST", value: rs(inv.sgst) }] : [{ label: "IGST", value: rs(inv.igst) }]),
      ...(isZero(inv.roundOff) ? [] : [{ label: "Round off", value: rs(inv.roundOff) }]),
      { label: "Invoice total", value: rs(inv.total), kind: "grand" as const },
      ...deductions.map((d) => ({ label: d.label, value: `- ${rs(d.v)}`, kind: "deduction" as const })),
      ...(deductions.length ? [{ label: "Net receivable", value: rs(inv.netReceivable), kind: "net" as const }] : []),
    ],
    amountInWords: amountInWords(inv.total),
    taxSummary: taxByRate(inv.lines),
    sections: sections(termsSection("Notes", inv.notes)),
    signatures: [
      { label: "Prepared by", name: inv.createdBy.fullName, date: signDate(inv.createdAt) },
      { label: "Authorised signatory", name: inv.issuedBy?.fullName ?? null, date: signDate(inv.issuedAt), company: true },
    ],
  };
}

// ───────────── Client quotation ─────────────
export async function quotationPdf(actor: Actor, id: string): Promise<PdfDoc> {
  const { getQuotation } = await import("./quotation");
  const { q, displayStatus } = await getQuotation(actor, id);
  const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, q.partyId)]);
  const intra = q.taxMode === "INTRA";
  const { TRIGGERS } = await import("@/modules/commercial/payment-terms");
  const trig = (t: string) => (TRIGGERS as Record<string, string>)[t] ?? t;
  const st = docState(q.status, { label: displayStatus === "VIEWED" ? "Viewed" : displayStatus === "EXPIRED" ? "Expired" : undefined });
  return {
    docType: "QT",
    title: "Quotation",
    number: q.number,
    revision: q.revision || null,
    date: formatDate(q.quoteDate),
    dateLabel: "Date",
    ...st,
    // A quotation is an offer: approved / sent / accepted versions are final; drafts are marked.
    watermark: displayStatus === "EXPIRED" ? "EXPIRED" : st.watermark,
    final: ["APPROVED", "SENT", "ACCEPTED", "CONVERTED"].includes(q.status) && displayStatus !== "EXPIRED",
    org,
    panels: [
      partyPanel("Quotation to", party ?? q.party),
      { title: "Project", heading: projectLabel(q.project), lines: [q.project.siteAddress], fields: [{ label: "Subject", value: q.subject, strong: true }] },
    ],
    facts: [
      { label: "Valid until", value: formatDate(q.validUntil), strong: true },
      { label: "Tax", value: intra ? "CGST + SGST" : "IGST" },
      { label: "Place of supply", value: q.placeOfSupply ? `${stateName(q.placeOfSupply)} (${q.placeOfSupply})` : null },
      { label: "Quotation value", value: rs(q.total), strong: true },
    ],
    tableTitle: "Items & services",
    columns: [
      { key: "n", label: "S.No", width: 4.5, align: "center" },
      { key: "item", label: "Description", width: 34 },
      { key: "hsn", label: "HSN/SAC", width: 9 },
      { key: "qty", label: "Qty", width: 7.5, align: "right" },
      { key: "unit", label: "Unit", width: 6 },
      { key: "rate", label: "Rate (₹)", width: 10.5, align: "right" },
      { key: "disc", label: "Disc", width: 5.5, align: "right" },
      { key: "gst", label: "GST", width: 5.5, align: "right" },
      { key: "amt", label: "Amount (₹)", width: 12.5, align: "right" },
    ],
    rows: q.lines.map((l) => ({ n: String(l.lineNo), item: { text: l.description, sub: l.brand ? `Brand: ${l.brand}` : null }, hsn: l.hsnSac ?? "", qty: qty(l.quantity), unit: l.unit, rate: rate(l.rate), disc: isZero(l.discountPct) ? "—" : pct(l.discountPct), gst: pct(l.gstRate), amt: rate(l.taxable) })),
    totals: [
      { label: "Taxable value", value: rs(q.taxable) },
      { label: intra ? "CGST + SGST" : "IGST", value: rs(q.taxAmount) },
      ...(isZero(q.roundOff) ? [] : [{ label: "Round off", value: rs(q.roundOff) }]),
      { label: "Quotation total", value: rs(q.total), kind: "grand" as const },
    ],
    amountInWords: amountInWords(q.total),
    taxSummary: taxByRate(q.lines),
    sections: sections(
      {
        title: "Payment terms",
        items: [
          ...q.milestones.map((m) => `${m.label} — ${m.basis === "PERCENT" && m.percent ? `${m.percent}% · ` : ""}${rs(m.amount)} (${trig(m.trigger).toLowerCase()}${m.dueDate ? `, ${formatDate(m.dueDate)}` : ""}${m.days !== null ? `, ${m.days} days` : ""})`),
          ...(q.paymentTermsText ? [q.paymentTermsText] : []),
        ],
      },
      termsSection("Delivery terms", q.deliveryTerms),
      termsSection("Terms & conditions", q.terms),
      q.status === "ACCEPTED" || q.status === "CONVERTED" ? { title: "Acceptance", body: `Accepted by ${q.acceptedByName ?? "the client"}${q.acceptedByRole ? `, ${q.acceptedByRole}` : ""} on ${formatDate(q.acceptedAt)} (${q.acceptanceMethod === "CLIENT_LINK_OTP" ? "verified online" : "recorded by staff"}).` } : null,
    ),
    signatures: [
      { label: "Prepared by", name: q.createdBy.fullName, date: signDate(q.createdAt) },
      { label: "For the company", name: q.approvedBy?.fullName ?? null, date: signDate(q.approvedAt), note: q.approvedBy ? "Approved in ERP" : null, company: true },
      { label: "Client acceptance", name: q.acceptedByName ?? null, date: signDate(q.acceptedAt), note: q.acceptedByName ? null : "Name, sign, stamp & date" },
    ],
  };
}
