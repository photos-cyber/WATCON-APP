import "server-only";
import type { PdfColumn, PdfDoc } from "@/components/documents/pdf/types";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { amountInWords, cmpQty, subQty } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { docState, humanize, isZero, loadPdfOrg, partyPanel, pct, projectLabel, qty, rate, rs, signDate, taxByRate, termsSection } from "./pdf-kit";

/**
 * Printable models. Every builder loads through the module's own scoped getter, so the PDF
 * obeys exactly the same access rules as the page. Amounts are the saved, authoritative values.
 */

type Builder = (actor: Actor, id: string) => Promise<PdfDoc>;

/** Full party card for the letter (legal name, contact person, PIN) — getters select only a few fields. */
export async function loadParty(organizationId: string, partyId: string | null | undefined) {
  if (!partyId) return null;
  return db.party.findFirst({ where: { id: partyId, organizationId }, select: { name: true, legalName: true, address: true, city: true, pincode: true, gstin: true, stateCode: true, phone: true, email: true, contactPerson: true, pan: true } });
}

const sub = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ") || null;

const BUILDERS: Record<string, () => Promise<Builder>> = {
  client_po: async () => (await import("@/modules/sales/pdf")).clientPoPdf,
  sales_order: async () => (await import("@/modules/sales/pdf")).salesOrderPdf,
  ra_bill: async () => (await import("@/modules/sales/pdf")).raBillPdf,
  client_invoice: async () => (await import("@/modules/sales/pdf")).clientInvoicePdf,
  client_quotation: async () => (await import("@/modules/sales/pdf")).quotationPdf,
  supplier_bill: async () => (await import("@/modules/payables/pdf")).supplierBillPdf,
  payment: async () => (await import("@/modules/payables/pdf")).paymentPdf,
  adjustment_note: async () => (await import("@/modules/payables/pdf")).notePdf,
  project_accounts: async () => (await import("@/modules/insights/accounts-pdf")).projectAccountsPdf,

  // ───────────── Purchase order ─────────────
  purchase_order: async () => {
    const { getPo } = await import("@/modules/procurement/po");
    return async (actor, id) => {
      const { po } = await getPo(actor, id);
      const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, po.partyId)]);
      const intra = po.taxMode === "INTRA";
      const columns: PdfColumn[] = [
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
      ];
      return {
        docType: "PO",
        title: "Purchase Order",
        number: po.number,
        revision: po.revision || null,
        date: formatDate(po.orderDate),
        dateLabel: "PO date",
        ...docState(po.status),
        org,
        panels: [
          partyPanel("Supplier", party ?? po.party),
          {
            title: "Project & delivery",
            heading: projectLabel(po.project) ?? "General stock (no project)",
            fields: [
              { label: "Delivery site", value: po.deliveryLocation.name, strong: true },
              { label: "Site address", value: [po.deliveryLocation.address, po.deliveryAddress].filter(Boolean).join(", ") || null },
              { label: "Place of supply", value: po.placeOfSupply },
            ],
          },
        ],
        facts: [
          { label: "Expected delivery", value: formatDate(po.expectedDate) },
          { label: "Payment terms", value: po.paymentTerms },
          { label: "Credit days", value: po.creditDays != null ? `${po.creditDays} days` : null },
          { label: "Warranty", value: po.warranty },
          { label: "RFQ reference", value: po.rfq?.number },
          { label: "Requisition", value: po.pr?.number },
          ...(isZero(po.advanceAmount) ? [] : [{ label: "Advance", value: rs(po.advanceAmount) }]),
        ],
        tableTitle: "Order items",
        columns,
        rows: po.lines.map((l) => ({
          n: String(l.lineNo),
          code: l.itemBrand.item.code,
          item: { text: l.itemBrand.item.name, sub: l.description },
          brand: l.itemBrand.brand.name,
          hsn: l.hsnCode ?? l.itemBrand.item.hsnCode ?? "",
          qty: qty(l.quantity),
          unit: l.unit,
          rate: rate(l.rate),
          disc: isZero(l.discountPct) ? "—" : pct(l.discountPct),
          gst: pct(l.gstRate),
          amt: rate(l.taxable),
        })),
        totals: [
          { label: "Taxable value (items, after discount)", value: rs(po.taxable) },
          ...(isZero(po.discountTotal) ? [] : [{ label: "Line discounts included", value: rs(po.discountTotal), kind: "info" as const }]),
          ...(isZero(po.charges) ? [] : [{ label: "Freight / additional charges", value: rs(po.charges) }]),
          ...(intra ? [{ label: "CGST", value: rs(po.cgst) }, { label: "SGST", value: rs(po.sgst) }] : [{ label: "IGST", value: rs(po.igst) }]),
          ...(isZero(po.roundOff) ? [] : [{ label: "Round off", value: rs(po.roundOff) }]),
          { label: "Grand total", value: rs(po.total), kind: "grand" as const },
        ],
        amountInWords: amountInWords(po.total),
        taxSummary: taxByRate(po.lines),
        sections: [termsSection("Terms & conditions", po.terms)].filter((s) => s !== null),
        signatures: [
          { label: "Prepared by", name: po.createdBy.fullName, date: signDate(po.createdAt) },
          { label: "Approved by", name: po.approvedBy?.fullName ?? null, date: signDate(po.approvedAt), note: po.approvedBy ? "Approved in ERP" : null, company: true },
          { label: "Supplier acceptance", note: "Sign, stamp & return a copy" },
        ],
      };
    };
  },

  // ───────────── Purchase requisition ─────────────
  purchase_requisition: async () => {
    const { getPr } = await import("@/modules/procurement/pr");
    return async (actor, id) => {
      const { pr } = await getPr(actor, id);
      return {
        docType: "PR",
        title: "Purchase Requisition",
        number: pr.number,
        date: formatDate(pr.createdAt),
        ...docState(pr.status, { pending: ["SUBMITTED"] }),
        org: await loadPdfOrg(actor.organizationId),
        panels: [
          { title: "Project", heading: projectLabel(pr.project) ?? "General stock (no project)", fields: [{ label: "Deliver to", value: pr.deliveryLocation?.name }] },
          { title: "Requested", heading: pr.createdBy.fullName, fields: [{ label: "Required by", value: formatDate(pr.requiredBy), strong: true }, { label: "Raised on", value: formatDate(pr.createdAt) }] },
        ],
        tableTitle: "Materials required",
        columns: [
          { key: "n", label: "S.No", width: 5, align: "center" },
          { key: "code", label: "Item code", width: 11 },
          { key: "item", label: "Item", width: 32 },
          { key: "brand", label: "Brand", width: 14 },
          { key: "qty", label: "Qty", width: 10, align: "right" },
          { key: "unit", label: "Unit", width: 7 },
          { key: "ordered", label: "Ordered", width: 9, align: "right" },
          { key: "by", label: "Needed by", width: 12 },
        ],
        rows: pr.lines.map((l) => ({ n: String(l.lineNo), code: l.itemBrand.item.code, item: { text: l.itemBrand.item.name, sub: l.notes }, brand: l.itemBrand.brand.name, qty: qty(l.quantity), unit: l.itemBrand.item.unit, ordered: qty(l.orderedQty), by: formatDate(l.requiredBy) })),
        sections: pr.purpose ? [{ title: "Purpose", body: pr.purpose }] : [],
        signatures: [
          { label: "Requested by", name: pr.createdBy.fullName, date: signDate(pr.createdAt) },
          { label: "Approved by", name: pr.approvedBy?.fullName ?? null, date: signDate(pr.approvedAt), note: pr.approvedBy ? "Approved in ERP" : null },
        ],
      };
    };
  },

  // ───────────── Rate enquiry (RFQ) ─────────────
  rfq: async () => {
    const { getRfq } = await import("@/modules/procurement/rfq");
    return async (actor, id) => {
      const { rfq } = await getRfq(actor, id);
      const st = docState(rfq.status, { pending: [] });
      return {
        docType: "RFQ",
        title: "Request for Quotation",
        number: rfq.number,
        date: formatDate(rfq.createdAt),
        ...st,
        // An RFQ is an invitation, not an approval document: only mark it when cancelled.
        watermark: rfq.status === "CANCELLED" ? "CANCELLED" : null,
        org: await loadPdfOrg(actor.organizationId),
        panels: [
          { title: "Invited suppliers", lines: rfq.suppliers.map((s) => s.party.name) },
          {
            title: "Project & delivery",
            heading: projectLabel(rfq.project),
            fields: [
              { label: "Deliver to", value: rfq.deliveryLocation?.name, strong: true },
              { label: "Address", value: rfq.deliveryAddress },
            ],
          },
        ],
        facts: [
          { label: "Quote by", value: formatDate(rfq.responseDue), strong: true },
          { label: "Needed at site by", value: formatDate(rfq.requiredBy) },
          { label: "Quote validity", value: rfq.validityDays ? `${rfq.validityDays} days` : null },
          { label: "Payment terms", value: rfq.paymentTerms },
          { label: "Freight", value: rfq.freightTerms },
          { label: "Taxes", value: rfq.taxTerms },
        ],
        tableTitle: `Materials — ${rfq.title}`,
        columns: [
          { key: "n", label: "S.No", width: 5, align: "center" },
          { key: "item", label: "Material & specification", width: 42 },
          { key: "brand", label: "Brand / acceptable alternatives", width: 29 },
          { key: "qty", label: "Qty", width: 12, align: "right" },
          { key: "unit", label: "Unit", width: 9 },
        ],
        rows: rfq.lines.map((l) => ({ n: String(l.lineNo), item: { text: l.item.name, sub: l.specifications }, brand: [l.itemBrand?.brand.name, l.acceptableBrands].filter(Boolean).join(" / ") || "Any brand", qty: qty(l.quantity), unit: l.unit })),
        sections: [
          ...(rfq.specifications ? [{ title: "Specifications", body: rfq.specifications }] : []),
          {
            title: "How to quote",
            items: [
              "Quote the rate per unit before GST, any discount, and the GST rate for each item.",
              "Mention freight / transport charges, delivery lead time and the validity of your quotation.",
              ...(rfq.responseDue ? [`Please send your quotation by ${formatDate(rfq.responseDue)}, quoting reference ${rfq.number}.`] : [`Please quote reference ${rfq.number} in your quotation.`]),
            ],
          },
        ],
        signatures: [{ label: "Issued by", name: rfq.createdBy.fullName, date: signDate(rfq.createdAt), company: true }],
        final: rfq.status !== "DRAFT" && rfq.status !== "CANCELLED",
      };
    };
  },

  // ───────────── Goods receipt note ─────────────
  grn: async () => {
    const { getGrn } = await import("@/modules/stores/grn");
    return async (actor, id) => {
      const { grn } = await getGrn(actor, id);
      const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, grn.partyId)]);
      const diff = (exp: string, rec: string) => {
        const c = cmpQty(rec, exp);
        if (c === 0 || isZero(exp)) return "";
        return c < 0 ? `Short ${qty(subQty(exp, rec))}` : `Excess ${qty(subQty(rec, exp))}`;
      };
      return {
        docType: "GRN",
        title: "Goods Receipt Note",
        number: grn.number,
        date: formatDate(grn.receiptDate),
        dateLabel: "Received on",
        ...docState(grn.status, { pending: ["SUBMITTED"], pendingMark: "NOT VERIFIED", label: grn.status === "SUBMITTED" ? "Awaiting verification" : grn.status === "POSTED" ? "Verified & posted" : undefined }),
        org,
        panels: [
          party ? partyPanel("Supplier", party) : { title: "Received from", heading: grn.challan ? `Challan ${grn.challan.number}` : "—" },
          { title: "Received at", heading: grn.location.name, fields: [{ label: "Project", value: projectLabel(grn.project) }, { label: "Received by", value: grn.receivedByName ?? grn.createdBy.fullName }] },
        ],
        facts: [
          grn.po ? { label: "Against PO", value: grn.po.number, strong: true } : { label: "Against challan", value: grn.challan?.number, strong: true },
          { label: "Supplier challan", value: grn.supplierChallanNo },
          { label: "Supplier invoice", value: grn.supplierInvoiceNo },
          { label: "Vehicle", value: grn.vehicleNo },
        ],
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
        rows: grn.lines.map((l) => ({
          n: String(l.lineNo),
          item: { text: `${l.itemBrand.item.name} – ${l.itemBrand.brand.name}`, sub: sub(l.itemBrand.item.code, l.remarks) },
          unit: l.itemBrand.item.unit,
          exp: qty(l.expectedQty),
          rec: qty(l.receivedQty),
          acc: qty(l.acceptedQty),
          dmg: isZero(l.damagedQty) ? "—" : qty(l.damagedQty),
          rej: isZero(l.rejectedQty) ? "—" : qty(l.rejectedQty),
          note: diff(l.expectedQty, l.receivedQty),
        })),
        sections: grn.remarks ? [{ title: "Remarks", body: grn.remarks }] : [],
        signatures: [
          { label: "Received by (site)", name: grn.receivedByName ?? grn.createdBy.fullName, date: signDate(grn.receiptDate) },
          { label: "Submitted by", name: grn.submittedBy?.fullName ?? null, date: signDate(grn.submittedAt) },
          { label: "Verified & posted by", name: grn.postedBy?.fullName ?? null, date: signDate(grn.postedAt), note: grn.postedBy ? "Posted to stock in ERP" : null },
        ],
      };
    };
  },

  // ───────────── Challans (issue / transfer / return / delivery) ─────────────
  challan: async () => {
    const { getChallan, CHALLAN_TYPE_LABELS } = await import("@/modules/stores/challan");
    return async (actor, id) => {
      const { challan: c } = await getChallan(actor, id);
      const [org, party] = await Promise.all([loadPdfOrg(actor.organizationId), loadParty(actor.organizationId, c.partyId)]);
      const titles: Record<string, string> = { ISSUE_TO_SITE: "Material Issue Challan", SITE_TO_SITE: "Stock Transfer Challan", RETURN_TO_STORE: "Material Return Challan", RETURN_TO_SUPPLIER: "Return Challan", CLIENT_DELIVERY: "Delivery Challan" };
      const st = docState(c.status);
      const received = c.lines.some((l) => !isZero(l.receivedQty));
      // Receiver of record: the challan's own entry, else the posted site receipt against it.
      const siteGrn = received && !c.receiverName ? await db.grn.findFirst({ where: { organizationId: actor.organizationId, challanId: c.id, status: "POSTED" }, select: { receivedByName: true, receiptDate: true, createdBy: { select: { fullName: true } } }, orderBy: { receiptDate: "desc" } }) : null;
      return {
        docType: "DC",
        title: titles[c.type] ?? "Delivery Challan",
        number: c.number,
        date: formatDate(c.dispatchDate ?? c.createdAt),
        dateLabel: c.dispatchDate ? "Dispatched" : "Date",
        ...st,
        final: c.status !== "DRAFT" && c.status !== "CANCELLED",
        org,
        panels: [
          { title: "Dispatch from", heading: c.fromLocation?.name ?? "—", lines: [c.fromLocation?.address], fields: [{ label: "Project", value: projectLabel(c.project) }] },
          party
            ? partyPanel(c.type === "CLIENT_DELIVERY" ? "Consignee" : "Supplier", party, c.toLocation ? [{ label: "Deliver to", value: c.toLocation.name }] : [])
            : { title: "Deliver to", heading: c.toLocation?.name ?? "—", lines: [c.toLocation?.address] },
        ],
        facts: [
          { label: "Purpose", value: CHALLAN_TYPE_LABELS[c.type], strong: true },
          { label: "Vehicle", value: c.vehicleNo },
          { label: "Transporter / LR", value: [c.transporter, c.lrNumber].filter(Boolean).join(" / ") || null },
          { label: "Driver", value: [c.driverName, c.driverPhone].filter(Boolean).join(" · ") || null },
          { label: "Reference PO", value: c.po?.number },
          { label: "Reference SO", value: c.so?.number },
          { label: "Expected by", value: c.expectedDate ? formatDate(c.expectedDate) : null },
        ],
        tableTitle: "Materials",
        columns: [
          { key: "n", label: "S.No", width: 5, align: "center" },
          { key: "code", label: "Item code", width: 11 },
          { key: "item", label: "Item – brand", width: 38 },
          { key: "hsn", label: "HSN", width: 10 },
          { key: "qty", label: "Qty sent", width: 10, align: "right" },
          { key: "unit", label: "Unit", width: 7 },
          ...(received ? [{ key: "rec", label: "Received", width: 10, align: "right" as const }] : []),
        ],
        rows: c.lines.map((l) => ({ n: String(l.lineNo), code: l.itemBrand.item.code, item: { text: `${l.itemBrand.item.name} – ${l.itemBrand.brand.name}`, sub: l.remarks }, hsn: l.itemBrand.item.hsnCode ?? "", qty: qty(l.quantity), unit: l.itemBrand.item.unit, rec: qty(l.receivedQty) })),
        sections: [
          { title: "Declaration", body: c.type === "CLIENT_DELIVERY" ? "Goods delivered against the order referenced above." : "Material moved for the purpose stated above. Not for sale unless accompanied by a tax invoice." },
          ...(c.type === "ISSUE_TO_SITE" || c.type === "SITE_TO_SITE" ? [{ title: "On receipt at site", items: ["Count the material against this challan before signing.", "Note any shortage, damage or rejection on this copy.", "Sign and stamp this challan. A photo of the signed copy and of the material must be uploaded in the app to confirm receipt."] }] : []),
          ...(c.remarks ? [{ title: "Remarks", body: c.remarks }] : []),
        ],
        signatures: [
          { label: "Dispatched by", name: c.dispatchedBy?.fullName ?? c.senderName ?? null, date: signDate(c.dispatchedAt) },
          { label: "Driver / transporter", name: c.driverName ?? null },
          { label: "Received by", name: c.receiverName ?? siteGrn?.receivedByName ?? siteGrn?.createdBy.fullName ?? null, date: signDate(c.deliveredDate ?? siteGrn?.receiptDate), note: siteGrn ? "Confirmed in app with photo proof" : "Name, sign, date & stamp" },
        ],
      };
    };
  },
};

export function registerPdfBuilder(type: string, loader: () => Promise<Builder>) {
  BUILDERS[type] = loader;
}

/** Builds the print model and adds the document's attachment references (names only). */
export async function buildPdfModel(actor: Actor, type: string, id: string): Promise<PdfDoc> {
  const loader = BUILDERS[type];
  if (!loader || !/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("Document");
  const doc = await (await loader())(actor, id);
  const files = await db.attachment.findMany({ where: { organizationId: actor.organizationId, entityType: type, entityId: id, deletedAt: null }, select: { fileName: true, category: true }, orderBy: { createdAt: "asc" }, take: 30 });
  if (files.length) doc.attachments = [...(doc.attachments ?? []), ...files.map((f) => `${humanize(f.category)}: ${f.fileName}`)];
  return doc;
}
