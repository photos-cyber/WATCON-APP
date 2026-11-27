import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, Section, SummaryCards } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep } from "@/components/procurement/next-step";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { CpoActions, MilestoneStatusSelect } from "@/components/sales/actions";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getClientPo } from "@/modules/sales/client-po";

export const metadata: Metadata = { title: "Client PO" };

export default async function ClientPoPage({ params }: PageProps<"/client-pos/[cpoId]">) {
  const user = await requirePagePermission("cpo.view");
  const { cpoId } = await params;
  const { cpo, summary, can } = await orNotFound(getClientPo(user, cpoId));
  const [files, activity] = await Promise.all([listAttachments(user, "client_po", cpo.id), entityActivity(user, "client_po", cpo.id)]);
  const intra = cpo.taxMode === "INTRA";
  const share = `Client PO ${cpo.clientPoNumber} (${cpo.number})\nClient: ${cpo.party.name}\nContract value: ${formatINR(cpo.total)}\n\nThe PDF is attached.`;
  return (
    <>
      <PageHeader
        title={`${cpo.clientPoNumber}${cpo.revision ? ` · Rev ${cpo.revision}` : ""}`}
        breadcrumbs={[...projectCrumbs(cpo.project, "client-pos"), { label: cpo.number }]}
        meta={
          <>
            <DocStatusBadge status={cpo.status} />
            <span className="text-sm text-muted-foreground">
              {cpo.party.name} · <Money value={cpo.total} />
            </span>
          </>
        }
        actions={
          <>
            <CpoActions id={cpo.id} version={cpo.version} can={can} />
            <DocShare type="client_po" id={cpo.id} summary={share} phone={cpo.party.whatsappNumber ?? cpo.party.phone} email={cpo.party.email} subject={`Client PO ${cpo.clientPoNumber}`} />
          </>
        }
      />
      {(cpo.status === "DRAFT" || cpo.status === "REJECTED") && <NextStep tone={cpo.status === "REJECTED" ? "warn" : "action"} title={cpo.status === "REJECTED" ? "Returned — correct and finalize" : "Draft — check and finalize"}>{cpo.status === "REJECTED" ? (cpo.statusNote ?? "Edit the contract and finalize it again.") : "Check the lines against the client's document, then press Finalize."}</NextStep>}
      {cpo.status === "PENDING_APPROVAL" && <NextStep title="Finalize this contract">{can.approve ? "It was waiting under the old approval step — press Finalize to make it the active contract." : "A sales user can finalize it."}</NextStep>}
      {cpo.status === "ACTIVE" && <NextStep tone="info" title="Active contract" links={[...(can.salesOrder ? [{ href: `/sales-orders/new?clientPoId=${cpo.id}`, label: "Create sales order" }] : []), ...(can.raBill ? [{ href: `/running-bills/new?projectId=${cpo.projectId}`, label: "New running bill" }] : [])]}>Optional reference. Bill through its sales orders (running bills are generated from the sales order); the client PO quantities stay as a ceiling.</NextStep>}
      {cpo.statusNote && cpo.status !== "REJECTED" && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{cpo.statusNote}</p>}
      <SummaryCards
        items={[
          { label: "Contract value", value: formatINR(summary.contract), hint: summary.variation !== "0.00" ? `${formatINR(summary.variation)} variation` : undefined },
          { label: "Certified", value: formatINR(summary.certified) },
          { label: "Invoiced", value: formatINR(summary.invoiced) },
          { label: "Received", value: formatINR(summary.received), tone: "good" },
          { label: "Outstanding", value: formatINR(summary.outstanding), tone: summary.outstanding !== "0.00" ? "warn" : "default" },
        ]}
      />
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Contract">
            <DetailGrid
              items={[
                { label: "Client", value: <Link className="hover:underline" href={`/parties/${cpo.party.id}`}>{cpo.party.name}</Link> },
                { label: "GSTIN / state", value: `${cpo.party.gstin ?? "Unregistered"} · ${stateName(cpo.party.stateCode)}` },
                { label: "Tax", value: intra ? "CGST + SGST" : "IGST (inter-state)" },
                { label: "Project", value: <Link className="hover:underline" href={`/projects/${cpo.project.id}`}>{cpo.project.code} – {cpo.project.name}</Link> },
                { label: "PO date", value: formatDate(cpo.poDate) },
                { label: "Contract period", value: `${formatDate(cpo.startDate)} → ${formatDate(cpo.endDate)}` },
                { label: "Payment terms", value: cpo.paymentTerms },
                { label: "Retention", value: Number(cpo.retentionPct) ? `${Number(cpo.retentionPct)}%` : "None" },
                { label: "Advance", value: cpo.advanceAmount !== "0.00" ? `${formatINR(cpo.advanceAmount)} (recover ${Number(cpo.advanceRecoveryPct)}% per bill)` : "None" },
                { label: "Created", value: `${cpo.createdBy.fullName} · ${formatDateTime(cpo.createdAt)}` },
                { label: "Approved", value: cpo.approvedBy ? `${cpo.approvedBy.fullName} · ${formatDateTime(cpo.approvedAt)}` : "—" },
                { label: "Delivery terms", value: cpo.deliveryTerms },
                { label: "Scope", value: cpo.scope, wide: true },
                { label: "Notes", value: cpo.notes, wide: true },
              ]}
            />
          </Section>

          <Section title="Contract lines & progress" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 text-right font-medium">On orders</th>
                    <th className="px-3 py-2 text-right font-medium">Certified</th>
                    <th className="px-3 py-2 text-right font-medium">Invoiced</th>
                    <th className="px-3 py-2 text-right font-medium">Billable left</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {cpo.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.description}</div>
                        <div className="text-xs text-muted-foreground">{[l.boqRef && `BOQ ${l.boqRef}`, l.hsnSac && `HSN/SAC ${l.hsnSac}`].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}{Number(l.discountPct) ? <div className="text-xs text-muted-foreground">−{Number(l.discountPct)}%</div> : null}</td>
                      <td className="px-3 py-2 text-right tabular-nums"><Money value={l.total} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.progress.ordered)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.progress.certified)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.progress.invoiced)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatQty(l.billable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <dl className="w-72 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Taxable value</dt><dd className="tabular-nums">{formatINR(cpo.taxable)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{intra ? "CGST + SGST" : "IGST"}</dt><dd className="tabular-nums">{formatINR(cpo.taxAmount)}</dd></div>
                <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{formatINR(cpo.total)}</dd></div>
              </dl>
            </div>
          </Section>

          {cpo.milestones.length > 0 && (
            <Section title="Payment milestones" bodyClassName="p-0">
              <ul className="divide-y text-sm">
                {cpo.milestones.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted-foreground">{m.percent ? `${Number(m.percent)}% · ${formatINR(((Number(cpo.total) * Number(m.percent)) / 100).toFixed(2))}` : formatINR(m.amount)}</span>
                    <span className="text-muted-foreground">{m.dueDate ? `due ${formatDate(m.dueDate)}` : ""}</span>
                    <span className="ml-auto"><MilestoneStatusSelect id={m.id} status={m.status} disabled={!can.milestones} /></span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {cpo.revisions.length > 0 && (
            <Section title="Revision history" bodyClassName="p-0">
              <ul className="divide-y text-sm">
                {cpo.revisions.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-3 px-4 py-2">
                    <span className="font-medium">Rev {r.revision}</span>
                    <span className="text-muted-foreground">{formatDateTime(r.createdAt)} · {r.createdBy.fullName}</span>
                    <span className="text-muted-foreground">— {r.reason}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...cpo.salesOrders.map((s) => ({ type: "Sales order", id: s.id, number: s.number, status: s.status, href: `/sales-orders/${s.id}`, meta: formatINR(s.total) })),
              ...cpo.raBills.map((r) => ({ type: "Running bill", id: r.id, number: `${r.number} (RA-${r.raNumber})`, status: r.status, href: `/running-bills/${r.id}`, meta: formatINR(r.claimedAmount) })),
              ...cpo.invoices.map((i) => ({ type: "Invoice", id: i.id, number: i.number, status: i.status, href: `/client-invoices/${i.id}`, meta: formatINR(i.total) })),
            ]}
          />
          <AttachmentsPanel entityType="client_po" entityId={cpo.id} data={files} currentUserId={user.id} defaultCategory="CLIENT_PO" />
        </div>
      </div>
    </>
  );
}
