import { GitPullRequestArrow, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, ProgressSegments, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep } from "@/components/procurement/next-step";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { PendingAmendment, RevisionHistory, type AmendmentView } from "@/components/sales/amendment-ui";
import { SoActions } from "@/components/sales/actions";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { stateName } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { procurementForSalesOrder, visibleTraced } from "@/modules/procurement/trace";
import { getSalesOrder } from "@/modules/sales/sales-order";
import { SoBilling } from "@/components/sales/so-billing";
import { db } from "@/lib/db";
import { todayString } from "@/modules/inventory/serialize";
import { getSoBilling } from "@/modules/sales/milestone-billing";
import { listPaymentTemplates } from "@/modules/sales/quotation";

export const metadata: Metadata = { title: "Sales order" };

type L = Record<string, unknown>;
const toLines = (rows: L[]) => rows.map((l) => ({ id: (l.id as string | null) ?? null, itemBrandId: (l.itemBrandId as string | null) ?? null, description: (l.description as string | null) ?? null, unit: (l.unit as string | null) ?? null, quantity: String(l.quantity ?? "0"), rate: String(l.rate ?? "0"), gstRate: String(l.gstRate ?? "0") }));

export default async function SalesOrderPage({ params }: PageProps<"/sales-orders/[soId]">) {
  const user = await requirePagePermission("so.view");
  const { soId } = await params;
  const { so, fulfilment, pendingRequest, can } = await orNotFound(getSalesOrder(user, soId));
  const itemBrandIds = [...new Set(so.lines.map((l) => l.itemBrandId).filter((x): x is string => !!x))];
  const [files, activity, procurement, billing, templates, sourceQuote] = await Promise.all([
    listAttachments(user, "sales_order", so.id),
    entityActivity(user, "sales_order", so.id),
    procurementForSalesOrder(user.organizationId, so.projectId, itemBrandIds).then((d) => visibleTraced(user, d)),
    getSoBilling(user, so.id),
    listPaymentTemplates(user),
    db.clientQuotation.findUnique({ where: { convertedSoId: so.id }, select: { id: true, number: true, status: true } }),
  ]);
  const intra = so.taxMode === "INTRA";
  const locked = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED"].includes(so.status);
  const fMap = new Map(fulfilment.map((f) => [f.lineId, f]));
  const totalQty = so.lines.reduce((a, l) => a + Number(l.quantity), 0);
  const delivered = so.lines.reduce((a, l) => a + Number(l.deliveredQty) - Number(l.returnedQty), 0);

  const views: AmendmentView[] = so.amendmentRequests.map((r) => ({
    id: r.id,
    requestNo: r.requestNo,
    status: r.status,
    reason: r.reason,
    requestedBy: r.requestedBy.fullName,
    requestedAt: r.requestedAt.toISOString(),
    decidedBy: r.decidedBy?.fullName ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    appliedRevision: r.appliedRevision,
    beforeTotal: String(r.beforeSnapshot.header.total ?? "0"),
    afterTotal: String(r.proposed.header.total ?? "0"),
    before: toLines(r.beforeSnapshot.lines),
    after: toLines(r.proposed.lines as L[]),
  }));
  const pendingView = pendingRequest ? views.find((v) => v.id === pendingRequest.id) : undefined;
  const summary = `Sales Order ${so.number}${so.revision ? ` (Rev ${so.revision})` : ""}\nClient: ${so.party.name}\nDate: ${formatDate(so.orderDate)}\nValue: ${formatINR(so.total)}\n\n${so.lines.map((l) => `• ${l.description ?? l.itemBrand?.item.name ?? "Item"} – ${formatQty(l.quantity)} ${l.unit ?? ""} @ ₹${l.rate}`).join("\n")}\n\nThe PDF is attached.`;

  return (
    <>
      <PageHeader
        title={`${so.number}${so.revision ? ` · Rev ${so.revision}` : ""}`}
        breadcrumbs={[...projectCrumbs(so.project, "sales-orders"), { label: so.number }]}
        meta={
          <>
            <DocStatusBadge status={so.status} />
            {locked && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Lock className="size-3" /> Locked
              </span>
            )}
            <span className="text-sm text-muted-foreground">
              {so.party.name} · <Money value={so.total} />
            </span>
          </>
        }
        actions={
          <>
            {can.requestAmendment && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/sales-orders/${so.id}/amend`}>
                  <GitPullRequestArrow /> Request amendment
                </Link>
              </Button>
            )}
            <SoActions id={so.id} version={so.version} projectId={so.projectId} partyId={so.partyId} can={can} />
            <DocShare type="sales_order" id={so.id} summary={summary} phone={so.party.whatsappNumber ?? so.party.phone} email={so.party.email} subject={`Sales Order ${so.number}`} />
          </>
        }
      />

      {pendingView && <PendingAmendment request={pendingView} canDecide={can.decideAmendment} canWithdraw={can.withdrawAmendment} />}
      {(so.status === "DRAFT" || so.status === "REJECTED") && <NextStep tone={so.status === "REJECTED" ? "warn" : "action"} title={so.status === "REJECTED" ? "Rejected — make the changes and resubmit" : "Draft — submit for approval"}>{so.status === "REJECTED" ? (so.statusNote ?? "Edit the order and submit it again.") : "Check lines and rates, then submit. Approval locks the order and feeds material planning."}</NextStep>}
      {so.status === "PENDING_APPROVAL" && (can.approve ? <NextStep title="Waiting for your approval">Approving locks the order and creates the project&apos;s material requirements.</NextStep> : <NextStep tone="info" title="Waiting for approval">{can.approveBlockedReason ?? "An approver will review this order."}</NextStep>)}
      {locked && !pendingView && <NextStep tone="info" title="Approved and locked" links={[...(can.planning ? [{ href: `/projects/${so.projectId}?tab=planning`, label: "Material planning" }] : []), ...(can.deliver ? [{ href: `/challans/new?type=CLIENT_DELIVERY&soId=${so.id}&projectId=${so.projectId}&partyId=${so.partyId}`, label: "Deliver" }] : [])]}>Nobody can edit this order directly. To change it, request an amendment — a Super Admin approves it and the revision number goes up.</NextStep>}
      {so.statusNote && so.status !== "REJECTED" && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{so.statusNote}</p>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Order">
            <DetailGrid
              items={[
                { label: "Client", value: <Link className="hover:underline" href={`/parties/${so.party.id}`}>{so.party.name}</Link> },
                { label: "GSTIN / state", value: `${so.party.gstin ?? "Unregistered"} · ${stateName(so.party.stateCode)}` },
                { label: "Tax", value: intra ? "CGST + SGST" : "IGST (inter-state)" },
                { label: "Project", value: <Link className="hover:underline" href={`/projects/${so.project.id}`}>{so.project.code} – {so.project.name}</Link> },
                { label: "Client PO", value: so.clientPo ? <Link className="hover:underline" href={`/client-pos/${so.clientPo.id}`}>{so.clientPo.number} · {so.clientPo.clientPoNumber}</Link> : "Not linked" },
                { label: "Order date / deliver by", value: `${formatDate(so.orderDate)} → ${formatDate(so.deliveryDate)}` },
                { label: "Delivery address", value: so.deliveryAddress },
                { label: "Delivery schedule", value: so.deliverySchedule },
                { label: "Billing schedule", value: so.billingSchedule },
                { label: "Payment terms", value: so.paymentTerms },
                { label: "Created", value: `${so.createdBy.fullName} · ${formatDateTime(so.createdAt)}` },
                { label: "Approved", value: so.approvedBy ? `${so.approvedBy.fullName} · ${formatDateTime(so.approvedAt)}` : "—" },
                { label: "Notes", value: so.notes, wide: true },
              ]}
            />
          </Section>

          <Section title="Lines" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">Qty</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {so.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.description ?? l.itemBrand?.item.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.itemBrand
                            ? (l.description === `${l.itemBrand.item.name} – ${l.itemBrand.brand.name}` ? "Material" : `${l.itemBrand.item.name} – ${l.itemBrand.brand.name}`)
                            : "Service / non-stock"}
                          {l.hsnSac ? ` · HSN/SAC ${l.hsnSac}` : ""}
                          {l.clientPoLine ? ` · contract line ${l.clientPoLine.lineNo}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)} {l.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}{l.discountPct !== "0.00" && <div className="text-xs text-muted-foreground">−{Number(l.discountPct)}%</div>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Number(l.gstRate)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums"><Money value={l.total} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <dl className="w-72 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">Taxable value</dt><dd className="tabular-nums">{formatINR(so.taxable)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{intra ? "CGST + SGST" : "IGST"}</dt><dd className="tabular-nums">{formatINR(so.taxAmount)}</dd></div>
                <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular-nums">{formatINR(so.total)}</dd></div>
              </dl>
            </div>
          </Section>

          {so.status !== "DRAFT" && so.status !== "REJECTED" && so.status !== "PENDING_APPROVAL" && (
            <Section title="Fulfilment" bodyClassName="p-0" id="fulfilment">
              <div className="border-b px-4 py-3">
                <ProgressSegments
                  total={totalQty}
                  segments={[
                    { label: `Delivered ${formatQty(String(delivered))}`, value: delivered, className: "bg-emerald-500" },
                    { label: `Pending ${formatQty(String(Math.max(0, totalQty - delivered)))}`, value: 0, className: "bg-muted" },
                  ]}
                />
                <p className="mt-1 text-xs text-muted-foreground">Material is requisitioned and bought project-wide; each column counts that item–brand across the project.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Line</th>
                      <th className="px-3 py-2 text-right font-medium">Ordered</th>
                      <th className="px-3 py-2 text-right font-medium">Requisitioned</th>
                      <th className="px-3 py-2 text-right font-medium">Purchased</th>
                      <th className="px-3 py-2 text-right font-medium">Received</th>
                      <th className="px-3 py-2 text-right font-medium">Delivered</th>
                      <th className="px-3 py-2 text-right font-medium">Invoiced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {so.lines.map((l) => {
                      const f = fMap.get(l.id);
                      const mat = !!l.itemBrandId;
                      return (
                        <tr key={l.id}>
                          <td className="px-3 py-2">{l.lineNo}. {l.description ?? l.itemBrand?.item.name}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{mat && f ? formatQty(f.requisitioned) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{mat && f ? formatQty(f.ordered) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{mat && f ? formatQty(f.received) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{f ? formatQty(f.delivered) : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{f ? formatQty(f.invoiced) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <SoBilling soId={so.id} billing={billing} today={todayString()} savedTemplates={templates} />
          <Section title="Revision history & amendments" id="amendments">
            <RevisionHistory requests={views.filter((v) => v.id !== pendingView?.id)} hasPending={Boolean(pendingView)} />
          </Section>
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...(sourceQuote ? [{ type: "Quotation", id: sourceQuote.id, number: sourceQuote.number, status: sourceQuote.status, href: `/quotations/${sourceQuote.id}` }] : []),
              ...(so.clientPo ? [{ type: "Client PO", id: so.clientPo.id, number: so.clientPo.number, href: `/client-pos/${so.clientPo.id}` }] : []),
              ...procurement,
              ...so.challans.map((c) => ({ type: "Delivery challan", id: c.id, number: c.number, status: c.status, href: `/challans/${c.id}`, meta: formatDate(c.dispatchDate) })),
              ...so.invoices.map((i) => ({ type: "Invoice", id: i.id, number: i.number, status: i.status, href: `/client-invoices/${i.id}`, meta: formatINR(i.total) })),
            ]}
          />
          <AttachmentsPanel entityType="sales_order" entityId={so.id} data={files} currentUserId={user.id} defaultCategory="SIGNED_DOCUMENT" />
        </div>
      </div>
    </>
  );
}
