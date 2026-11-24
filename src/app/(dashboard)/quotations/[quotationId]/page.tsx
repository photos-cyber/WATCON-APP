import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { NextStep } from "@/components/procurement/next-step";
import { QuotationActions } from "@/components/sales/quotation-actions";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { TRIGGERS, type Trigger } from "@/modules/commercial/payment-terms";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getQuotation, type QuotationSnapshot } from "@/modules/sales/quotation";

export const metadata: Metadata = { title: "Quotation" };

const COLORS = ["bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-teal-500"];

export default async function QuotationPage({ params }: PageProps<"/quotations/[quotationId]">) {
  const user = await requirePagePermission("so.view");
  const { quotationId } = await params;
  const { q, displayStatus, link, can } = await orNotFound(getQuotation(user, quotationId));
  const [files, activity] = await Promise.all([listAttachments(user, "client_quotation", q.id), entityActivity(user, "client_quotation", q.id)]);
  const intra = q.taxMode === "INTRA";

  const step = (() => {
    switch (displayStatus) {
      case "DRAFT":
        return <NextStep tone={q.statusNote ? "warn" : "action"} title={q.statusNote ? "Returned for correction" : "Draft — submit for approval"}>{q.statusNote ?? "Check items, rates and the payment schedule, then submit. The client should only see it after approval."}</NextStep>;
      case "PENDING_APPROVAL":
        return can.approve ? <NextStep title="Waiting for your approval">Approve to allow sharing with the client, or return it with a note.</NextStep> : <NextStep tone="info" title="Waiting for approval">{can.approveBlockedReason ?? "An approver will review it."}</NextStep>;
      case "APPROVED":
        return <NextStep title="Approved — share it with the client">Copy the client link, use WhatsApp or email. The client can view, download and accept with a code sent to their email.</NextStep>;
      case "SENT":
        return <NextStep tone="info" title="Sent — waiting for the client">The client has not opened the link yet. If they accept another way, use “Record acceptance”.</NextStep>;
      case "VIEWED":
        return <NextStep tone="info" title={`Client opened the link ${q.viewedAt ? formatDateTime(q.viewedAt) : ""}`}>Waiting for their decision.</NextStep>;
      case "EXPIRED":
        return <NextStep tone="warn" title="Validity has passed">The client can no longer accept online. Revise it with a new validity date to re-quote.</NextStep>;
      case "ACCEPTED":
        return <NextStep title="Accepted — convert it into a sales order">One click creates the sales order with the accepted items, rates and payment schedule — no re-entry.</NextStep>;
      case "REJECTED":
        return <NextStep tone="warn" title="Declined by the client">{q.rejectionReason ?? ""} You can revise and send again.</NextStep>;
      case "CONVERTED":
        return q.convertedSo ? <NextStep tone="done" title={`Converted into sales order ${q.convertedSo.number}`} links={[{ href: `/sales-orders/${q.convertedSo.id}`, label: "Open sales order" }]}>Billing follows the payment schedule on the sales order.</NextStep> : null;
      default:
        return null;
    }
  })();

  const snap = q.acceptedSnapshot as QuotationSnapshot | null;

  return (
    <>
      <PageHeader
        title={`${q.number}${q.revision ? ` · Rev ${q.revision}` : ""}`}
        description={q.subject ?? undefined}
        breadcrumbs={[{ label: "Quotations", href: "/quotations" }, { label: q.number }]}
        meta={
          <>
            <DocStatusBadge status={displayStatus} />
            <span className="text-sm text-muted-foreground">
              {q.party.name} · <Money value={q.total} />
            </span>
            <Link href={`/projects/${q.project.id}`} className="text-sm text-primary hover:underline">
              {q.project.code} – {q.project.name}
            </Link>
          </>
        }
        actions={<QuotationActions id={q.id} version={q.version} can={can} link={link} number={q.number} clientName={q.party.name} clientEmail={q.party.email} clientPhone={q.party.whatsappNumber ?? q.party.phone} totalLabel={formatINR(q.total)} validUntil={q.validUntil ? formatDate(q.validUntil) : null} />}
      />
      {step}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Quotation">
            <DetailGrid
              items={[
                { label: "Client", value: <span>{q.party.name}<span className="block text-xs text-muted-foreground">{q.party.gstin ?? "Unregistered"} · {stateName(q.party.stateCode)}</span></span> },
                { label: "Date / valid until", value: `${formatDate(q.quoteDate)} → ${formatDate(q.validUntil)}` },
                { label: "Tax", value: intra ? "CGST + SGST" : "IGST" },
                { label: "Prepared by", value: `${q.createdBy.fullName} · ${formatDate(q.createdAt)}` },
                { label: "Approved by", value: q.approvedBy ? `${q.approvedBy.fullName} · ${formatDate(q.approvedAt)}` : "—" },
                { label: "Shared", value: q.sentAt ? `${formatDateTime(q.sentAt)}${q.sentVia ? ` via ${q.sentVia}` : ""}${q.viewedAt ? ` · opened ${formatDateTime(q.viewedAt)}` : ""}` : "—" },
                { label: "Delivery terms", value: q.deliveryTerms, wide: true },
              ]}
            />
          </Section>

          <Section title="Items & services" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">#</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 font-medium">HSN/SAC</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Disc</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {q.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 text-muted-foreground">{l.lineNo}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{l.description}</span>
                        {l.brand && <span className="block text-xs text-muted-foreground">Brand: {l.brand}{l.itemBrand ? ` · ${l.itemBrand.item.code}` : ""}</span>}
                      </td>
                      <td className="px-3 py-2">{l.hsnSac ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}</td>
                      <td className="px-3 py-2 text-right">{Number(l.discountPct) ? `${Number(l.discountPct)}%` : "—"}</td>
                      <td className="px-3 py-2 text-right">{Number(l.gstRate)}%</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{formatINR(l.taxable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="ml-auto w-full max-w-xs space-y-1 border-t px-4 py-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Taxable value</dt><dd className="tabular-nums">{formatINR(q.taxable)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">{intra ? "CGST + SGST" : "IGST"}</dt><dd className="tabular-nums">{formatINR(q.taxAmount)}</dd></div>
              {Number(q.roundOff) !== 0 && <div className="flex justify-between"><dt className="text-muted-foreground">Round off</dt><dd className="tabular-nums">{formatINR(q.roundOff)}</dd></div>}
              <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{formatINR(q.total)}</dd></div>
            </dl>
          </Section>

          <Section title="Payment schedule">
            <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-muted">
              {q.milestones.map((m, i) => (
                <div key={m.id} className={`${COLORS[i % COLORS.length]} h-full`} style={{ width: `${Number(q.total) > 0 ? (Number(m.amount) / Number(q.total)) * 100 : 0}%` }} title={`${m.label}: ${formatINR(m.amount)}`} />
              ))}
            </div>
            <ul className="divide-y text-sm">
              {q.milestones.map((m, i) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${COLORS[i % COLORS.length]}`} />
                    <span className="font-medium">{m.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {TRIGGERS[m.trigger as Trigger] ?? m.trigger}
                      {m.dueDate ? ` · ${formatDate(m.dueDate)}` : ""}
                      {m.days !== null ? ` · ${m.days} days` : ""}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {m.basis === "PERCENT" && m.percent ? <span className="mr-3 text-muted-foreground">{m.percent}%</span> : null}
                    <span className="font-semibold">{formatINR(m.amount)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {q.paymentTermsText && <p className="mt-2 text-sm text-muted-foreground">{q.paymentTermsText}</p>}
          </Section>

          {q.terms && (
            <Section title="Terms & conditions">
              <p className="text-sm whitespace-pre-line">{q.terms}</p>
            </Section>
          )}

          {(q.acceptedAt || q.rejectedAt) && (
            <Section title="Client decision">
              {q.acceptedAt ? (
                <DetailGrid
                  items={[
                    { label: "Accepted", value: `${formatDateTime(q.acceptedAt)} · revision ${q.acceptedRevision ?? 0}` },
                    { label: "By", value: [q.acceptedByName, q.acceptedByRole, q.acceptedByEmail].filter(Boolean).join(" · ") },
                    { label: "How", value: q.acceptanceMethod === "CLIENT_LINK_OTP" ? `Online — verified by a one-time code sent to the client's email · IP ${q.acceptedIp ?? "—"}` : "Recorded by staff (evidence under Documents)" },
                    { label: "Note", value: q.acceptanceNote, wide: true },
                    { label: "Accepted value", value: snap ? formatINR(snap.total) : formatINR(q.total) },
                  ]}
                />
              ) : (
                <p className="text-sm">Declined {formatDateTime(q.rejectedAt!)} — {q.rejectionReason}</p>
              )}
            </Section>
          )}

          {q.revisions.length > 0 && (
            <Section title="Version history" bodyClassName="p-0">
              <ul className="divide-y text-sm">
                {q.revisions.map((r) => {
                  const s = r.snapshot as QuotationSnapshot;
                  return (
                    <li key={r.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                      <span>
                        <span className="font-medium">Revision {r.revision}</span>
                        <span className="text-muted-foreground"> · {s.lines.length} lines · {formatINR(s.total)}</span>
                        {r.reason && <span className="block text-xs text-muted-foreground">Revised because: {r.reason}</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs docs={q.convertedSo ? [{ type: "Sales order", id: q.convertedSo.id, number: q.convertedSo.number, status: q.convertedSo.status, href: `/sales-orders/${q.convertedSo.id}` }] : []} />
          <AttachmentsPanel entityType="client_quotation" entityId={q.id} data={files} currentUserId={user.id} title="Documents (signed copy, client emails)" />
        </div>
      </div>
    </>
  );
}
