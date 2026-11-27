import type { Metadata } from "next";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep, ProjectTrace } from "@/components/procurement/next-step";
import { PrActions } from "@/components/procurement/pr-ui";
import { docCrumbs } from "@/components/procurement/crumbs";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getPr } from "@/modules/procurement/pr";
import { procurementForRequisition, traceSalesOrders, visibleTraced } from "@/modules/procurement/trace";

export const metadata: Metadata = { title: "Requisition" };

export default async function PrPage({ params }: PageProps<"/purchase-requisitions/[prId]">) {
  const user = await requirePagePermission("pr.view");
  const { prId } = await params;
  const { pr, can } = await orNotFound(getPr(user, prId));
  const [files, activity, salesOrders, traced] = await Promise.all([
    listAttachments(user, "purchase_requisition", pr.id),
    entityActivity(user, "purchase_requisition", pr.id),
    traceSalesOrders(user, { prIds: [pr.id] }),
    procurementForRequisition(user.organizationId, pr.id).then((d) => visibleTraced(user, d)),
  ]);
  // Header links (pr.rfqs / pr.purchaseOrders) plus documents reached through the PR's lines
  // (e.g. POs created from an RFQ award), de-duplicated.
  const related = new Map<string, { type: string; id: string; number: string; status?: string; href: string }>();
  for (const s of salesOrders) related.set(`so:${s.id}`, { type: "Sales order", id: s.id, number: s.number, href: `/sales-orders/${s.id}` });
  for (const r of pr.rfqs) related.set(`Rate enquiry:${r.id}`, { type: "Rate enquiry", id: r.id, number: r.number, status: r.status, href: `/rate-enquiries/${r.id}` });
  for (const p of pr.purchaseOrders) related.set(`Purchase order:${p.id}`, { type: "Purchase order", id: p.id, number: p.number, status: p.status, href: `/purchase-orders/${p.id}` });
  for (const d of traced) related.set(`${d.type}:${d.id}`, d);
  const summary = `Purchase requisition ${pr.number}${pr.project ? ` – ${pr.project.name}` : ""}\n${pr.lines.map((l) => `• ${l.itemBrand.item.name} (${l.itemBrand.brand.name}) – ${formatQty(l.quantity)} ${l.itemBrand.item.unit}`).join("\n")}`;
  return (
    <>
      <PageHeader
        title={pr.number}
        breadcrumbs={docCrumbs(pr.project, "requisitions", { label: pr.number })}
        meta={<><DocStatusBadge status={pr.status} /><ProjectTrace project={pr.project} salesOrders={salesOrders} tab="requisitions" /></>}
        actions={<><PrActions id={pr.id} version={pr.version} can={can} /><DocShare type="purchase_requisition" id={pr.id} summary={summary} subject={`Requisition ${pr.number}`} /></>}
      />
      {pr.status === "DRAFT" && <NextStep title="Draft — not yet submitted">Check the items and quantities, then submit it so it can be approved.</NextStep>}
      {pr.status === "SUBMITTED" && <NextStep title="Finalize this requisition">{can.approve ? "It was waiting under the old approval step — finalize it so purchasing can order it." : "A purchase user can finalize it."}</NextStep>}
      {pr.status === "REJECTED" && <NextStep tone="warn" title="Rejected — needs changes">{pr.statusNote ?? "Edit and resubmit."}</NextStep>}
      {(pr.status === "APPROVED" || pr.status === "PARTIALLY_ORDERED") && <NextStep title={pr.status === "APPROVED" ? "Approved — next: get rates or order" : "Partly ordered — the rest still needs ordering"} links={[...(can.rfq ? [{ href: `/rate-enquiries/new?prId=${pr.id}`, label: "Request rates" }] : []), ...(can.po ? [{ href: `/purchase-orders/new?prId=${pr.id}`, label: "Create purchase order" }] : [])]}>Request quotations from suppliers when you need to compare prices, or raise a purchase order directly if the supplier and rate are known.</NextStep>}
      {pr.status === "ORDERED" && <NextStep tone="done" title="Fully ordered">Track deliveries on the linked purchase orders.</NextStep>}
      {pr.statusNote && !["REJECTED"].includes(pr.status) && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{pr.statusNote}</p>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Details">
            <DetailGrid items={[
              { label: "Deliver to", value: pr.deliveryLocation?.name },
              { label: "Required by", value: formatDate(pr.requiredBy) },
              { label: "Raised by", value: `${pr.createdBy.fullName} · ${formatDateTime(pr.createdAt)}` },
              { label: "Submitted", value: pr.submittedBy ? `${pr.submittedBy.fullName} · ${formatDateTime(pr.submittedAt)}` : "—" },
              { label: "Approved", value: pr.approvedBy ? `${pr.approvedBy.fullName} · ${formatDateTime(pr.approvedAt)}` : "—" },
              { label: "Purpose", value: pr.purpose, wide: true },
            ]} />
          </Section>
          <Section title="Lines" bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left font-medium">#</th><th className="px-3 py-2 text-left font-medium">Item – brand</th><th className="px-3 py-2 text-right font-medium">Requested</th><th className="px-3 py-2 text-right font-medium">Ordered</th><th className="px-3 py-2 text-left font-medium">Required by</th></tr></thead>
              <tbody className="divide-y">
                {pr.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNo}</td>
                    <td className="px-3 py-2"><div className="font-medium">{l.itemBrand.item.name}</div><div className="text-xs text-muted-foreground">{l.itemBrand.brand.name}{l.notes ? ` · ${l.notes}` : ""}</div></td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity)} {l.itemBrand.item.unit}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.orderedQty)}</td>
                    <td className="px-3 py-2">{formatDate(l.requiredBy ?? pr.requiredBy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs docs={[...related.values()]} />
          <AttachmentsPanel entityType="purchase_requisition" entityId={pr.id} data={files} currentUserId={user.id} />
        </div>
      </div>
    </>
  );
}
