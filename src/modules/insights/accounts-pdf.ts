import "server-only";
import type { PdfDoc, PdfPanel } from "@/components/documents/pdf/types";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import type { Actor } from "@/lib/permissions/definitions";
import { humanize, loadPdfOrg, projectLabel, rs } from "@/modules/documents/pdf-kit";
import { projectAccountsDashboard, projectTransactions } from "./project-accounts";

const FLOW: Record<string, string> = { IN: "In", OUT: "Out", NONE: "—" };

/**
 * Project Accounts Statement PDF (workflow v2 · Phase 9). Same figures as the project Accounts tab —
 * operational, not a ledger. Needs `accounts.view` and project visibility (checked by the getters).
 */
export async function projectAccountsPdf(actor: Actor, projectId: string): Promise<PdfDoc> {
  const [{ client: c, supplier: s, summary: f }, txns, project, org] = await Promise.all([
    projectAccountsDashboard(actor, projectId),
    projectTransactions(actor, projectId, 150),
    db.project.findFirst({ where: { id: projectId, organizationId: actor.organizationId }, select: { code: true, name: true, siteAddress: true, status: true } }),
    loadPdfOrg(actor.organizationId),
  ]);
  const preparer = await db.user.findUnique({ where: { id: actor.id }, select: { fullName: true } });
  if (!project) throw new NotFoundError("Project");
  const today = new Date();
  const panels: PdfPanel[] = [
    { title: "Project", heading: projectLabel(project), lines: [project.siteAddress], fields: [{ label: "Status", value: humanize(project.status) }, { label: "Client", value: c?.clients.map((x) => x.name).join(", ") || null }] },
    {
      title: "Financial summary (excl. GST)",
      fields: [
        { label: "Contract value", value: rs(f.contractTaxable) },
        { label: "Revenue (invoiced)", value: rs(f.revenue) },
        { label: "Material cost", value: rs(f.materialCost) },
        { label: "Other expenses", value: rs(f.otherExpenses) },
        { label: "Est. remaining cost", value: rs(f.estRemaining) },
        { label: "Est. profit", value: `${rs(f.estProfit)}${f.estProfitPct ? ` (${f.estProfitPct}%)` : ""}`, strong: true },
        ...(f.actualMargin !== null ? [{ label: "Actual margin", value: `${rs(f.actualMargin)}${f.actualMarginPct ? ` (${f.actualMarginPct}%)` : ""}` }] : []),
      ],
    },
  ];
  return {
    docType: "ACC",
    title: "Project Accounts Statement",
    number: `${project.code}-ACC`,
    date: formatDate(today),
    dateLabel: "As on",
    status: { label: "Statement", tone: "neutral" },
    final: false,
    org,
    panels,
    facts: [
      ...(c
        ? [
            { label: "Client billed", value: rs(c.invoiced) },
            { label: "Client received", value: rs(c.paymentReceived) },
            { label: "Client outstanding", value: rs(c.outstandingBilled), strong: true },
            { label: "Unbilled", value: rs(c.unbilled) },
          ]
        : []),
      { label: "PO commitments", value: rs(s.poValue) },
      { label: "Supplier bills", value: rs(s.supplierBills) },
      { label: "Supplier paid", value: rs(s.paymentsMade) },
      { label: "Supplier outstanding", value: rs(s.outstanding), strong: true },
    ],
    tableTitle: "Transactions",
    columns: [
      { key: "date", label: "Date", width: 11, nowrap: true },
      { key: "kind", label: "Type", width: 22 },
      { key: "number", label: "Document", width: 20 },
      { key: "party", label: "Party", width: 17 },
      { key: "flow", label: "Flow", width: 6, align: "center" },
      { key: "amount", label: "Amount", width: 14, align: "right", nowrap: true },
      { key: "status", label: "Status", width: 14, nowrap: true },
    ],
    rows: txns.map((t) => ({ date: formatDate(t.date), kind: t.kind, number: t.number, party: t.party ?? "—", flow: FLOW[t.flow] ?? "—", amount: t.amount === null ? "—" : rs(t.amount), status: humanize(t.status) })),
    emptyText: "No transactions recorded for this project yet.",
    totals: c
      ? [
          { label: "Contract value (incl. GST)", value: rs(c.contractValue), kind: "line" },
          { label: "Billed to client", value: rs(c.invoiced), kind: "line" },
          { label: "Received from client", value: rs(c.paymentReceived), kind: "deduction" },
          { label: "Client outstanding", value: rs(c.outstandingBilled), kind: "grand" },
          { label: "Advances held", value: rs(c.clientAdvances), kind: "info" },
          { label: "Remaining on contract", value: rs(c.remainingContract), kind: "info" },
        ]
      : [{ label: "Supplier outstanding", value: rs(s.outstanding), kind: "grand" }],
    sections: [
      {
        title: "Notes",
        items: [
          "Operational project accounts from approved documents — not a general ledger.",
          "Purchase orders are commitments, not expenses. Contract value is not revenue until invoiced.",
          "General-stock purchases count as project cost only when issued to this project.",
          `Prepared on ${formatDate(today)}; figures change as documents are approved.`,
        ],
      },
    ],
    signatures: [{ label: "Prepared by", name: preparer?.fullName ?? null }, { label: "Authorised signatory", company: true }],
  };
}
