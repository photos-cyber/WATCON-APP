import { Document, Page, View } from "@react-pdf/renderer";
import { AttachmentReferences, ContinuationHeader, DocumentFooter, FactsStrip, FinancialSummary, ItemsTable, LetterheadBlock, PanelRow, SignatureSection, StatusWatermark, TextSection } from "./pdf/components";
import { registerPdfFonts, S } from "./pdf/theme";
import type { PdfDoc } from "./pdf/types";

export type { PdfDoc } from "./pdf/types";

/**
 * One A4 layout for every commercial document (PO, PR, RFQ, challan, GRN, client PO, sales
 * order, RA bill, invoice, supplier bill, payment / receipt voucher, debit / credit note).
 *
 * Section order: letterhead → parties → key facts → items → money → terms → attachments →
 * authorisation; footer with page numbers on every page. Short documents stay compact —
 * nothing is stretched to fill the page.
 */
export function CommercialPdf({ doc }: { doc: PdfDoc }) {
  registerPdfFonts();
  const ref = `${doc.title} ${doc.number}${doc.revision ? ` (Rev ${doc.revision})` : ""}`;
  const legal = doc.org.legalName || doc.org.name;
  return (
    <Document title={ref} author={legal} subject={ref} creator={`${doc.org.name} ERP`} producer={`${doc.org.name} ERP`}>
      <Page size="A4" orientation={doc.orientation ?? "portrait"} style={S.page}>
        {doc.watermark ? <StatusWatermark text={doc.watermark} landscape={doc.orientation === "landscape"} /> : null}
        <ContinuationHeader left={legal} right={ref} />
        <LetterheadBlock doc={doc} />
        <PanelRow panels={doc.panels} />
        {doc.facts?.length ? <FactsStrip facts={doc.facts} /> : null}
        <ItemsTable columns={doc.columns} rows={doc.rows} title={doc.tableTitle} emptyText={doc.emptyText} />
        <FinancialSummary doc={doc} />
        {doc.sections?.map((s) => <TextSection key={s.title} section={s} />)}
        {doc.attachments?.length ? <AttachmentReferences items={doc.attachments} /> : null}
        {doc.signatures?.length ? <SignatureSection signs={doc.signatures} org={doc.org} final={doc.final} /> : null}
        <View style={{ height: 4 }} />
        <DocumentFooter left={`${legal}  ·  ${ref}  ·  System-generated document`} note={doc.org.footer} />
      </Page>
    </Document>
  );
}
