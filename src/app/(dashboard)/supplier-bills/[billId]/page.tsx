import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { NextStep } from "@/components/procurement/next-step";
import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, ProgressSegments, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { BillActions } from "@/components/payables/bill-actions";
import { payablesCrumbs } from "@/components/payables/crumbs";
import { ReverseAllocation } from "@/components/payables/payment-actions";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { can as canDo } from "@/lib/permissions/definitions";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getBill } from "@/modules/payables/bills";

export const metadata: Metadata = { title: "Supplier bill" };

export default async function BillPage({ params }: PageProps<"/supplier-bills/[billId]">) {
  const user = await requirePagePermission("bills.view");
  const { billId } = await params;
  const { bill: b, can, outstanding, overdue } = await orNotFound(getBill(user, billId));
  const [files, activity] = await Promise.all([listAttachments(user, "supplier_bill", b.id), entityActivity(user, "supplier_bill", b.id)]);
  const intra = b.taxMode === "INTRA";
  const net = Number(b.netPayable);
  const paid = Number(b.paidAmount);
  const adjusted = Number(b.adjustedAmount);
  const hasExceptions = b.exceptionList.length > 0;
  const summary = `Supplier bill ${b.number}\nSupplier: ${b.party.name}\nInvoice: ${b.supplierInvoiceNo} dated ${formatDate(b.invoiceDate)}\nNet payable: ${formatINR(b.netPayable)}\nOutstanding: ${formatINR(outstanding)}\nDue: ${formatDate(b.dueDate)}`;

  return (
    <>
      <PageHeader
        title={b.number}
        breadcrumbs={payablesCrumbs(b.project, "supplier-bills", b.number)}
        meta={
          <>
            <DocStatusBadge status={b.status} />
            {b.matchStatus !== "NOT_MATCHED" && <DocStatusBadge status={b.matchStatus} label={b.matchStatus === "MATCHED" ? "Matches PO" : "Differs from PO"} />}
            {overdue && <DocStatusBadge status="OVERDUE" />}
            <span className="text-sm text-muted-foreground">
              {b.party.name} · invoice {b.supplierInvoiceNo} · <Money value={b.total} />
            </span>
          </>
        }
        actions={
          <>
            <BillActions id={b.id} version={b.version} can={can} hasExceptions={hasExceptions} projectId={b.projectId} />
            <DocShare type="supplier_bill" id={b.id} summary={summary} subject={`Supplier bill ${b.number}`} />
          </>
        }
      />
      {(b.status === "DRAFT" || b.status === "REJECTED") && <NextStep title={b.status === "REJECTED" ? "Returned — correct and finalize" : "Draft — check and finalize"}>Check quantities and rates against the PO and receipts, attach the supplier&apos;s invoice, then press “Save &amp; finalize”. A matching bill is ready to pay at once.</NextStep>}
      {b.status === "PENDING_APPROVAL" && <NextStep tone={hasExceptions ? "warn" : "action"} title={hasExceptions ? "Held — the bill does not match the PO / receipts" : "Finalize this bill"}>{hasExceptions ? "Correct the bill (return it for correction), or a user allowed to accept differences can accept it with a reason." : "It was waiting under the old approval step — finalize it so it can be paid."}</NextStep>}
      {["APPROVED", "PARTIALLY_PAID"].includes(b.status) && <NextStep tone={overdue ? "warn" : "info"} title={`${formatINR(outstanding)} to pay`}>{b.dueDate ? `Due ${formatDate(b.dueDate)}.` : "No due date."} Any advance already paid on the PO can be set against this bill from the payment.</NextStep>}
      {b.status === "PAID" && <NextStep tone="done" title="Fully paid">Nothing more to do on this bill.</NextStep>}
      {b.statusNote && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{b.statusNote}</p>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title={b.po ? `Check against ${b.po.number}` : "Check"}>
            {!b.po ? (
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" />
                This bill is not linked to a purchase order, so there is nothing to match it against. The approver should check it against the work or service received.
              </p>
            ) : hasExceptions ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 font-medium text-amber-800">
                  <AlertTriangle className="size-4" />
                  {b.exceptionList.length} difference{b.exceptionList.length > 1 ? "s" : ""} from the purchase order / site receipts
                </p>
                <ul className="list-disc space-y-1 pl-6 text-sm">
                  {b.exceptionList.map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
                {b.overrideReason && (
                  <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                    Approved with override by {b.approvedBy?.fullName}: “{b.overrideReason}”
                  </p>
                )}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-emerald-800">
                <CheckCircle2 className="size-4" /> Quantities, rates and GST match the purchase order{b.lines.some((l) => l.grnLine) ? " and what was accepted at site" : ""}.
              </p>
            )}
          </Section>

          <Section title="Bill">
            <DetailGrid
              items={[
                { label: "Supplier", value: <Link className="hover:underline" href={`/parties/${b.party.id}`}>{b.party.name}</Link> },
                { label: "GSTIN on invoice", value: `${b.supplierGstin ?? "Unregistered"} · ${stateName(b.party.stateCode)}` },
                { label: "Tax", value: intra ? "CGST + SGST" : "IGST (inter-state)" },
                { label: "Project", value: b.project ? <Link className="hover:underline" href={`/projects/${b.project.id}?tab=supplier-bills`}>{b.project.code} – {b.project.name}</Link> : "—" },
                { label: "Purchase order", value: b.po ? <Link className="hover:underline" href={`/purchase-orders/${b.po.id}`}>{b.po.number}</Link> : "Without PO" },
                { label: "Invoice date / due", value: `${formatDate(b.invoiceDate)} → ${formatDate(b.dueDate)}` },
                { label: "TDS", value: b.tdsSection ? `${b.tdsSection} @ ${Number(b.tdsRate)}% = ${formatINR(b.tdsAmount)}` : "None" },
                { label: "Entered", value: `${b.createdBy.fullName} · ${formatDateTime(b.createdAt)}` },
                { label: "Approved", value: b.approvedBy ? `${b.approvedBy.fullName} · ${formatDateTime(b.approvedAt)}` : "—" },
                { label: "Remarks", value: b.remarks, wide: true },
              ]}
            />
          </Section>

          <Section title="Lines" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">PO rate</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {b.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.description}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.hsnCode ? `HSN ${l.hsnCode}` : ""}
                          {l.grnLine ? (
                            <>
                              {l.hsnCode ? " · " : ""}receipt <Link className="hover:underline" href={`/site-receipts/${l.grnLine.grn.id}`}>{l.grnLine.grn.number}</Link>
                            </>
                          ) : null}
                          {l.poLine ? ` · PO line ${l.poLine.lineNo}` : b.po ? " · not on PO" : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatQty(l.quantity)} {l.unit}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${l.poLine && Number(l.rate) > Number(l.poLine.rate) ? "font-medium text-rose-700" : "text-muted-foreground"}`}>{l.poLine ? formatINR(l.poLine.rate) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(l.gstRate)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <Money value={l.total} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <dl className="w-80 space-y-1 text-sm">
                {[["Taxable value", b.taxable], ...(b.charges !== "0.00" ? [["Freight / charges", b.charges]] : []), ...(intra ? [["CGST", b.cgst], ["SGST", b.sgst]] : [["IGST", b.igst]]), ...(b.roundOff !== "0.00" ? [["Round off", b.roundOff]] : [])].map(([l, v]) => (
                  <div key={l} className="flex justify-between">
                    <dt className="text-muted-foreground">{l}</dt>
                    <dd className="tabular-nums">{formatINR(v)}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t pt-1 font-semibold">
                  <dt>Invoice total</dt>
                  <dd className="tabular-nums">{formatINR(b.total)}</dd>
                </div>
                {b.tdsAmount !== "0.00" && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Less TDS</dt>
                    <dd className="tabular-nums">−{formatINR(b.tdsAmount)}</dd>
                  </div>
                )}
                <div className="flex justify-between text-base font-semibold">
                  <dt>Net payable</dt>
                  <dd className="tabular-nums">{formatINR(b.netPayable)}</dd>
                </div>
              </dl>
            </div>
          </Section>

          <Section title="Payments & adjustments" bodyClassName="p-0">
            <div className="border-b px-4 py-3">
              <ProgressSegments
                total={net || 1}
                segments={[
                  { label: `Paid ${formatINR(b.paidAmount)}`, value: paid, className: "bg-emerald-500" },
                  { label: `Notes ${formatINR(b.adjustedAmount)}`, value: adjusted, className: "bg-violet-400" },
                  { label: `Outstanding ${formatINR(outstanding)}`, value: 0, className: "bg-muted" },
                ]}
              />
            </div>
            {b.allocations.length === 0 && b.adjustmentNotes.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">{["APPROVED", "PARTIALLY_PAID"].includes(b.status) ? "Nothing paid yet." : "Payments can be recorded once the bill is approved."}</p>
            ) : (
              <ul className="divide-y text-sm">
                {b.allocations.map((a) => (
                  <li key={a.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 ${a.reversedAt ? "text-muted-foreground line-through decoration-1" : ""}`}>
                    <Link href={`/payments/${a.payment.id}`} className="font-medium hover:underline">
                      {a.payment.number}
                    </Link>
                    <span>{formatDate(a.payment.paymentDate)}</span>
                    <span className="text-muted-foreground">{a.payment.reference ?? a.payment.mode.replace(/_/g, " ").toLowerCase()}</span>
                    <span className="ml-auto tabular-nums">{formatINR(a.amount)}</span>
                    {a.reversedAt ? <span className="w-full text-xs no-underline">Reversed by {a.reversedBy?.fullName}: {a.reverseReason}</span> : canDo(user, "payments.manage") && <ReverseAllocation allocationId={a.id} label={b.number} />}
                  </li>
                ))}
                {b.adjustmentNotes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2">
                    <Link href={`/notes/${n.id}`} className="font-medium hover:underline">
                      {n.number}
                    </Link>
                    <span>{n.noteType === "CREDIT" ? "Credit note" : "Debit note"}</span>
                    <DocStatusBadge status={n.status} />
                    <span className="text-muted-foreground">{n.reason}</span>
                    <span className="ml-auto tabular-nums">{formatINR(n.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...(b.po ? [{ type: "Purchase order", id: b.po.id, number: b.po.number, status: b.po.status, href: `/purchase-orders/${b.po.id}` }] : []),
              ...[...new Map(b.lines.filter((l) => l.grnLine).map((l) => [l.grnLine!.grn.id, l.grnLine!.grn])).values()].map((g) => ({ type: "Site receipt", id: g.id, number: g.number, href: `/site-receipts/${g.id}` })),
            ]}
          />
          <AttachmentsPanel entityType="supplier_bill" entityId={b.id} data={files} currentUserId={user.id} defaultCategory="SUPPLIER_INVOICE" title="Invoice scan & documents" />
        </div>
      </div>
    </>
  );
}
