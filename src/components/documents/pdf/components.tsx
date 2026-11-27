/* eslint-disable jsx-a11y/alt-text -- react-pdf <Image> renders into a PDF and has no alt attribute */
import { Image, Text, View } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import { C, PAGE, S, TONES } from "./theme";
import type { PdfCell, PdfColumn, PdfDoc, PdfField, PdfOrg, PdfPanel, PdfSection, PdfSign, PdfTaxRow, PdfTone, PdfTotal } from "./types";

/**
 * Reusable building blocks for every WATCON PDF (commercial documents and reports).
 * Page-break rules: rows, totals and signatures never split (`wrap={false}`); section titles
 * keep at least a few lines with them (`minPresenceAhead`); the table header repeats on
 * every page the table continues onto (`fixed` inside the table container).
 */

const join = (parts: (string | null | undefined)[], sep = "  ·  ") => parts.filter(Boolean).join(sep);

// ─────────────────────────── Letterhead & header ───────────────────────────

/** LEFT: logo + legal identity and contacts. Logo keeps its aspect ratio (contain). */
export function CompanyLetterhead({ org, compact }: { org: PdfOrg; compact?: boolean }) {
  const legal = org.legalName || org.name;
  const contact = join([org.phone, org.email, org.website]);
  const tax = join([org.gstin && `GSTIN ${org.gstin}`, org.pan && `PAN ${org.pan}`, org.state && `State ${org.state}`]);
  return (
    <View style={{ flexDirection: "column", maxWidth: compact ? "100%" : "62%" }}>
      {/* 1127×246 wordmark → 27 pt tall keeps the 4.58:1 ratio at 124 pt wide (no distortion) */}
      {org.logoDataUrl ? <Image src={org.logoDataUrl} style={{ height: compact ? 22 : 27, width: compact ? 101 : 124, objectFit: "contain", objectPosition: "left", marginBottom: 4 }} /> : null}
      <Text style={{ fontSize: org.logoDataUrl ? 9.6 : 13, fontWeight: 700, color: C.navy }}>{legal}</Text>
      {org.address ? <Text style={S.small}>{org.address}</Text> : null}
      {org.officeAddress ? <Text style={S.small}>Office: {org.officeAddress}</Text> : null}
      {contact ? <Text style={S.small}>{contact}</Text> : null}
      {tax ? <Text style={[S.small, { color: C.body }]}>{tax}</Text> : null}
    </View>
  );
}

export function StatusPill({ label, tone }: { label: string; tone: PdfTone }) {
  const t = TONES[tone];
  return (
    <View style={{ alignSelf: "flex-end", backgroundColor: t.bg, borderColor: t.border, borderWidth: 0.6, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1.5, marginTop: 4 }}>
      <Text style={{ fontSize: 6.8, fontWeight: 700, color: t.fg, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</Text>
    </View>
  );
}

/** RIGHT: document type, number, date, revision, status. */
export function DocumentHeader({ doc }: { doc: PdfDoc }) {
  const row = (label: string, value: string, bold?: boolean) => (
    <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 1.5 }}>
      <Text style={[S.small, { width: 62, textAlign: "right", marginRight: 6 }]}>{label}</Text>
      <Text style={bold ? [S.strong, { fontSize: 9 }] : { color: C.ink }}>{value}</Text>
    </View>
  );
  return (
    <View style={{ alignItems: "flex-end", maxWidth: "38%" }}>
      <Text style={{ fontSize: doc.title.length > 18 ? 12.5 : 15, fontWeight: 700, color: C.navy, textAlign: "right", textTransform: "uppercase", letterSpacing: 0.8 }}>{doc.title}</Text>
      <View style={{ marginTop: 5 }}>
        {row("No.", doc.number, true)}
        {row(doc.dateLabel ?? "Date", doc.date)}
        {doc.revision ? row("Revision", `Rev ${doc.revision}`) : null}
      </View>
      {doc.status ? <StatusPill label={doc.status.label} tone={doc.status.tone} /> : null}
    </View>
  );
}

/** Page-1 header: letterhead + document block, finished with a navy rule and red accent. */
export function LetterheadBlock({ doc }: { doc: PdfDoc }) {
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <CompanyLetterhead org={doc.org} />
        <DocumentHeader doc={doc} />
      </View>
      <View style={{ flexDirection: "row", marginTop: 8, marginBottom: 10 }}>
        <View style={{ height: 2, backgroundColor: C.accent, width: 48 }} />
        <View style={{ height: 2, backgroundColor: C.navy, flexGrow: 1 }} />
      </View>
    </View>
  );
}

/** Slim header on pages 2+ (absolute, so it never changes the flow of content). */
export function ContinuationHeader({ left, right }: { left: string; right: string }) {
  return (
    <View fixed style={{ position: "absolute", top: 16, left: PAGE.padX, right: PAGE.padX }}>
      <Text
        style={[S.small, { textAlign: "left" }]}
        render={({ pageNumber }) => (pageNumber > 1 ? left : "")}
      />
      <Text
        style={[S.small, { position: "absolute", right: 0, top: 0, textAlign: "right", fontWeight: 600, color: C.navy }]}
        render={({ pageNumber }) => (pageNumber > 1 ? `${right} — continued` : "")}
      />
    </View>
  );
}

/** Diagonal status mark (DRAFT / CANCELLED …) behind the content on every page. */
export function StatusWatermark({ text, landscape }: { text: string; landscape?: boolean }) {
  // Sized by length so long marks ("PENDING APPROVAL") stay on one line across the page.
  const size = Math.min(landscape ? 84 : 92, Math.floor((landscape ? 1150 : 880) / text.length));
  return (
    <View fixed style={{ position: "absolute", top: landscape ? 240 : 370, left: 0, right: 0, alignItems: "center" }}>
      <Text style={{ fontSize: size, fontWeight: 700, color: C.accent, opacity: 0.09, transform: "rotate(-30deg)", letterSpacing: 4 }}>{text}</Text>
    </View>
  );
}

/** Footer: company + document reference on the left, optional footer text, Page X of Y. */
export function DocumentFooter({ left, note }: { left: string; note?: string | null }) {
  return (
    <View fixed style={{ position: "absolute", bottom: 20, left: PAGE.padX, right: PAGE.padX, borderTopWidth: 0.6, borderTopColor: C.rule, paddingTop: 5, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
      <View style={{ maxWidth: "75%" }}>
        <Text style={{ fontSize: 6.6, color: C.muted }}>{left}</Text>
        {note ? <Text style={{ fontSize: 6.6, color: C.faint }}>{note}</Text> : null}
      </View>
      <Text style={{ fontSize: 6.8, color: C.muted }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  );
}

// ─────────────────────────── Information panels ───────────────────────────

function FieldRow({ f }: { f: PdfField }) {
  return (
    <View style={{ flexDirection: "row", marginTop: 1 }}>
      <Text style={[S.small, { width: 74, flexShrink: 0, paddingTop: 0.6 }]}>{f.label}</Text>
      {/* flexBasis 0 lets long values (addresses) wrap inside the card instead of overflowing */}
      <Text style={[{ flexGrow: 1, flexShrink: 1, flexBasis: 0, color: C.ink }, f.strong ? { fontWeight: 600 } : {}]}>{f.value}</Text>
    </View>
  );
}

/** Party / project / address card. Long addresses wrap inside the card; nothing is clipped. */
export function InfoPanel({ panel }: { panel: PdfPanel }) {
  const lines = (panel.lines ?? []).filter(Boolean) as string[];
  const fields = (panel.fields ?? []).filter((f) => f.value && f.value !== "—");
  return (
    <View style={S.card}>
      <Text style={S.label}>{panel.title}</Text>
      {panel.heading ? <Text style={[S.strong, { fontSize: 9.4, marginTop: 2 }]}>{panel.heading}</Text> : null}
      {lines.map((l, i) => (
        <Text key={i} style={{ color: C.body }}>
          {l}
        </Text>
      ))}
      {fields.length ? <View style={{ marginTop: lines.length || panel.heading ? 3 : 1 }}>{fields.map((f) => <FieldRow key={f.label} f={f} />)}</View> : null}
    </View>
  );
}

export function PanelRow({ panels }: { panels: PdfPanel[] }) {
  if (!panels.length) return null;
  return (
    <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }} wrap={false}>
      {panels.map((p) => (
        <InfoPanel key={p.title} panel={p} />
      ))}
    </View>
  );
}

/** Compact strip of key facts (delivery date, payment terms …). */
export function FactsStrip({ facts }: { facts: PdfField[] }) {
  const shown = facts.filter((f) => f.value && f.value !== "—");
  if (!shown.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", backgroundColor: C.navySoft, borderRadius: 3, paddingVertical: 4, paddingHorizontal: 8, marginBottom: 9 }} wrap={false}>
      {shown.map((f) => (
        <View key={f.label} style={{ width: `${100 / Math.min(shown.length, 4)}%`, paddingRight: 6, marginVertical: 1.5 }}>
          <Text style={S.label}>{f.label}</Text>
          <Text style={{ color: C.ink, fontWeight: f.strong ? 700 : 600 }}>{f.value}</Text>
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────── Items table ───────────────────────────

function cellParts(c: PdfCell | undefined): { text: string; sub: string | null } {
  if (c === undefined) return { text: "", sub: null };
  return typeof c === "string" ? { text: c, sub: null } : { text: c.text, sub: c.sub ?? null };
}

/**
 * Line-item / report table. Widths are relative weights, so the same table adapts to portrait
 * and landscape. Numbers right-align; descriptions wrap; each row stays on one page.
 */
export function ItemsTable({ columns, rows, title, emptyText }: { columns: PdfColumn[]; rows: Record<string, PdfCell>[]; title?: string; emptyText?: string }) {
  const total = columns.reduce((a, c) => a + c.width, 0);
  const w = (c: PdfColumn) => `${((c.width / total) * 100).toFixed(3)}%`;
  const cellStyle = (c: PdfColumn) => ({ width: w(c), paddingHorizontal: 4, textAlign: c.align ?? ("left" as const) });
  return (
    <View style={{ marginBottom: 4 }}>
      {title ? (
        <Text style={S.sectionTitle} minPresenceAhead={40}>
          {title}
        </Text>
      ) : null}
      <View fixed style={{ flexDirection: "row", backgroundColor: C.navy, borderTopLeftRadius: 3, borderTopRightRadius: 3, paddingVertical: 4.5 }}>
        {columns.map((c) => (
          <Text key={c.key} style={[cellStyle(c), { color: C.white, fontSize: 7, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }]}>
            {c.label}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View key={i} wrap={false} style={{ flexDirection: "row", paddingVertical: 3.2, backgroundColor: i % 2 ? C.zebra : C.white, borderBottomWidth: 0.5, borderBottomColor: C.ruleSoft, borderLeftWidth: 0.5, borderRightWidth: 0.5, borderLeftColor: C.ruleSoft, borderRightColor: C.ruleSoft }}>
          {columns.map((c) => {
            const { text, sub } = cellParts(r[c.key]);
            return (
              <View key={c.key} style={cellStyle(c)}>
                <Text style={{ textAlign: c.align ?? "left", color: C.ink }}>{text}</Text>
                {sub ? <Text style={[S.small, { textAlign: c.align ?? "left" }]}>{sub}</Text> : null}
              </View>
            );
          })}
        </View>
      ))}
      {!rows.length ? <Text style={{ paddingVertical: 10, textAlign: "center", color: C.muted, borderWidth: 0.5, borderColor: C.ruleSoft }}>{emptyText ?? "No lines."}</Text> : null}
    </View>
  );
}

// ─────────────────────────── Money ───────────────────────────

export function TotalsBlock({ totals }: { totals: PdfTotal[] }) {
  return (
    <View style={{ borderWidth: 0.6, borderColor: C.rule, borderRadius: 3, overflow: "hidden" }}>
      {totals.map((t, i) => {
        const grand = t.kind === "grand" || t.kind === "net";
        return (
          <View key={`${t.label}-${i}`} style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: grand ? 5 : 2.6, backgroundColor: grand ? C.navy : undefined, borderTopWidth: i && !grand ? 0.4 : 0, borderTopColor: C.ruleSoft }}>
            <Text style={grand ? { color: C.white, fontWeight: 700 } : t.kind === "info" ? S.small : { color: C.body }}>{t.label}</Text>
            <Text style={grand ? { color: C.white, fontWeight: 700, fontSize: 9.6 } : t.kind === "deduction" ? { color: C.accent } : t.kind === "info" ? S.small : { color: C.ink, fontWeight: 600 }}>{t.value}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function AmountInWords({ words }: { words: string }) {
  return (
    <View style={{ marginBottom: 6 }}>
      <Text style={S.label}>Amount in words</Text>
      <Text style={{ color: C.ink, fontWeight: 600 }}>{words}</Text>
    </View>
  );
}

/** GST by rate (only when lines carry more than one rate). Values come from the saved lines. */
export function TaxSummary({ rows }: { rows: PdfTaxRow[] }) {
  return (
    <View style={{ marginBottom: 6 }}>
      <Text style={S.label}>GST on items by rate</Text>
      <View style={{ flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.rule, paddingVertical: 1.5 }}>
        {["Rate", "Taxable value", "GST"].map((h, i) => (
          <Text key={h} style={[S.small, { width: i ? "40%" : "20%", textAlign: i ? "right" : "left", fontWeight: 600 }]}>
            {h}
          </Text>
        ))}
      </View>
      {rows.map((r) => (
        <View key={r.rate} style={{ flexDirection: "row", paddingVertical: 1 }}>
          <Text style={{ width: "20%" }}>{r.rate}</Text>
          <Text style={{ width: "40%", textAlign: "right" }}>{r.taxable}</Text>
          <Text style={{ width: "40%", textAlign: "right" }}>{r.tax}</Text>
        </View>
      ))}
    </View>
  );
}

export function BankDetails({ bank }: { bank: NonNullable<PdfOrg["bank"]> }) {
  const fields: PdfField[] = [
    { label: "Bank", value: bank.name },
    { label: "Account name", value: bank.accountName },
    { label: "Account no.", value: bank.accountNo, strong: true },
    { label: "IFSC", value: bank.ifsc, strong: true },
    { label: "Branch", value: bank.branch },
  ];
  return (
    <View style={{ marginBottom: 6 }}>
      <Text style={S.label}>Bank details for payment</Text>
      {fields.filter((f) => f.value).map((f) => <FieldRow key={f.label} f={f} />)}
    </View>
  );
}

/** Two-column money area: words / tax / bank on the left, totals on the right. */
export function FinancialSummary({ doc }: { doc: PdfDoc }) {
  const bank = doc.showBank && doc.org.bank && (doc.org.bank.accountNo || doc.org.bank.name) ? doc.org.bank : null;
  const hasLeft = !!(doc.amountInWords || doc.taxSummary?.length || bank);
  if (!doc.totals?.length && !hasLeft) return null;
  return (
    <View style={{ flexDirection: "row", gap: 12, marginTop: 8, marginBottom: 6 }} wrap={false}>
      <View style={{ flexGrow: 1, flexBasis: 0 }}>
        {doc.amountInWords ? <AmountInWords words={doc.amountInWords} /> : null}
        {doc.taxSummary && doc.taxSummary.length > 1 ? <TaxSummary rows={doc.taxSummary} /> : null}
        {bank ? <BankDetails bank={bank} /> : null}
      </View>
      {doc.totals?.length ? (
        <View style={{ width: "44%" }}>
          <TotalsBlock totals={doc.totals} />
        </View>
      ) : null}
    </View>
  );
}

// ─────────────────────────── Text sections ───────────────────────────

export function TextSection({ section }: { section: PdfSection }) {
  return (
    // A short section never splits (its heading would otherwise be left alone at a page foot); long ones flow.
    <View style={{ marginTop: 5 }} wrap={(section.body?.length ?? 0) + (section.items ?? []).join(" ").length > 900 || (section.items?.length ?? 0) > 8}>
      <Text style={S.sectionTitle} minPresenceAhead={30}>
        {section.title}
      </Text>
      {section.body ? <Text style={{ color: C.body }}>{section.body}</Text> : null}
      {section.items?.map((it, i) => (
        <View key={i} style={{ flexDirection: "row", marginTop: 1 }} wrap={false}>
          <Text style={{ width: section.items!.length > 9 ? 17 : 12, color: C.muted }}>{i + 1}.</Text>
          <Text style={{ flexGrow: 1, flexShrink: 1 }}>{it}</Text>
        </View>
      ))}
    </View>
  );
}

/** Attachment names only (never storage paths), as one compact wrapped line. */
export function AttachmentReferences({ items }: { items: string[] }) {
  return (
    <View style={{ marginTop: 5 }}>
      <Text style={S.sectionTitle} minPresenceAhead={20}>
        Attachments / references
      </Text>
      <Text style={{ color: C.body }}>{items.map((it, i) => `${i + 1}. ${it}`).join("     ")}</Text>
    </View>
  );
}

// ─────────────────────────── Signatures ───────────────────────────

/**
 * Authorisation blocks. Recorded names/dates print as recorded; blank blocks keep a line for a
 * wet signature. The signature image appears only on the company block of a final document.
 */
export function SignatureSection({ signs, org, final }: { signs: PdfSign[]; org: PdfOrg; final: boolean }) {
  return (
    <View style={{ marginTop: 10 }} wrap={false}>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {signs.map((sg) => {
          const showImage = sg.company && final && (org.signatory.signatureDataUrl || org.signatory.stampDataUrl);
          // A recorded person prints as recorded. The configured signatory's name is used only alongside
          // their signature image on a final document — never implying an approval that hasn't happened.
          const name = sg.name ?? (showImage && org.signatory.signatureDataUrl ? org.signatory.name : null);
          return (
            <View key={sg.label} style={{ flexGrow: 1, flexBasis: 0 }}>
              {/* Fixed-height caption so every signature line sits at the same height */}
              <View style={{ height: 19 }}>
                <Text style={S.label}>{sg.label}</Text>
                {sg.company ? <Text style={[S.small, { color: C.body, fontSize: 6.8 }]}>For {org.legalName || org.name}</Text> : null}
              </View>
              <View style={{ height: 26, flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
                {showImage && org.signatory.signatureDataUrl ? <Image src={org.signatory.signatureDataUrl} style={{ height: 30, width: 90, objectFit: "contain", objectPosition: "left" }} /> : null}
                {showImage && org.signatory.stampDataUrl ? <Image src={org.signatory.stampDataUrl} style={{ height: 32, width: 32, objectFit: "contain" }} /> : null}
              </View>
              <View style={{ borderTopWidth: 0.7, borderTopColor: C.faint, paddingTop: 2 }}>
                <Text style={name ? S.semibold : S.small}>
                  {name ?? "Name & signature"}
                  {name && sg.company && org.signatory.designation && !sg.name ? <Text style={[S.small, { fontWeight: 400 }]}>{`, ${org.signatory.designation}`}</Text> : null}
                </Text>
                {sg.date || sg.note || !name ? <Text style={S.small}>{[sg.date ?? (!name ? "Date" : null), sg.note].filter(Boolean).join("  ·  ")}</Text> : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─────────────────────────── Reports ───────────────────────────

/** Report header: letterhead + report title, subject and generated stamp. */
export function ReportHeader({ org, title, subject, generated, details }: { org: PdfOrg; title: string; subject: string; generated: string; details: PdfField[] }) {
  return (
    <View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <CompanyLetterhead org={org} />
        <View style={{ alignItems: "flex-end", maxWidth: "40%" }}>
          <Text style={{ fontSize: 14, fontWeight: 700, color: C.navy, textAlign: "right", textTransform: "uppercase", letterSpacing: 0.8 }}>{title}</Text>
          <Text style={[S.small, { textAlign: "right", marginTop: 3 }]}>{generated}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", marginTop: 8, marginBottom: 10 }}>
        <View style={{ height: 2, backgroundColor: C.accent, width: 48 }} />
        <View style={{ height: 2, backgroundColor: C.navy, flexGrow: 1 }} />
      </View>
      <Text style={[S.strong, { fontSize: 11, marginBottom: 4 }]}>{subject}</Text>
      {details.length ? <FactsStrip facts={details} /> : null}
    </View>
  );
}

export function ReportTable(props: { columns: PdfColumn[]; rows: Record<string, PdfCell>[]; emptyText?: string }) {
  return <ItemsTable {...props} />;
}

export function Note({ children }: { children: ReactNode }) {
  return <Text style={[S.small, { marginTop: 6 }]}>{children}</Text>;
}
