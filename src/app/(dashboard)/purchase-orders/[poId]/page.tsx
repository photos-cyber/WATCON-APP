import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { can as can_ } from "@/lib/permissions/definitions";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, Section, SummaryCards } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep, ProjectTrace } from "@/components/procurement/next-step";
import { PoActions } from "@/components/procurement/po-actions";
import { docCrumbs } from "@/components/procurement/crumbs";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getPo } from "@/modules/procurement/po";
import { traceSalesOrders } from "@/modules/procurement/trace";

export const metadata: Metadata = { title: "Purchase order" };

const sum = (xs: string[]) => xs.reduce((a, x) => a + Number(x), 0);
const q = (n: number) => formatQty(String(Math.round(n * 1000) / 1000));
/** Quantities of different units are never added together: "4 Nos · 100 Mtr". */
const byUnit = (rows: { unit: string; qty: string }[]) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.unit, (m.get(r.unit) ?? 0) + Number(r.qty));
  return [...m].map(([u, n]) => `${q(n)} ${u}`).join(" · ") || "0";
};

export default async function PoPage({ params }: PageProps<"/purchase-orders/[poId]">) {
  const user = await requirePagePermission("po.view");
  const { poId } = await params;
  const { po, can, paidToDate, advanceOnPo, financial } = await orNotFound(getPo(user, poId));
  const [files, activity, salesOrders] = await Promise.all([listAttachments(user, "purchase_order", po.id), entityActivity(user, "purchase_order", po.id), traceSalesOrders(user, { prIds: [po.prId], prLineIds: po.lines.map((l) => l.prLineId), requirementIds: po.lines.map((l) => l.requirementId) })]);
  const received = sum(po.lines.map((l) => l.acceptedQty));
  const pending = sum(po.lines.map((l) => l.pendingQty));
  const intra = po.taxMode === "INTRA";
  const forOf = (l: (typeof po.lines)[number]) => l.requirement?.project?.code ?? (l.requirement ? "General stock" : null);
  const combined = !po.projectId && po.lines.some((l) => l.requirement?.project);
  const overdue = !!po.expectedDate && pending > 0 && new Date(po.expectedDate) < new Date() && !["DRAFT", "CANCELLED", "CLOSED"].includes(po.status);
  const summary = `Purchase Order ${po.number}${po.revision ? ` (Rev ${po.revision})` : ""}\nSupplier: ${po.party.name}\nDate: ${formatDate(po.orderDate)}\nDeliver to: ${po.deliveryLocation.name}\nExpected: ${formatDate(po.expectedDate)}\nValue: ${formatINR(po.total)}\n\nItems:\n${po.lines.map((l) => `• ${l.itemBrand.item.name} (${l.itemBrand.brand.name}) – ${formatQty(l.quantity)} ${l.unit} @ ₹${l.rate}`).join("\n")}\n\nPlease confirm acceptance. The PDF is attached.`;

  return (
    <>
      <PageHeader
        title={`${po.number}${po.revision ? ` · Rev ${po.revision}` : ""}`}
        breadcrumbs={docCrumbs(po.project, "purchase-orders", { label: po.number })}
        meta={
          <>
            <DocStatusBadge status={po.status} />
            <span className="text-sm text-muted-foreground">
              {po.party.name} · <Money value={po.total} />
            </span>
            {po.project ? <ProjectTrace project={po.project} salesOrders={salesOrders} tab="purchase-orders" /> : <span className="text-xs text-muted-foreground">{combined ? "Combined order (projects + general stock)" : "General stock"}</span>}
          </>
        }
        actions={
          <>
            <PoActions id={po.id} version={po.version} can={can} partyId={po.party.id} projectId={po.projectId} />
            {po.projectId && can_(user, "accounts.view") && financial && (
              <Button asChild size="sm" variant="ghost">
                <Link href={`/projects/${po.projectId}?tab=accounts`}>View accounts</Link>
              </Button>
            )}
            <DocShare type="purchase_order" id={po.id} summary={summary} phone={po.party.whatsappNumber ?? po.party.phone} email={po.party.email} subject={`Purchase Order ${po.number}`} />
          </>
        }
      />
      {(po.status === "DRAFT" || po.status === "REJECTED") && (
        <NextStep tone={po.status === "REJECTED" ? "warn" : "action"} title={po.status === "REJECTED" ? "Returned — make the changes and finalize again" : "Draft — check and finalize"}>
          {po.status === "REJECTED" ? (po.statusNote ?? "Edit the order and finalize it again.") : "Check supplier, rates and quantities, then press “Finalize PO”. It is final at once — share it with the supplier."}
        </NextStep>
      )}
      {po.status === "PENDING_APPROVAL" && <NextStep title="Finalize this order">{can.approve ? "It was waiting under the old approval step — press “Finalize PO” to send it to the supplier." : "A purchase user can finalize it."}</NextStep>}
      {["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"].includes(po.status) && (
        <NextStep tone="info" title={po.status === "APPROVED" ? "Finalized — share it with the supplier" : po.status === "PARTIALLY_RECEIVED" ? "Partly received — waiting for the rest" : "Waiting for delivery"} links={can.receive ? [{ href: `/site-receipts/new?poId=${po.id}`, label: "Receive material" }] : []}>
          {po.status === "APPROVED" ? "Download the PDF or share it on WhatsApp / email (top right). Material can be received against it as soon as it arrives." : "When material arrives, record the receipt; received quantity updates this order and stock."}
        </NextStep>
      )}
      {po.status === "FULLY_RECEIVED" && <NextStep tone="done" title="Fully received" links={can.bill ? [{ href: `/supplier-bills/new?poId=${po.id}`, label: "Record supplier bill" }] : []}>All ordered material has been received. Record the supplier’s bill to match it against these receipts.</NextStep>}
      {po.statusNote && !["REJECTED"].includes(po.status) && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{po.statusNote}</p>}

      <SummaryCards
        items={[
          { label: "Ordered", value: byUnit(po.lines.map((l) => ({ unit: l.unit, qty: l.quantity }))) },
          { label: "Received", value: received > 0 ? byUnit(po.lines.map((l) => ({ unit: l.unit, qty: l.acceptedQty }))) : "0", tone: received > 0 ? "good" : "default" },
          { label: "Pending", value: pending > 0 ? byUnit(po.lines.filter((l) => Number(l.pendingQty) > 0).map((l) => ({ unit: l.unit, qty: l.pendingQty }))) : "0", tone: pending > 0 ? (overdue ? "bad" : "warn") : "good" },
          { label: "Expected delivery", value: po.expectedDate ? formatDate(po.expectedDate) : "—", tone: overdue ? "bad" : "default", hint: overdue ? "overdue" : undefined },
          { label: "Purchase value", value: <Money value={po.total} />, hint: intra ? "incl. CGST + SGST" : "incl. IGST" },
          { label: "Paid", value: <Money value={paidToDate} />, hint: Number(advanceOnPo) > 0 ? `against bills · + ${formatINR(advanceOnPo)} advance` : "against supplier bills" },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          {financial && (
            <Section title="Financial summary">
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                {([
                  ["Total PO value", financial.poValue, "commitment, not a payable"],
                  ["Material received", financial.receivedValue, "accepted qty at PO rates"],
                  ["Pending material", financial.pendingValue],
                  ["Supplier billed", financial.billed, financial.heldBills ? `${financial.heldBills} bill(s) held on match` : "finalized bills"],
                  ["Paid to supplier", financial.paid, "bill payments + advance"],
                  ["Supplier advance", financial.advance, "paid on this PO, not yet set against bills"],
                  ["Outstanding bills", financial.outstanding],
                  ["Unbilled commitment", financial.unbilledCommitment],
                  ["Remaining to pay", financial.remainingPayment, "PO value − paid − adjusted"],
                ] as [string, string, string?][]).map(([l, v, hint]) => (
                  <div key={l}>
                    <dt className="text-xs text-muted-foreground">{l}</dt>
                    <dd className="font-semibold tabular-nums">{formatINR(v)}</dd>
                    {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
                  </div>
                ))}
              </dl>
            </Section>
          )}
          <Section title="Items" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Item – brand</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                    <th className="px-3 py-2 text-right font-medium">Pending</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {po.lines.map((l) => (
                    <tr key={l.id} className="align-top">
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.itemBrand.item.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.itemBrand.brand.name}
                          {forOf(l) ? ` · for ${forOf(l)}` : ""}
                          {l.description ? ` · ${l.description}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                        {l.acceptedQty !== "0" ? formatQty(l.acceptedQty) : "—"}
                        {l.rejectedQty !== "0" && <div className="text-xs text-rose-700">rejected {formatQty(l.rejectedQty)}</div>}
                        {l.returnedQty !== "0" && <div className="text-xs text-muted-foreground">returned {formatQty(l.returnedQty)}</div>}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{l.pendingQty !== "0" ? formatQty(l.pendingQty) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}{l.discountPct !== "0.00" && <div className="text-xs text-muted-foreground">−{Number(l.discountPct)}%</div>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(l.gstRate)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums"><Money value={l.total} />{l.billedQty !== "0" && <div className="text-xs text-muted-foreground">billed {formatQty(l.billedQty)}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <dl className="w-72 space-y-1 text-sm">
                {[["Taxable value", po.taxable], ...(po.charges !== "0.00" ? [["Freight / charges", po.charges]] : []), ...(intra ? [["CGST", po.cgst], ["SGST", po.sgst]] : [["IGST", po.igst]]), ...(po.roundOff !== "0.00" ? [["Round off", po.roundOff]] : [])].map(([l, v]) => (
                  <div key={l} className="flex justify-between">
                    <dt className="text-muted-foreground">{l}</dt>
                    <dd className="tabular-nums">{formatINR(v)}</dd>
                  </div>
                ))}
                <div className="flex justify-between border-t pt-1 text-base font-semibold">
                  <dt>Purchase value</dt>
                  <dd className="tabular-nums">{formatINR(po.total)}</dd>
                </div>
              </dl>
            </div>
          </Section>

          <Section title="Supplier, delivery & payment">
            <DetailGrid
              items={[
                { label: "Supplier", value: <Link className="hover:underline" href={`/parties/${po.party.id}`}>{po.party.name}</Link> },
                { label: "GSTIN / state", value: `${po.party.gstin ?? "Unregistered"} · ${stateName(po.party.stateCode)}` },
                { label: "Contact", value: [po.party.phone, po.party.email].filter(Boolean).join(" · ") || null },
                { label: "For", value: po.project ? `${po.project.code} – ${po.project.name}` : combined ? "Several projects / general stock (see lines)" : "General stock" },
                { label: "Deliver to", value: `${po.deliveryLocation.name}${po.deliveryAddress ? ` — ${po.deliveryAddress}` : ""}` },
                { label: "Order date / expected", value: `${formatDate(po.orderDate)} → ${formatDate(po.expectedDate)}` },
                { label: "Payment terms", value: [po.paymentTerms, po.creditDays !== null ? `${po.creditDays} days credit` : null].filter(Boolean).join(" · ") || null },
                { label: "Advance", value: po.advanceAmount !== "0.00" ? <Money value={po.advanceAmount} /> : "None" },
                { label: "Approved", value: po.approvedBy ? `${po.approvedBy.fullName} · ${formatDateTime(po.approvedAt)}` : "—" },
                { label: "Internal remarks", value: po.internalRemarks },
              ]}
            />
          </Section>

          {po.terms && (
            <Section title="Terms & conditions">
              <p className="text-sm whitespace-pre-line">{po.terms}</p>
            </Section>
          )}

          {po.revisions.length > 0 && (
            <Section title="Revision history" bodyClassName="p-0">
              <ul className="divide-y text-sm">
                {po.revisions.map((r) => {
                  const snap = r.snapshot as { total?: string; lines?: unknown[] };
                  return (
                    <li key={r.id} className="flex flex-wrap gap-x-3 px-4 py-2">
                      <span className="font-medium">Rev {r.revision}</span>
                      <span className="text-muted-foreground">{formatDateTime(r.createdAt)} · {r.createdBy.fullName}</span>
                      <span>Value then: {formatINR(String(snap.total ?? "0"))} ({snap.lines?.length ?? 0} lines)</span>
                      <span className="text-muted-foreground">— {r.reason}</span>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...salesOrders.map((s) => ({ type: "Sales order", id: s.id, number: s.number, href: `/sales-orders/${s.id}` })),
              ...(po.pr ? [{ type: "Requisition", id: po.pr.id, number: po.pr.number, href: `/purchase-requisitions/${po.pr.id}` }] : []),
              ...(po.rfq ? [{ type: "Rate enquiry", id: po.rfq.id, number: po.rfq.number, href: `/rate-enquiries/${po.rfq.id}` }] : []),
              ...po.grns.map((g) => ({ type: "Material receipt", id: g.id, number: g.number, status: g.status, href: `/site-receipts/${g.id}`, meta: formatDate(g.receiptDate) })),
              ...po.payments.map((p) => ({ type: "Supplier payment", id: p.id, number: p.number, href: `/payments/${p.id}`, meta: `${formatINR(p.amount)}${Number(p.unallocated) > 0 ? ` · advance ${formatINR(p.unallocated)}` : ""}` })),
              ...po.bills.map((b) => ({ type: "Supplier bill", id: b.id, number: b.number, status: b.status, href: `/supplier-bills/${b.id}`, meta: `${b.supplierInvoiceNo} · ${formatINR(b.total)}` })),
            ]}
          />
          <AttachmentsPanel entityType="purchase_order" entityId={po.id} data={files} currentUserId={user.id} defaultCategory="PURCHASE_ORDER" />
        </div>
      </div>
    </>
  );
}
