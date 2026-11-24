import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

/**
 * One A4 layout for every commercial document (PO, RFQ, challan, GRN, sales order, invoice,
 * RA bill, payment voucher). Built-in Helvetica has no ₹ glyph, so amounts print as "Rs.".
 */
export type PdfDoc = {
  title: string;
  number: string;
  date: string;
  status?: string;
  org: { name: string; legalName?: string | null; address?: string | null; phone?: string | null; email?: string | null; gstin?: string | null; logoDataUrl?: string | null };
  party?: { label: string; name: string; address?: string | null; gstin?: string | null; state?: string | null; phone?: string | null } | null;
  meta: { label: string; value: string }[];
  columns: { key: string; label: string; w: string; align?: "right" | "left" }[];
  rows: Record<string, string>[];
  totals?: { label: string; value: string; strong?: boolean }[];
  amountInWords?: string | null;
  notes?: { label: string; value: string }[];
  signatures?: string[];
  footerNote?: string;
};

const s = StyleSheet.create({
  page: { paddingTop: 30, paddingBottom: 44, paddingHorizontal: 30, fontSize: 8.5, fontFamily: "Helvetica", color: "#111" },
  header: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1.5, borderBottomColor: "#111", paddingBottom: 8, marginBottom: 10 },
  org: { fontSize: 12, fontFamily: "Helvetica-Bold" },
  muted: { color: "#555", fontSize: 7.5 },
  title: { fontSize: 14, fontFamily: "Helvetica-Bold", textAlign: "right" },
  box: { borderWidth: 0.75, borderColor: "#999", padding: 6, flexGrow: 1, flexBasis: 0 },
  label: { color: "#555", fontSize: 7 },
  bold: { fontFamily: "Helvetica-Bold" },
  head: { flexDirection: "row", backgroundColor: "#eee", borderWidth: 0.75, borderColor: "#999", paddingVertical: 4, fontFamily: "Helvetica-Bold" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderLeftWidth: 0.75, borderRightWidth: 0.75, borderColor: "#bbb", paddingVertical: 3.5 },
  footer: { position: "absolute", bottom: 18, left: 30, right: 30, flexDirection: "row", justifyContent: "space-between", color: "#777", fontSize: 7 },
});

export function CommercialPdf({ doc }: { doc: PdfDoc }) {
  return (
    <Document title={`${doc.title} ${doc.number}`} author={doc.org.name}>
      <Page size="A4" style={s.page}>
        <View style={s.header} fixed>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "62%" }}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
            {doc.org.logoDataUrl && <Image src={doc.org.logoDataUrl} style={{ height: 34, maxWidth: 110, objectFit: "contain" }} />}
            <View>
              <Text style={s.org}>{doc.org.legalName || doc.org.name}</Text>
              {doc.org.address && <Text style={s.muted}>{doc.org.address}</Text>}
              <Text style={s.muted}>{[doc.org.gstin && `GSTIN ${doc.org.gstin}`, doc.org.phone, doc.org.email].filter(Boolean).join(" · ")}</Text>
            </View>
          </View>
          <View>
            <Text style={s.title}>{doc.title}</Text>
            <Text style={[s.bold, { textAlign: "right", marginTop: 2 }]}>{doc.number}</Text>
            <Text style={[s.muted, { textAlign: "right" }]}>Date {doc.date}{doc.status ? ` · ${doc.status}` : ""}</Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }} wrap={false}>
          {doc.party && (
            <View style={s.box}>
              <Text style={s.label}>{doc.party.label}</Text>
              <Text style={s.bold}>{doc.party.name}</Text>
              {doc.party.address && <Text>{doc.party.address}</Text>}
              {doc.party.gstin && <Text>GSTIN {doc.party.gstin}</Text>}
              {doc.party.state && <Text>State {doc.party.state}</Text>}
              {doc.party.phone && <Text>{doc.party.phone}</Text>}
            </View>
          )}
          <View style={s.box}>
            {doc.meta.map((m) => (
              <Text key={m.label}>
                <Text style={s.label}>{m.label}: </Text>
                {m.value}
              </Text>
            ))}
          </View>
        </View>

        <View style={s.head} fixed>
          {doc.columns.map((c) => (
            <Text key={c.key} style={{ width: c.w, paddingHorizontal: 3, textAlign: c.align ?? "left" }}>
              {c.label}
            </Text>
          ))}
        </View>
        {doc.rows.map((r, i) => (
          <View key={i} style={s.row} wrap={false}>
            {doc.columns.map((c) => (
              <Text key={c.key} style={{ width: c.w, paddingHorizontal: 3, textAlign: c.align ?? "left" }}>
                {r[c.key] ?? ""}
              </Text>
            ))}
          </View>
        ))}
        {!doc.rows.length && <Text style={{ marginTop: 8, textAlign: "center", color: "#777" }}>No lines.</Text>}

        {doc.totals && doc.totals.length > 0 && (
          <View style={{ alignSelf: "flex-end", width: "45%", marginTop: 8 }} wrap={false}>
            {doc.totals.map((t) => (
              <View key={t.label} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5, ...(t.strong ? { borderTopWidth: 0.75, borderColor: "#111", marginTop: 2, paddingTop: 3 } : {}) }}>
                <Text style={t.strong ? s.bold : {}}>{t.label}</Text>
                <Text style={t.strong ? s.bold : {}}>{t.value}</Text>
              </View>
            ))}
          </View>
        )}
        {doc.amountInWords && <Text style={{ marginTop: 6 }}><Text style={s.label}>Amount in words: </Text>{doc.amountInWords}</Text>}

        {doc.notes?.map((n) => (
          <View key={n.label} style={{ marginTop: 8 }} wrap={false}>
            <Text style={s.label}>{n.label}</Text>
            <Text>{n.value}</Text>
          </View>
        ))}

        {doc.signatures && doc.signatures.length > 0 && (
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 36 }} wrap={false}>
            {doc.signatures.map((sig) => (
              <View key={sig} style={{ width: `${Math.floor(90 / doc.signatures!.length)}%`, borderTopWidth: 0.75, borderColor: "#555", paddingTop: 3 }}>
                <Text style={s.muted}>{sig}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={s.footer} fixed>
          <Text>{doc.footerNote ?? `${doc.org.name} · ${doc.title} ${doc.number}`}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
