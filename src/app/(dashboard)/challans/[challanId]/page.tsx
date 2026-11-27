import type { Metadata } from "next";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep } from "@/components/procurement/next-step";
import { ChallanActions } from "@/components/stores/actions";
import { docCrumbs } from "@/components/procurement/crumbs";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { CHALLAN_TYPE_LABELS, getChallan } from "@/modules/stores/challan";

export const metadata: Metadata = { title: "Challan" };

export default async function ChallanPage({ params }: PageProps<"/challans/[challanId]">) {
  const user = await requirePagePermission("grn.view");
  const { challanId } = await params;
  const { challan: c, internal, can, podMissing } = await orNotFound(getChallan(user, challanId));
  const [files, activity] = await Promise.all([listAttachments(user, "challan", c.id), entityActivity(user, "challan", c.id)]);
  const to = c.toLocation?.name ?? c.party?.name ?? "—";
  const transit = c.lines.some((l) => l.inTransit !== "0");
  const summary = `Delivery challan ${c.number} (${CHALLAN_TYPE_LABELS[c.type]})\n${c.fromLocation?.name ?? ""} → ${to}${c.vehicleNo ? `\nVehicle: ${c.vehicleNo}` : ""}${c.driverName ? `\nDriver: ${c.driverName}${c.driverPhone ? ` (${c.driverPhone})` : ""}` : ""}\n\n${c.lines.map((l) => `• ${l.itemBrand.item.name} (${l.itemBrand.brand.name}) – ${formatQty(l.quantity)} ${l.itemBrand.item.unit}`).join("\n")}`;

  const step = (() => {
    switch (c.status) {
      case "DRAFT":
        return <NextStep title="Draft — stock has not moved yet">Check the material and vehicle details, print the challan for the driver, then press “Dispatch” when the vehicle leaves.</NextStep>;
      case "DISPATCHED":
      case "PARTIALLY_RECEIVED":
        return internal ? (
          <NextStep tone="info" title={c.status === "DISPATCHED" ? "In transit — waiting for the destination to receive it" : "Partly received — some material is still in transit"} links={can.receive ? [{ href: `/site-receipts/new?challanId=${c.id}`, label: "Receive at destination" }] : []}>
            The destination records a site receipt for what actually arrived. If something never arrives, close the challan to return or write off the shortfall.
          </NextStep>
        ) : (
          podMissing ? (
            <NextStep title="Dispatched — upload the proof of delivery">Upload the challan signed by the client (or other proof of delivery) under “Signed challan &amp; proof of delivery” below. “Confirm delivery” unlocks once it is uploaded.</NextStep>
          ) : (
            <NextStep tone="info" title="Dispatched — confirm delivery">Proof of delivery is uploaded. Press “Confirm delivery” and enter who received it.</NextStep>
          )
        );
      case "RECEIVED":
      case "DELIVERED":
        return <NextStep tone="done" title={c.status === "RECEIVED" ? "Fully received at destination" : "Delivered"} links={c.project ? [{ href: `/projects/${c.project.id}?tab=running-bills`, label: "Running bills" }] : []}>All material is accounted for. Delivered material is picked up automatically by the project&apos;s next running bill.</NextStep>;
      case "CLOSED":
        return (
          <NextStep tone="warn" title="Closed with a discrepancy">
            {c.statusNote}
          </NextStep>
        );
      default:
        return null;
    }
  })();

  return (
    <>
      <PageHeader
        title={c.number}
        breadcrumbs={docCrumbs(c.project, "challans", { label: c.number })}
        meta={
          <>
            <DocStatusBadge status={c.status} />
            <span className="text-sm text-muted-foreground">{CHALLAN_TYPE_LABELS[c.type]}</span>
            {c.project && (
              <Link href={`/projects/${c.project.id}`} className="text-sm text-primary hover:underline">
                For project {c.project.code} – {c.project.name}
              </Link>
            )}
          </>
        }
        actions={
          <>
            <ChallanActions id={c.id} version={c.version} can={can} internal={internal} />
            <DocShare type="challan" id={c.id} summary={summary} phone={c.driverPhone} subject={`Delivery challan ${c.number}`} />
          </>
        }
      />
      {step}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Route & transport">
            <DetailGrid
              items={[
                { label: "From", value: c.fromLocation?.name },
                { label: "To", value: to },
                { label: "Against", value: c.so ? <Link className="text-primary hover:underline" href={`/sales-orders/${c.so.id}`}>Sales order {c.so.number}</Link> : c.po ? <Link className="text-primary hover:underline" href={`/purchase-orders/${c.po.id}`}>PO {c.po.number}</Link> : "—" },
                { label: "Dispatch date / expected", value: `${formatDate(c.dispatchDate)} → ${formatDate(c.expectedDate)}` },
                { label: "Vehicle / transporter", value: [c.vehicleNo, c.transporter].filter(Boolean).join(" · ") || "—" },
                { label: "LR / docket", value: c.lrNumber },
                { label: "Driver", value: [c.driverName, c.driverPhone].filter(Boolean).join(" · ") || "—" },
                { label: "Sent by / received by", value: `${c.senderName ?? "—"} / ${c.receiverName ?? "—"}` },
                { label: "Created", value: `${c.createdBy.fullName} · ${formatDateTime(c.createdAt)}` },
                { label: "Dispatched", value: c.dispatchedBy ? `${c.dispatchedBy.fullName} · ${formatDateTime(c.dispatchedAt)}` : "—" },
                { label: "Remarks", value: c.remarks, wide: true },
              ]}
            />
          </Section>
          <Section title="Material" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item – brand</th>
                    <th className="px-3 py-2 text-right font-medium">Sent</th>
                    {internal && <th className="px-3 py-2 text-right font-medium">Received</th>}
                    {internal && <th className="px-3 py-2 text-right font-medium">Damaged</th>}
                    {internal && <th className="px-3 py-2 text-right font-medium">Returned / written off</th>}
                    {internal && <th className="px-3 py-2 text-right font-medium">Still in transit</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {c.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.itemBrand.item.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.itemBrand.brand.name}
                          {l.remarks ? ` · ${l.remarks}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatQty(l.quantity)} {l.itemBrand.item.unit}
                      </td>
                      {internal && <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{formatQty(l.receivedQty)}</td>}
                      {internal && <td className="px-3 py-2 text-right tabular-nums text-rose-700">{l.damagedQty !== "0" ? formatQty(l.damagedQty) : "—"}</td>}
                      {internal && <td className="px-3 py-2 text-right tabular-nums">{l.writtenOffQty !== "0" ? formatQty(l.writtenOffQty) : "—"}</td>}
                      {internal && <td className="px-3 py-2 text-right font-medium tabular-nums text-amber-700">{l.inTransit !== "0" && c.status !== "DRAFT" ? formatQty(l.inTransit) : "—"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {internal && transit && c.status !== "DRAFT" && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Material “in transit” has left the source but has not been received at the destination yet.</p>}
          </Section>
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...(c.so ? [{ type: "Sales order", id: c.so.id, number: c.so.number, href: `/sales-orders/${c.so.id}` }] : []),
              ...(c.po ? [{ type: "Purchase order", id: c.po.id, number: c.po.number, href: `/purchase-orders/${c.po.id}` }] : []),
              ...c.grns.map((g) => ({ type: "Site receipt", id: g.id, number: g.number, status: g.status, href: `/site-receipts/${g.id}`, meta: formatDate(g.receiptDate) })),
            ]}
          />
          <AttachmentsPanel entityType="challan" entityId={c.id} data={files} currentUserId={user.id} title="Signed challan & proof of delivery" defaultCategory="SIGNED_CHALLAN" categories={["SIGNED_CHALLAN", "DELIVERY_CHALLAN", "MATERIAL_PHOTO", "DAMAGE_PHOTO", "SIGNATURE", "OTHER"]} />
        </div>
      </div>
    </>
  );
}
