import { MapPin } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep, ProjectTrace } from "@/components/procurement/next-step";
import { traceSalesOrdersForPoLines } from "@/modules/procurement/trace";
import { GrnActions } from "@/components/stores/actions";
import { ReceiptProof } from "@/components/stores/receipt-proof";
import { docCrumbs } from "@/components/procurement/crumbs";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getGrn } from "@/modules/stores/grn";

export const metadata: Metadata = { title: "Site receipt" };

export default async function GrnPage({ params }: PageProps<"/site-receipts/[grnId]">) {
  const user = await requirePagePermission("grn.view");
  const { grnId } = await params;
  const { grn, can, proof } = await orNotFound(getGrn(user, grnId));
  const [files, activity, salesOrders] = await Promise.all([
    listAttachments(user, "grn", grn.id),
    entityActivity(user, "grn", grn.id),
    traceSalesOrdersForPoLines(user, grn.lines.map((l) => l.poLineId)),
  ]);
  const source = grn.po ? { label: "Purchase order", id: grn.po.id, number: grn.po.number, href: `/purchase-orders/${grn.po.id}` } : grn.challan ? { label: "Challan", id: grn.challan.id, number: grn.challan.number, href: `/challans/${grn.challan.id}` } : null;
  const issues = grn.lines.filter((l) => l.damagedQty !== "0" || l.rejectedQty !== "0" || l.shortQty !== "0");
  const summary = `Site receipt ${grn.number} (${formatDate(grn.receiptDate)})${source ? ` against ${source.number}` : ""}\n${grn.lines.map((l) => `• ${l.itemBrand.item.name} (${l.itemBrand.brand.name}) – received ${formatQty(l.receivedQty)}, accepted ${formatQty(l.acceptedQty)} ${l.itemBrand.item.unit}`).join("\n")}`;

  const step = (() => {
    switch (grn.status) {
      case "DRAFT":
        return proof.complete ? <NextStep title="Ready — confirm the receipt">All mandatory proof is uploaded. Check the quantities and press “Confirm receipt” — stock is updated at once.</NextStep> : <NextStep title="Next: add the mandatory proof">Upload {proof.missing.join(", ").toLowerCase()} below. “Confirm receipt” unlocks once every proof box has a file.</NextStep>;
      case "SUBMITTED":
        return (
          <NextStep title="Confirm the receipt">
            {can.post ? "Check the quantities against the photos and challan, then press “Confirm receipt” to update stock." : "A store user will confirm it and add the accepted quantity to stock."}
          </NextStep>
        );
      case "REJECTED":
        return (
          <NextStep tone="warn" title="Sent back for correction">
            {grn.statusNote ?? "Fix the quantities and submit again."}
          </NextStep>
        );
      case "POSTED":
        return (
          <NextStep tone="done" title="Confirmed — accepted material is in stock" links={[{ href: `/stock?tab=locations-stock&locationId=${grn.location.id}${grn.project ? `&projectId=${grn.project.id}` : ""}`, label: "View stock" }]}>
            {grn.po ? "The purchase order's received quantities are updated. Accounts can now match the supplier bill to this receipt." : "The transfer's in-transit quantity is updated."}
          </NextStep>
        );
      case "REVERSED":
        return (
          <NextStep tone="warn" title="Reversed">
            {grn.statusNote}
          </NextStep>
        );
      default:
        return null;
    }
  })();

  return (
    <>
      <PageHeader
        title={grn.number}
        breadcrumbs={docCrumbs(grn.project, "site-receipts", { label: grn.number })}
        meta={
          <>
            <DocStatusBadge status={grn.status} />
            <ProjectTrace project={grn.project} salesOrders={salesOrders} tab="site-receipts" />
          </>
        }
        actions={
          <>
            <GrnActions id={grn.id} version={grn.version} can={can} proofMissing={proof.missing} />
            <DocShare type="grn" id={grn.id} summary={summary} subject={`Site receipt ${grn.number}`} />
          </>
        }
      />
      {step}
      <div className="mb-4">
        <ReceiptProof grnId={grn.id} proof={proof} editable={can.edit} maxUploadMb={files.maxUploadMb} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Receipt">
            <DetailGrid
              items={[
                { label: "Against", value: source ? <Link className="text-primary hover:underline" href={source.href}>{source.label} {source.number}</Link> : "—" },
                { label: "From", value: grn.party?.name ?? "Internal transfer" },
                { label: "Received at", value: grn.location.name },
                { label: "Receipt date", value: formatDate(grn.receiptDate) },
                { label: "Supplier challan / invoice", value: [grn.supplierChallanNo, grn.supplierInvoiceNo].filter(Boolean).join(" / ") || "—" },
                { label: "Vehicle", value: grn.vehicleNo },
                { label: "Received by", value: grn.receivedByName },
                { label: "Recorded", value: `${grn.createdBy.fullName} · ${formatDateTime(grn.createdAt)}` },
                { label: "Confirmed", value: grn.postedBy ? `${grn.postedBy.fullName} · ${formatDateTime(grn.postedAt)}` : "—" },
                {
                  label: "Site location",
                  value: grn.latitude ? (
                    <a className="inline-flex items-center gap-1 text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${grn.latitude},${grn.longitude}`}>
                      <MapPin className="size-3.5" /> {grn.latitude}, {grn.longitude}
                    </a>
                  ) : (
                    "Not captured"
                  ),
                },
                { label: "Remarks", value: grn.remarks, wide: true },
              ]}
            />
          </Section>
          <Section title="Items" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item – brand</th>
                    <th className="px-3 py-2 text-right font-medium">Expected</th>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                    <th className="px-3 py-2 text-right font-medium">Accepted</th>
                    <th className="px-3 py-2 text-right font-medium">Damaged</th>
                    <th className="px-3 py-2 text-right font-medium">Rejected</th>
                    <th className="px-3 py-2 text-right font-medium">Short</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {grn.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.itemBrand.item.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.itemBrand.brand.name}
                          {l.remarks ? ` · ${l.remarks}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatQty(l.expectedQty)} {l.itemBrand.item.unit}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.receivedQty)}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums text-emerald-700">{formatQty(l.acceptedQty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-700">{l.damagedQty !== "0" ? formatQty(l.damagedQty) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-700">{l.rejectedQty !== "0" ? formatQty(l.rejectedQty) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700">{l.shortQty !== "0" ? formatQty(l.shortQty) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {issues.length > 0 && <p className="border-t px-4 py-2 text-xs text-amber-800 dark:text-amber-300">{issues.length} item(s) have damage, rejection or shortage. Attach damage photos as evidence for the supplier.</p>}
          </Section>
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs docs={source ? [{ type: source.label, id: source.id, number: source.number, href: source.href }] : []} />
          <AttachmentsPanel entityType="grn" entityId={grn.id} data={files} currentUserId={user.id} title="All receipt files" defaultCategory="MATERIAL_PHOTO" categories={["MATERIAL_PHOTO", "DAMAGE_PHOTO", "SIGNED_CHALLAN", "DELIVERY_CHALLAN", "SUPPLIER_INVOICE", "SIGNATURE", "OTHER"]} />
        </div>
      </div>
    </>
  );
}
