import { readFileSync } from "node:fs";
import path from "node:path";
import type { PdfDoc, PdfOrg } from "@/components/documents/pdf/types";
import { amountInWords } from "@/lib/money";
import { priceDocument } from "@/modules/commercial/pricing";
import { docState, isZero, pct, qty, rate, rs, taxByRate, termsSection } from "@/modules/documents/pdf-format";

/**
 * Representative print models for PDF layout tests. Numbers are produced by the app's own
 * pricing functions so totals, tax and amount-in-words are internally consistent.
 */

const logo = `data:image/png;base64,${readFileSync(path.join(process.cwd(), "public", "logo1.png")).toString("base64")}`;

export const ORG: PdfOrg = {
  name: "Watcon International",
  legalName: "Watcon International Private Limited",
  address: "Unit 402, Corporate Avenue, Off Andheri–Kurla Road, Andheri East, Mumbai 400093, Maharashtra",
  officeAddress: null,
  phone: "+91 22 4000 1234",
  email: "accounts@watcon.example",
  website: "www.watcon.example",
  gstin: "27AAACW1234F1Z5",
  pan: "AAACW1234F",
  state: "Maharashtra (27)",
  logoDataUrl: logo,
  footer: "Subject to Mumbai jurisdiction. This is a system-generated document.",
  bank: { name: "HDFC Bank", accountName: "Watcon International Pvt Ltd", accountNo: "50200012345678", ifsc: "HDFC0001234", branch: "Andheri East, Mumbai" },
  signatory: { name: "R. Mehta", designation: "Director", signatureDataUrl: null, stampDataUrl: null },
};

const ITEMS = [
  ["PVC-110", "PVC pressure pipe 110 mm, 6 kg/cm²", "Supreme", "39172390", "nos", "1245.50", "2", "18"],
  ["VLV-50", "Ball valve 50 mm, brass, full bore", "Zoloto", "84818030", "nos", "2380", "0", "18"],
  ["CEM-OPC", "OPC cement 53 grade", "UltraTech", "25232930", "bag", "410", "0", "28"],
  ["TIL-600", "Vitrified pool tile 600×600, anti-skid", "Kajaria", "69072100", "sqm", "865.75", "5", "18"],
  ["PMP-5HP", "Filtration pump 5 HP, three phase, with strainer basket", "Hayward", "84137010", "nos", "84500", "3", "18"],
  ["CHL-25", "Sodium hypochlorite 25 kg can", "Aquachem", "28289011", "can", "1150", "0", "12"],
] as const;

function poLines(n: number, longText = false) {
  return Array.from({ length: n }, (_, i) => {
    const [code, name, brand, hsn, unit, rt, disc, gst] = ITEMS[i % ITEMS.length]!;
    return { lineNo: i + 1, code, name, brand, hsn, unit, quantity: String(((i % 7) + 1) * 6), rate: rt, discountPct: disc, gstRate: gst, description: longText && i % 3 === 1 ? "Supply as per approved sample and drawing WAT/PL/017 rev C. Pressure-tested at 10 bar before dispatch; test certificate to accompany every consignment. Delivery in two lots as per site readiness." : i % 4 === 0 ? "ISI marked" : null };
  });
}

export function poFixture(opts: { lines: number; status?: string; longText?: boolean; terms?: string | null; freight?: string; inter?: boolean; revision?: number; missingOptional?: boolean }): PdfDoc {
  const lines = poLines(opts.lines, opts.longText);
  const priced = priceDocument(lines, opts.inter ? "INTER" : "INTRA", { charges: opts.freight ?? "0", chargesGstRate: "18", roundToRupee: true });
  const t = priced.totals;
  const status = opts.status ?? "APPROVED";
  return {
    docType: "PO",
    title: "Purchase Order",
    number: "PO/2026-27/0001",
    revision: opts.revision ?? null,
    date: "23 Nov 2026",
    dateLabel: "PO date",
    ...docState(status),
    org: ORG,
    panels: [
      {
        title: "Supplier",
        heading: opts.longText ? "Alpha Pool Equipment & Hydraulic Engineering Solutions Private Limited" : "Alpha Pipes & Fittings",
        lines: opts.longText ? ["Gala No. 14–16, Building B-3, Shree Ganesh Industrial Estate, Behind Western Express Highway Service Road, Opp. Petrol Pump, Bhayandar (East), Thane District", "Mira Bhayandar – 401105"] : ["Shop 4, Lohar Chawl", "Mumbai – 400002"],
        fields: opts.missingOptional
          ? [{ label: "GSTIN", value: "Unregistered" }]
          : [
              { label: "GSTIN", value: "27AAAPA1234B1Z1  ·  Maharashtra (27)", strong: true },
              { label: "Contact", value: "Mr. Prakash Shah  ·  +91 98200 00000" },
              { label: "Email", value: "sales@alphapipes.example" },
            ],
      },
      {
        title: "Project & delivery",
        heading: opts.longText ? "PRJ-0087 – Olympic-size Public Swimming Pool, Diving Well and Filtration Plant Renovation, Juhu Sports Complex" : "PRJ-0087 – Demo Pool Site",
        fields: [
          { label: "Delivery site", value: "Juhu site store", strong: true },
          { label: "Site address", value: opts.missingOptional ? null : "Juhu Tara Road, Santacruz West, Mumbai 400049" },
          { label: "Place of supply", value: opts.inter ? "Gujarat (24)" : "Maharashtra (27)" },
        ],
      },
    ],
    facts: opts.missingOptional
      ? [{ label: "Expected delivery", value: "—" }]
      : [
          { label: "Expected delivery", value: "30 Nov 2026" },
          { label: "Payment terms", value: "30 days from receipt" },
          { label: "RFQ reference", value: "RFQ/2026-27/0001" },
          { label: "Requisition", value: "PR/2026-27/0004" },
        ],
    tableTitle: "Order items",
    columns: [
      { key: "n", label: "S.No", width: 4.2, align: "center" },
      { key: "code", label: "Code", width: 8.5 },
      { key: "item", label: "Description / specification", width: 27 },
      { key: "brand", label: "Brand", width: 10.5 },
      { key: "hsn", label: "HSN", width: 8 },
      { key: "qty", label: "Qty", width: 7, align: "right" },
      { key: "unit", label: "Unit", width: 5.5 },
      { key: "rate", label: "Rate (₹)", width: 10, align: "right" },
      { key: "disc", label: "Disc", width: 5.5, align: "right" },
      { key: "gst", label: "GST", width: 5.2, align: "right" },
      { key: "amt", label: "Amount (₹)", width: 12.5, align: "right" },
    ],
    rows: priced.lines.map((l) => ({ n: String(l.lineNo), code: l.code, item: { text: l.name, sub: l.description }, brand: l.brand, hsn: l.hsn, qty: qty(l.quantity), unit: l.unit, rate: rate(l.rate), disc: isZero(l.discountPct) ? "—" : pct(l.discountPct), gst: pct(l.gstRate), amt: rate(l.amounts.taxable) })),
    totals: [
      { label: "Taxable value (items, after discount)", value: rs(t.taxable) },
      ...(isZero(t.discount) ? [] : [{ label: "Line discounts included", value: rs(t.discount), kind: "info" as const }]),
      ...(isZero(t.charges) ? [] : [{ label: "Freight / additional charges", value: rs(t.charges) }]),
      ...(opts.inter ? [{ label: "IGST", value: rs(t.igst) }] : [{ label: "CGST", value: rs(t.cgst) }, { label: "SGST", value: rs(t.sgst) }]),
      ...(isZero(t.roundOff) ? [] : [{ label: "Round off", value: rs(t.roundOff) }]),
      { label: "Grand total", value: rs(t.total), kind: "grand" as const },
    ],
    amountInWords: amountInWords(t.total),
    taxSummary: taxByRate(priced.lines.map((l) => ({ gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax }))),
    sections: [termsSection("Terms & conditions", opts.terms === undefined ? "1. Delivery at site between 9 am and 6 pm, Monday to Saturday.\n2. Material subject to inspection and acceptance at site; rejected material to be replaced at supplier's cost.\n3. Payment 30 days from receipt of material and a valid tax invoice.\n4. Warranty: 12 months from installation against manufacturing defects." : opts.terms)].filter((s) => s !== null),
    signatures: [
      { label: "Prepared by", name: "Sana Arif", date: "21 Nov 2026" },
      { label: "Approved by", name: status === "APPROVED" ? "R. Mehta" : null, date: status === "APPROVED" ? "22 Nov 2026" : null, note: status === "APPROVED" ? "Approved in ERP" : null, company: true },
      { label: "Supplier acceptance", note: "Sign, stamp & return a copy" },
    ],
    attachments: opts.missingOptional ? [] : ["Quotation: Alpha-QT-7781.pdf", "Drawing: WAT-PL-017-revC.pdf"],
  };
}

/** Stand-in signature image (the logo) — only to verify placement and the final-document gate. */
const SIGNATURE = logo;

export function invoiceFixture(status = "ISSUED"): PdfDoc {
  const lines = [
    { lineNo: 1, d: "Supply of filtration plant equipment as per SO/2026-27/0001", hsn: "84212190", unit: "lot", quantity: "1", rate: "845000", discountPct: "0", gstRate: "18" },
    { lineNo: 2, d: "Installation, testing and commissioning", hsn: "995461", unit: "job", quantity: "1", rate: "125000", discountPct: "0", gstRate: "18" },
    { lineNo: 3, d: "Pool chemicals – initial dosing", hsn: "28289011", unit: "kg", quantity: "250", rate: "46", discountPct: "0", gstRate: "12" },
  ];
  const p = priceDocument(lines, "INTER", { roundToRupee: true });
  return {
    docType: "INV",
    title: "Tax Invoice",
    number: "INV/2026-27/0012",
    date: "23 Nov 2026",
    dateLabel: "Invoice date",
    ...docState(status),
    org: { ...ORG, signatory: { ...ORG.signatory, signatureDataUrl: SIGNATURE } },
    showBank: status !== "DRAFT",
    panels: [
      { title: "Bill to", heading: "[TEST] Alpha Pools Pvt Ltd", lines: ["Plot 7, GIDC Estate, Vapi", "Valsad – 396195"], fields: [{ label: "GSTIN", value: "24AABCA1234C1Z9", strong: true }, { label: "State", value: "Gujarat (24)" }] },
      { title: "Supply details", heading: "PRJ-0087 – Demo Pool Site", fields: [{ label: "Place of supply", value: "Gujarat (24)", strong: true }, { label: "Sales order", value: "SO/2026-27/0001" }] },
    ],
    facts: [{ label: "Due date", value: "23 Dec 2026", strong: true }, { label: "Tax type", value: "IGST" }, { label: "Invoice total", value: rs(p.totals.total), strong: true }],
    tableTitle: "Particulars",
    columns: [
      { key: "n", label: "S.No", width: 4.5, align: "center" },
      { key: "item", label: "Description", width: 37 },
      { key: "hsn", label: "HSN/SAC", width: 9 },
      { key: "qty", label: "Qty", width: 8, align: "right" },
      { key: "unit", label: "Unit", width: 6 },
      { key: "rate", label: "Rate (₹)", width: 11, align: "right" },
      { key: "gst", label: "GST", width: 6, align: "right" },
      { key: "amt", label: "Amount (₹)", width: 13, align: "right" },
    ],
    rows: p.lines.map((l) => ({ n: String(l.lineNo), item: l.d, hsn: l.hsn, qty: qty(l.quantity), unit: l.unit, rate: rate(l.rate), gst: pct(l.gstRate), amt: rate(l.amounts.taxable) })),
    totals: [{ label: "Taxable value", value: rs(p.totals.taxable) }, { label: "IGST", value: rs(p.totals.igst) }, ...(isZero(p.totals.roundOff) ? [] : [{ label: "Round off", value: rs(p.totals.roundOff) }]), { label: "Invoice total", value: rs(p.totals.total), kind: "grand" as const }],
    amountInWords: amountInWords(p.totals.total),
    taxSummary: taxByRate(p.lines.map((l) => ({ gstRate: l.gstRate, taxable: l.amounts.taxable, taxAmount: l.amounts.tax }))),
    signatures: [{ label: "Prepared by", name: "Sana Arif", date: "23 Nov 2026" }, { label: "Authorised signatory", company: true }],
  };
}

export function raBillFixture(): PdfDoc {
  const rows = Array.from({ length: 14 }, (_, i) => ({ n: String(i + 1), item: { text: ["Excavation in all soils up to 1.5 m depth", "PCC 1:4:8 below foundation", "RCC M25 for pool shell incl. shuttering", "Waterproofing – crystalline coating", "Supply & laying of pool tiles"][i % 5]!, sub: i % 3 === 0 ? `MB ref: MB-04/p${12 + i}` : null }, unit: ["cum", "cum", "cum", "sqm", "sqm"][i % 5]!, contract: "1200", prev: "400", claim: "250", cum: "650", cert: i % 4 === 3 ? "—" : "240", rate: rate("1850"), amt: rate("444000") }));
  return {
    docType: "RAB",
    title: "Running Account Bill",
    number: "RAB/2026-27/0003",
    date: "23 Nov 2026",
    dateLabel: "Bill date",
    ...docState("CLIENT_CERTIFIED"),
    orientation: "landscape",
    org: ORG,
    panels: [
      { title: "Client", heading: "Municipal Corporation – Sports Division", lines: ["Sports Complex Office, Juhu, Mumbai 400049"], fields: [{ label: "GSTIN", value: "27AAALM0001A1Z3", strong: true }] },
      { title: "Contract", heading: "RA bill no. 3", fields: [{ label: "Project", value: "PRJ-0087 – Demo Pool Site", strong: true }, { label: "Client PO", value: "MCGM/SP/2026/118 (CPO/2026-27/0002)" }, { label: "Period", value: "01 Oct 2026 – 31 Oct 2026" }, { label: "Client certificate", value: "CERT-3 · 20 Nov 2026" }] },
    ],
    tableTitle: "Measurement & billing (quantities)",
    columns: [
      { key: "n", label: "S.No", width: 4, align: "center" },
      { key: "item", label: "Contract item", width: 30 },
      { key: "unit", label: "Unit", width: 5 },
      { key: "contract", label: "Contract qty", width: 8.5, align: "right" },
      { key: "prev", label: "Previous", width: 8, align: "right" },
      { key: "claim", label: "This bill", width: 8, align: "right" },
      { key: "cum", label: "Cumulative", width: 8.5, align: "right" },
      { key: "cert", label: "Certified", width: 8, align: "right" },
      { key: "rate", label: "Rate (₹)", width: 9, align: "right" },
      { key: "amt", label: "Amount (₹)", width: 11, align: "right" },
    ],
    rows,
    totals: [
      { label: "Certified value (this bill)", value: rs("6216000") },
      { label: "GST", value: rs("1118880") },
      { label: "Less retention (5%)", value: `- ${rs("310800")}`, kind: "deduction" },
      { label: "Less advance recovery", value: `- ${rs("621600")}`, kind: "deduction" },
      { label: "Net payable", value: rs("6402480"), kind: "net" },
    ],
    amountInWords: amountInWords("6402480"),
    signatures: [{ label: "Prepared by", name: "Sana Arif", date: "21 Nov 2026" }, { label: "Reviewed (site engineer)", name: "A. Khan", date: "22 Nov 2026", company: true }, { label: "Client certification", name: "Client Engineer", date: "20 Nov 2026", note: "Certificate CERT-3" }],
  };
}

export function grnFixture(): PdfDoc {
  return {
    docType: "GRN",
    title: "Goods Receipt Note",
    number: "GRN/2026-27/0007",
    date: "23 Nov 2026",
    dateLabel: "Received on",
    ...docState("SUBMITTED", { pending: ["SUBMITTED"], pendingMark: "NOT VERIFIED", label: "Awaiting verification" }),
    org: ORG,
    panels: [
      { title: "Supplier", heading: "Alpha Pipes & Fittings", lines: ["Shop 4, Lohar Chawl", "Mumbai – 400002"], fields: [{ label: "GSTIN", value: "27AAAPA1234B1Z1", strong: true }] },
      { title: "Received at", heading: "Juhu site store", fields: [{ label: "Project", value: "PRJ-0087 – Demo Pool Site" }, { label: "Received by", value: "Site supervisor" }] },
    ],
    facts: [{ label: "Against PO", value: "PO/2026-27/0001", strong: true }, { label: "Supplier challan", value: "DC-5521" }, { label: "Vehicle", value: "MH 04 AB 1234" }],
    tableTitle: "Items received",
    columns: [
      { key: "n", label: "S.No", width: 4.5, align: "center" },
      { key: "item", label: "Item – brand", width: 30 },
      { key: "unit", label: "Unit", width: 6 },
      { key: "exp", label: "Expected", width: 9, align: "right" },
      { key: "rec", label: "Received", width: 9, align: "right" },
      { key: "acc", label: "Accepted", width: 9, align: "right" },
      { key: "dmg", label: "Damaged", width: 8.5, align: "right" },
      { key: "rej", label: "Rejected", width: 8.5, align: "right" },
      { key: "note", label: "Discrepancy", width: 15.5 },
    ],
    rows: [
      { n: "1", item: { text: "PVC pressure pipe 110 mm – Supreme", sub: "PVC-110" }, unit: "nos", exp: "60", rec: "60", acc: "58", dmg: "2", rej: "—", note: "" },
      { n: "2", item: { text: "Ball valve 50 mm – Zoloto", sub: "VLV-50 · 2 boxes dented" }, unit: "nos", exp: "24", rec: "20", acc: "20", dmg: "—", rej: "—", note: "Short 4" },
      { n: "3", item: { text: "OPC cement 53 grade – UltraTech", sub: "CEM-OPC" }, unit: "bag", exp: "100", rec: "105", acc: "100", dmg: "—", rej: "5", note: "Excess 5" },
    ],
    sections: [{ title: "Remarks", body: "Two pipes cracked in transit — photos attached. Valves balance to follow." }],
    attachments: ["Photo: pipes-damage-1.jpg", "Delivery challan: DC-5521.pdf"],
    signatures: [{ label: "Received by (site)", name: "Site supervisor", date: "23 Nov 2026" }, { label: "Submitted by", name: "Sana Arif", date: "23 Nov 2026" }, { label: "Verified & posted by" }],
  };
}

export function challanFixture(): PdfDoc {
  return {
    docType: "DC",
    title: "Material Issue Challan",
    number: "DC/2026-27/0015",
    date: "23 Nov 2026",
    dateLabel: "Dispatched",
    ...docState("DISPATCHED"),
    org: ORG,
    panels: [
      { title: "Dispatch from", heading: "Central warehouse – Bhiwandi", lines: ["Gala 12, Rajlaxmi Complex, Bhiwandi 421302"], fields: [{ label: "Project", value: "PRJ-0087 – Demo Pool Site" }] },
      { title: "Deliver to", heading: "Juhu site store", lines: ["Juhu Tara Road, Santacruz West, Mumbai 400049"] },
    ],
    facts: [{ label: "Purpose", value: "Material issue to site", strong: true }, { label: "Vehicle", value: "MH 04 CD 9876" }, { label: "Transporter / LR", value: "Shree Logistics / LR-2231" }, { label: "Driver", value: "Ramesh · 98765 43210" }],
    tableTitle: "Materials",
    columns: [
      { key: "n", label: "S.No", width: 5, align: "center" },
      { key: "code", label: "Item code", width: 11 },
      { key: "item", label: "Item – brand", width: 38 },
      { key: "hsn", label: "HSN", width: 10 },
      { key: "qty", label: "Qty sent", width: 10, align: "right" },
      { key: "unit", label: "Unit", width: 7 },
    ],
    rows: ITEMS.map((it, i) => ({ n: String(i + 1), code: it[0], item: `${it[1]} – ${it[2]}`, hsn: it[3], qty: String((i + 2) * 5), unit: it[4] })),
    sections: [{ title: "Declaration", body: "Material moved for the purpose stated above. Not for sale unless accompanied by a tax invoice." }],
    signatures: [{ label: "Dispatched by", name: "Store keeper", date: "23 Nov 2026" }, { label: "Driver / transporter", name: "Ramesh" }, { label: "Received by", note: "Name, sign, date & stamp" }],
  };
}

export function paymentFixture(): PdfDoc {
  return {
    docType: "PV",
    title: "Payment Voucher",
    number: "PAY/2026-27/0031",
    date: "23 Nov 2026",
    dateLabel: "Paid on",
    ...docState("POSTED", { label: "Posted" }),
    org: ORG,
    panels: [
      { title: "Paid to (payee)", heading: "Alpha Pipes & Fittings", lines: ["Shop 4, Lohar Chawl", "Mumbai – 400002"], fields: [{ label: "GSTIN", value: "27AAAPA1234B1Z1", strong: true }] },
      { title: "Transaction", heading: rs("250000"), fields: [{ label: "Method", value: "NEFT / RTGS", strong: true }, { label: "Reference", value: "UTR HDFCN52026112300123" }, { label: "Project", value: "PRJ-0087 – Demo Pool Site" }] },
    ],
    tableTitle: "Allocated against supplier bills",
    columns: [
      { key: "n", label: "S.No", width: 6, align: "center" },
      { key: "doc", label: "Bill", width: 64 },
      { key: "amt", label: "Amount (₹)", width: 30, align: "right" },
    ],
    rows: [
      { n: "1", doc: { text: "SB/2026-27/0019", sub: "Supplier invoice AP/2231" }, amt: rate("180000") },
      { n: "2", doc: { text: "SB/2026-27/0022", sub: "Supplier invoice AP/2240" }, amt: rate("70000") },
    ],
    totals: [{ label: "Amount paid", value: rs("250000") }, { label: "Total settled", value: rs("250000"), kind: "grand" }],
    amountInWords: amountInWords("250000"),
    signatures: [{ label: "Prepared by", name: "Sana Arif", date: "23 Nov 2026" }, { label: "Authorised by", company: true }, { label: "Receiver's signature", note: "Name, sign & date" }],
  };
}

export function creditNoteFixture(): PdfDoc {
  return {
    docType: "CN",
    title: "Credit Note",
    number: "CN/2026-27/0002",
    date: "23 Nov 2026",
    ...docState("CANCELLED"),
    org: ORG,
    panels: [
      { title: "Client", heading: "[TEST] Alpha Pools Pvt Ltd", fields: [{ label: "GSTIN", value: "24AABCA1234C1Z9", strong: true }] },
      { title: "Reference", heading: "Invoice INV/2026-27/0012", fields: [{ label: "Project", value: "PRJ-0087 – Demo Pool Site" }] },
    ],
    tableTitle: "Particulars",
    columns: [
      { key: "d", label: "Reason", width: 62 },
      { key: "gst", label: "GST", width: 10, align: "right" },
      { key: "amt", label: "Taxable (₹)", width: 28, align: "right" },
    ],
    rows: [{ d: "Rate difference on pool chemicals (agreed revision)", gst: "12%", amt: rate("-1500.50") }],
    totals: [{ label: "Taxable value", value: rs("-1500.50") }, { label: "IGST", value: rs("-180.06") }, { label: "Credit amount", value: rs("-1680.56"), kind: "grand" }],
    amountInWords: amountInWords("-1680.56"),
    signatures: [{ label: "Prepared by", name: "Sana Arif", date: "23 Nov 2026" }, { label: "Approved by", company: true }],
  };
}

export const LONG_TERMS = Array.from({ length: 34 }, (_, i) => `${i + 1}. ${["Delivery shall be made to the site store between 9 am and 6 pm on working days; unloading at supplier's cost.", "All material is subject to inspection and acceptance by the site engineer; rejected material shall be lifted within 7 days.", "Prices are firm until completion of this order and include packing and forwarding.", "Payment within 30 days of acceptance of material and receipt of a valid GST invoice quoting this PO number.", "The supplier shall furnish test certificates, warranty cards and operation manuals where applicable."][i % 5]}`).join("\n");
