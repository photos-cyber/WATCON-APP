import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { docCrumbs } from "@/components/procurement/crumbs";
import { NextStep, ProjectTrace } from "@/components/procurement/next-step";
import { RfqWorkflow } from "@/components/procurement/rfq-workflow";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { formatDate, formatQty } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { itemBrandOptions } from "@/modules/inventory/locations";
import { todayString } from "@/modules/inventory/serialize";
import { partyOptions } from "@/modules/parties/service";
import { getRfq } from "@/modules/procurement/rfq";
import { traceSalesOrders } from "@/modules/procurement/trace";

export const metadata: Metadata = { title: "Rate enquiry" };

export default async function RfqPage({ params }: PageProps<"/rate-enquiries/[rfqId]">) {
  const user = await requirePagePermission("rfq.view");
  const { rfqId } = await params;
  const { rfq, comparison, can } = await orNotFound(getRfq(user, rfqId));
  const liveQuotes = rfq.quotations.filter((q) => q.status !== "SUPERSEDED");
  const [files, activity, options, salesOrders, quoteFiles, supplierOptions] = await Promise.all([
    listAttachments(user, "rfq", rfq.id),
    entityActivity(user, "rfq", rfq.id),
    itemBrandOptions(user),
    traceSalesOrders(user, { prIds: [rfq.prId], prLineIds: rfq.lines.map((l) => l.prLineId) }),
    Promise.all(liveQuotes.map((q) => listAttachments(user, "supplier_quotation", q.id))),
    can.manage ? partyOptions(user, "supplier") : Promise.resolve([]),
  ]);
  const summary = `Rate enquiry ${rfq.number}: ${rfq.title}${rfq.project ? `\nProject: ${rfq.project.name}` : ""}${rfq.responseDue ? `\nPlease quote by ${formatDate(rfq.responseDue)}` : ""}\n\n${rfq.lines.map((l) => `• ${l.item.name}${l.itemBrand ? ` (${l.itemBrand.brand.name}${l.acceptableBrands ? ` / ${l.acceptableBrands}` : ""})` : ""} – ${formatQty(l.quantity)} ${l.unit}`).join("\n")}\n\nPlease share your best rate, GST, freight and delivery time.`;
  const quoted = new Set(liveQuotes.map((q) => q.partyId)).size;
  const canManageRfq = can.manage;
  const appUrl = env().APP_URL.replace(/\/$/, "");

  const step = (() => {
    switch (rfq.status) {
      case "DRAFT":
        return <NextStep title="Next: share the enquiry with the suppliers">Use PDF / WhatsApp / email (top right) to send it, then press “Mark as shared with suppliers”.</NextStep>;
      case "SENT":
        return <NextStep tone="info" title={`Waiting for quotations (${quoted} of ${rfq.suppliers.length} received)`}>{rfq.responseDue ? `Quotes are due by ${formatDate(rfq.responseDue)}. ` : ""}Enter each supplier’s quotation below as it arrives and attach their quotation file.</NextStep>;
      case "RESPONSES_IN":
        return <NextStep title="Quotations are in — compare and award">Check the comparison, use “Award to recommended” or split quantities between suppliers, then send the award for approval.</NextStep>;
      case "AWARD_PENDING":
        return can.approveAward ? <NextStep title="Waiting for your approval of the award">Review the awarded quantities in the comparison and approve or reject.</NextStep> : <NextStep tone="info" title="Award sent for approval">{can.approveBlockedReason ?? "An approver will review the proposed award."}</NextStep>;
      case "AWARDED":
        return can.createPos ? <NextStep title="Award approved — next: create the purchase orders">One draft purchase order is created per awarded supplier, with the agreed rates.</NextStep> : <NextStep tone="done" title="Awarded">Purchase orders have been created from this enquiry.</NextStep>;
      default:
        return null;
    }
  })();

  return (
    <>
      <PageHeader
        title={rfq.number}
        description={rfq.title}
        breadcrumbs={docCrumbs(rfq.project, "rate-enquiries", { label: rfq.number })}
        meta={
          <>
            <DocStatusBadge status={rfq.status} />
            <ProjectTrace project={rfq.project} salesOrders={salesOrders} tab="rate-enquiries" />
          </>
        }
        actions={<DocShare type="rfq" id={rfq.id} summary={summary} subject={`Rate enquiry ${rfq.number}`} />}
      />
      {step}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Enquiry">
            <DetailGrid
              items={[
                { label: "Requisition", value: rfq.pr ? <Link href={`/purchase-requisitions/${rfq.pr.id}`} className="text-primary hover:underline">{rfq.pr.number}</Link> : "—" },
                { label: "Deliver to", value: rfq.deliveryLocation?.name },
                { label: "Needed at site by", value: formatDate(rfq.requiredBy) },
                { label: "Quotes due", value: formatDate(rfq.responseDue) },
                { label: "Payment / freight terms", value: [rfq.paymentTerms, rfq.freightTerms].filter(Boolean).join(" · ") || "—" },
                { label: "Tax terms", value: rfq.taxTerms },
                { label: "Delivery address", value: rfq.deliveryAddress, wide: true },
                { label: "Specifications", value: rfq.specifications, wide: true },
              ]}
            />
          </Section>
          <Section title="Materials requested" bodyClassName="p-0">
            <ul className="divide-y text-sm">
              {rfq.lines.map((l) => (
                <li key={l.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                  <span>
                    <span className="font-medium">{l.item.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {l.itemBrand?.brand.name ?? "Any brand"}
                      {l.acceptableBrands ? ` · also OK: ${l.acceptableBrands}` : ""}
                    </span>
                    {l.specifications && <span className="block text-xs text-muted-foreground">{l.specifications}</span>}
                  </span>
                  <span className="tabular-nums">
                    {formatQty(l.quantity)} {l.unit}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <RfqWorkflow
            id={rfq.id}
            version={rfq.version}
            status={rfq.status}
            today={todayString()}
            can={can}
            suppliers={rfq.suppliers.map((s) => ({
              id: s.party.id,
              name: s.party.name,
              status: s.status,
              shared: !!s.sentAt,
              opened: !!s.viewedAt,
              phone: s.party.whatsappNumber ?? s.party.phone,
              email: s.party.email,
              // The link is a credential — only people who manage the enquiry get it.
              link: canManageRfq ? `${appUrl}/quote/${s.accessToken}` : null,
            }))}
            enquiry={{ number: rfq.number, title: rfq.title, responseDue: rfq.responseDue ? formatDate(rfq.responseDue) : null }}
            supplierOptions={supplierOptions.filter((s) => s.status === "ACTIVE" && !rfq.suppliers.some((x) => x.partyId === s.id)).map((s) => ({ value: s.id, label: s.name, hint: s.gstin ?? "Unregistered" }))}
            lines={rfq.lines.map((l) => ({ id: l.id, itemId: l.itemId, name: l.item.name, itemBrandId: l.itemBrandId, quantity: l.quantity, unit: l.unit, acceptableBrands: l.acceptableBrands }))}
            quotations={rfq.quotations.map((q) => ({ id: q.id, partyId: q.partyId, partyName: q.party.name, number: q.number, revision: q.revision, status: q.status, quoteDate: q.quoteDate.toISOString() }))}
            comparison={comparison.map((c) => ({ lineId: c.line.id, name: c.line.item.name, quantity: c.line.quantity, unit: c.line.unit, quotes: c.quotes }))}
            options={options}
          />
          {liveQuotes.length > 0 && (
            <Section title="Supplier quotations" bodyClassName="space-y-3">
              <p className="text-xs text-muted-foreground">Attach each supplier’s own quotation (PDF / photo) so the comparison can be checked against it.</p>
              <div className="grid gap-3 lg:grid-cols-2">
                {liveQuotes.map((q, i) => (
                  <AttachmentsPanel key={q.id} entityType="supplier_quotation" entityId={q.id} data={quoteFiles[i]!} currentUserId={user.id} title={`${q.party.name} · ${q.number}${q.revision ? ` rev ${q.revision}` : ""}`} defaultCategory="QUOTATION" categories={["QUOTATION", "CORRESPONDENCE", "OTHER"]} />
                ))}
              </div>
            </Section>
          )}
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...(rfq.pr ? [{ type: "Requisition", id: rfq.pr.id, number: rfq.pr.number, href: `/purchase-requisitions/${rfq.pr.id}` }] : []),
              ...rfq.purchaseOrders.map((p) => ({ type: "Purchase order", id: p.id, number: p.number, status: p.status, href: `/purchase-orders/${p.id}`, meta: `${p.party.name} · ${formatINR(p.total)}` })),
            ]}
          />
          <AttachmentsPanel entityType="rfq" entityId={rfq.id} data={files} currentUserId={user.id} title="Enquiry documents" />
        </div>
      </div>
    </>
  );
}
