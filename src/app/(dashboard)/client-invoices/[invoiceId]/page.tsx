import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, Section, ToneBadge } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep } from "@/components/procurement/next-step";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { InvoiceActions } from "@/components/sales/actions";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getClientInvoice } from "@/modules/sales/invoice";

export const metadata: Metadata = { title: "Client invoice" };

export default async function ClientInvoicePage({ params }: PageProps<"/client-invoices/[invoiceId]">) {
  const user = await requirePagePermission("invoice.view");
  const { invoiceId } = await params;
  const { invoice: inv, can } = await orNotFound(getClientInvoice(user, invoiceId));
  const [files, activity] = await Promise.all([listAttachments(user, "client_invoice", inv.id), entityActivity(user, "client_invoice", inv.id)]);
  const intra = inv.taxMode === "INTRA";
  const share = `Invoice ${inv.number}\nDate: ${formatDate(inv.invoiceDate)}\nAmount due: ${formatINR(inv.outstanding)}\nDue: ${formatDate(inv.dueDate)}\n\nThe PDF is attached.`;
  return (
    <>
      <PageHeader
        title={inv.number}
        breadcrumbs={[...projectCrumbs(inv.project, "invoices"), { label: inv.number }]}
        meta={
          <>
            <DocStatusBadge status={inv.status} />
            {inv.overdue && <ToneBadge tone="bad">Overdue</ToneBadge>}
            <span className="text-sm text-muted-foreground">
              {inv.party.name} · <Money value={inv.netReceivable} />
            </span>
          </>
        }
        actions={
          <>
            <InvoiceActions id={inv.id} version={inv.version} partyId={inv.partyId} projectId={inv.projectId} can={can} />
            <DocShare type="client_invoice" id={inv.id} summary={share} phone={inv.party.whatsappNumber ?? inv.party.phone} email={inv.party.email} subject={`Invoice ${inv.number}`} />
          </>
        }
      />
      {inv.status === "DRAFT" && <NextStep title="Draft — issue the invoice">{can.issue ? "Issuing allocates the GST invoice number and locks the invoice." : (can.issueBlocked ?? "An accounts user issues the invoice.")}</NextStep>}
      {["ISSUED", "PARTIALLY_PAID"].includes(inv.status) && <NextStep tone={inv.overdue ? "warn" : "info"} title={`${formatINR(inv.outstanding)} outstanding`}>{inv.dueDate ? `Due ${formatDate(inv.dueDate)}.` : "No due date set."}</NextStep>}
      {inv.statusNote && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{inv.statusNote}</p>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Invoice">
            <DetailGrid
              items={[
                { label: "Client", value: <Link className="hover:underline" href={`/parties/${inv.party.id}`}>{inv.party.name}</Link> },
                { label: "GSTIN / state", value: `${inv.party.gstin ?? "Unregistered"} · ${stateName(inv.party.stateCode)}` },
                { label: "Place of supply", value: inv.placeOfSupply ? stateName(inv.placeOfSupply) : "—" },
                { label: "Project", value: `${inv.project.code} – ${inv.project.name}` },
                { label: "Invoice date / due", value: `${formatDate(inv.invoiceDate)} → ${formatDate(inv.dueDate)}` },
                { label: "Raised from", value: inv.raBill ? <Link className="hover:underline" href={`/running-bills/${inv.raBill.id}`}>Running bill {inv.raBill.number} (RA-{inv.raBill.raNumber})</Link> : inv.so ? <Link className="hover:underline" href={`/sales-orders/${inv.so.id}`}>Sales order {inv.so.number}</Link> : inv.clientPo ? <Link className="hover:underline" href={`/client-pos/${inv.clientPo.id}`}>Client PO {inv.clientPo.clientPoNumber}</Link> : "—" },
                { label: "Created", value: `${inv.createdBy.fullName} · ${formatDateTime(inv.createdAt)}` },
                { label: "Issued", value: inv.issuedBy ? `${inv.issuedBy.fullName} · ${formatDateTime(inv.issuedAt)}` : "—" },
                { label: "Notes", value: inv.notes, wide: true },
              ]}
            />
          </Section>
          <Section title="Lines" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {inv.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                      <td className="px-3 py-2">{l.description}{l.hsnSac && <div className="text-xs text-muted-foreground">HSN/SAC {l.hsnSac}</div>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(l.gstRate)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums"><Money value={l.total} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <dl className="w-80 space-y-1 text-sm">
                {[["Taxable value", inv.taxable], ...(intra ? [["CGST", inv.cgst], ["SGST", inv.sgst]] : [["IGST", inv.igst]]), ...(inv.roundOff !== "0.00" ? [["Round off", inv.roundOff]] : [])].map(([l, v]) => (
                  <div key={l} className="flex justify-between"><dt className="text-muted-foreground">{l}</dt><dd className="tabular-nums">{formatINR(v)}</dd></div>
                ))}
                <div className="flex justify-between border-t pt-1 font-semibold"><dt>Invoice total</dt><dd className="tabular-nums">{formatINR(inv.total)}</dd></div>
                {inv.retentionAmount !== "0.00" && <div className="flex justify-between"><dt className="text-muted-foreground">Retention</dt><dd className="tabular-nums">− {formatINR(inv.retentionAmount)}</dd></div>}
                {inv.advanceRecovery !== "0.00" && <div className="flex justify-between"><dt className="text-muted-foreground">Advance recovery</dt><dd className="tabular-nums">− {formatINR(inv.advanceRecovery)}</dd></div>}
                {inv.otherDeductions !== "0.00" && <div className="flex justify-between"><dt className="text-muted-foreground">Other deductions</dt><dd className="tabular-nums">− {formatINR(inv.otherDeductions)}</dd></div>}
                <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Net receivable</dt><dd className="tabular-nums">{formatINR(inv.netReceivable)}</dd></div>
                <div className="flex justify-between text-xs text-muted-foreground"><dt>Received</dt><dd className="tabular-nums">{formatINR(inv.receivedAmount)}</dd></div>
                <div className="flex justify-between text-sm font-medium"><dt>Outstanding</dt><dd className="tabular-nums">{formatINR(inv.outstanding)}</dd></div>
              </dl>
            </div>
          </Section>
          {inv.allocations.length > 0 && (
            <Section title="Receipts against this invoice" bodyClassName="p-0">
              <ul className="divide-y text-sm">
                {inv.allocations.map((a) => (
                  <li key={a.id} className="flex flex-wrap gap-x-4 px-4 py-2">
                    <Link className="font-medium hover:underline" href={`/payments/${a.payment.id}`}>{a.payment.number}</Link>
                    <span className="text-muted-foreground">{formatDate(a.payment.paymentDate)} · {a.payment.mode.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="ml-auto tabular-nums">{formatINR(a.amount)}</span>
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
              ...(inv.raBill ? [{ type: "Running bill", id: inv.raBill.id, number: inv.raBill.number, href: `/running-bills/${inv.raBill.id}` }] : []),
              ...(inv.so ? [{ type: "Sales order", id: inv.so.id, number: inv.so.number, href: `/sales-orders/${inv.so.id}` }] : []),
              ...(inv.clientPo ? [{ type: "Client PO", id: inv.clientPo.id, number: inv.clientPo.number, href: `/client-pos/${inv.clientPo.id}` }] : []),
            ]}
          />
          <AttachmentsPanel entityType="client_invoice" entityId={inv.id} data={files} currentUserId={user.id} defaultCategory="SIGNED_DOCUMENT" />
        </div>
      </div>
    </>
  );
}
