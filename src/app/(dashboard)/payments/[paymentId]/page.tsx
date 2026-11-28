import type { Metadata } from "next";
import { NextStep } from "@/components/procurement/next-step";
import Link from "next/link";
import { DetailGrid, DocStatusBadge, Money, Section, ToneBadge } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { payablesCrumbs } from "@/components/payables/crumbs";
import { AllocateAdvance, PaymentActions, RefundAdvance, ReverseAllocation } from "@/components/payables/payment-actions";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { outstandingBills } from "@/modules/payables/bills";
import { PAYMENT_MODE_LABELS, getPayment, outstandingInvoices } from "@/modules/payables/payments";

export const metadata: Metadata = { title: "Payment" };

export default async function PaymentPage({ params }: PageProps<"/payments/[paymentId]">) {
  const user = await requirePagePermission("payments.view");
  const { paymentId } = await params;
  const { payment: p, unallocated, can } = await orNotFound(getPayment(user, paymentId));
  const out = p.direction === "OUT";
  const [files, activity, openDocs] = await Promise.all([
    listAttachments(user, "payment", p.id),
    entityActivity(user, "payment", p.id),
    can.allocate ? (out ? outstandingBills(user, p.partyId, p.projectId) : outstandingInvoices(user, p.partyId, p.projectId)) : Promise.resolve([]),
  ]);
  const summary = `${out ? "Payment" : "Receipt"} ${p.number}\n${out ? "Paid to" : "Received from"}: ${p.party.name}\nDate: ${formatDate(p.paymentDate)}\nAmount: ${formatINR(p.gross)}\nMode: ${PAYMENT_MODE_LABELS[p.mode]}${p.reference ? ` (${p.reference})` : ""}${p.allocations.filter((a) => !a.reversedAt).length ? `\nAgainst: ${p.allocations.filter((a) => !a.reversedAt).map((a) => a.supplierBill?.supplierInvoiceNo ?? a.clientInvoice?.number).join(", ")}` : ""}`;
  return (
    <>
      <PageHeader
        title={p.number}
        breadcrumbs={payablesCrumbs(p.project, out ? "payments" : "receipts", p.number)}
        meta={
          <>
            <DocStatusBadge status={p.status} />
            <span className="text-sm text-muted-foreground">
              {out ? "Paid to" : "Received from"} {p.party.name} · <Money value={p.gross} />
            </span>
            {unallocated !== "0.00" && <ToneBadge tone="warn">Advance {formatINR(unallocated)}</ToneBadge>}
          </>
        }
        actions={
          <>
            {can.allocate && <AllocateAdvance paymentId={p.id} unallocated={unallocated} docs={openDocs} direction={p.direction} />}
            {can.refund && <RefundAdvance receiptId={p.id} unallocated={unallocated} today={new Date().toISOString().slice(0, 10)} />}
            <PaymentActions id={p.id} version={p.version} can={can} />
            <DocShare type="payment" id={p.id} summary={summary} phone={p.party.whatsappNumber ?? p.party.phone} email={p.party.email} subject={`${out ? "Payment advice" : "Receipt"} ${p.number}`} />
          </>
        }
      />
      {p.refundOf && (
        <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          Refund of client advance from receipt <Link className="font-medium text-primary hover:underline" href={`/payments/${p.refundOf.id}`}>{p.refundOf.number}</Link>{p.remarks ? ` — ${p.remarks}` : ""}.
        </p>
      )}
      {p.refunds.length > 0 && (
        <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          Refunded: {p.refunds.map((r, i) => (
            <span key={r.id}>{i ? ", " : ""}<Link className="text-primary hover:underline" href={`/payments/${r.id}`}>{r.number}</Link> {formatINR(r.amount)}{r.status === "CANCELLED" ? " (cancelled)" : ""}</span>
          ))}
        </p>
      )}
      {p.status === "CANCELLED" && (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm">
          Cancelled by {p.cancelledBy?.fullName} on {formatDateTime(p.cancelledAt)}: {p.cancelReason}
        </p>
      )}
      {p.status === "POSTED" && !p.refundOf && (unallocated !== "0.00" ? (
        <NextStep tone="warn" title={`${formatINR(unallocated)} held as an advance`}>{!out && !openDocs.length ? "There is no issued invoice for this client on this project yet. It will be set against the next invoice automatically when that invoice is issued (e.g. “Client accepted — invoice now” on the running bill)." : can.allocate ? "Use “Allocate advance” to set it against " + (out ? "the supplier's bills" : "the client's invoices") + " when they are ready." : out ? "It will be set against the supplier's bills." : "It will be set against the client's invoices or recovered on running bills."}</NextStep>
      ) : (
        <NextStep tone="done" title={out ? "Fully set against bills" : "Fully set against invoices"}>Download or share the {out ? "payment voucher" : "receipt"} (top right).</NextStep>
      ))}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title={out ? "Payment" : "Receipt"}>
            <DetailGrid
              items={[
                { label: out ? "Supplier" : "Client", value: <Link className="hover:underline" href={`/parties/${p.party.id}`}>{p.party.name}</Link> },
                { label: "Project", value: p.project ? <Link className="hover:underline" href={`/projects/${p.project.id}?tab=${out ? "payments" : "receipts"}`}>{p.project.code} – {p.project.name}</Link> : "—" },
                { label: "Date", value: formatDate(p.paymentDate) },
                { label: "Mode", value: PAYMENT_MODE_LABELS[p.mode] },
                { label: p.mode === "CHEQUE" ? "Cheque no." : "Reference / UTR", value: p.reference },
                { label: "Bank account", value: p.bankAccount },
                { label: out ? "Amount paid" : "Amount received", value: <Money value={p.amount} /> },
                ...(out ? [] : [{ label: "TDS deducted by client", value: <Money value={p.tdsAmount} /> }]),
                { label: "Allocated / advance", value: `${formatINR(p.allocatedAmount)} / ${formatINR(unallocated)}` },
                { label: "Recorded", value: `${p.createdBy.fullName} · ${formatDateTime(p.createdAt)}` },
                { label: "Remarks", value: p.remarks, wide: true },
              ]}
            />
          </Section>
          <Section title={out ? "Bills paid" : "Invoices settled"} bodyClassName="p-0">
            {p.allocations.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Not allocated yet — the whole amount is an advance{can.allocate && openDocs.length ? ". Use “Allocate advance” to set it against a document." : "."}</p>
            ) : (
              <ul className="divide-y text-sm">
                {p.allocations.map((a) => {
                  const doc = a.supplierBill ? { href: `/supplier-bills/${a.supplierBill.id}`, label: `${a.supplierBill.number} (invoice ${a.supplierBill.supplierInvoiceNo})` } : a.clientInvoice ? { href: `/client-invoices/${a.clientInvoice.id}`, label: a.clientInvoice.number } : null;
                  return (
                    <li key={a.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 ${a.reversedAt ? "text-muted-foreground" : ""}`}>
                      {doc && (
                        <Link className={`font-medium hover:underline ${a.reversedAt ? "line-through" : ""}`} href={doc.href}>
                          {doc.label}
                        </Link>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {a.allocatedBy.fullName} · {formatDateTime(a.allocatedAt)}
                      </span>
                      <span className={`ml-auto tabular-nums ${a.reversedAt ? "line-through" : ""}`}>{formatINR(a.amount)}</span>
                      {a.reversedAt ? <span className="w-full text-xs">Reversed by {a.reversedBy?.fullName} on {formatDateTime(a.reversedAt)}: {a.reverseReason}</span> : can.reverse && <ReverseAllocation allocationId={a.id} label={doc?.label ?? "this document"} />}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <AttachmentsPanel entityType="payment" entityId={p.id} data={files} currentUserId={user.id} defaultCategory="PAYMENT_PROOF" title="Payment proof" />
        </div>
      </div>
    </>
  );
}
