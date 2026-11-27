import type { Metadata } from "next";
import { PoForm, type PoFormValues } from "@/components/procurement/po-form";
import { docCrumbs } from "@/components/procurement/crumbs";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { newId } from "@/lib/utils";
import { getCommercialSettings } from "@/modules/commercial/core";
import { itemBrandOptions, listLocationOptions } from "@/modules/inventory/locations";
import { todayString } from "@/modules/inventory/serialize";
import { partyOptions } from "@/modules/parties/service";
import { prefillFromPr } from "@/modules/procurement/po";
import { listProjectOptions } from "@/modules/projects/service";

export const metadata: Metadata = { title: "New purchase order" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function NewPoPage({ searchParams }: PageProps<"/purchase-orders/new">) {
  const user = await requirePagePermission("po.create");
  const sp = await searchParams;
  const [suppliers, projects, locations, options, settings] = await Promise.all([partyOptions(user, "supplier"), listProjectOptions(user, { forTaskCreation: true }), listLocationOptions(user), itemBrandOptions(user), getCommercialSettings(user.organizationId)]);
  const initial: PoFormValues = { projectId: str(sp.projectId) ?? null, partyId: null, deliveryLocationId: null, deliveryAddress: "", orderDate: todayString(), expectedDate: "", paymentTerms: "", advanceAmount: "", terms: "", internalRemarks: "", charges: "", chargesGstRate: "18", roundToRupee: true, rfqId: null, prId: null, lines: [] };
  let source = "";
  const prId = str(sp.prId);
  if (prId) {
    const pre = await prefillFromPr(user, prId);
    Object.assign(initial, { projectId: pre.projectId, prId: pre.prId, deliveryLocationId: pre.deliveryLocationId, expectedDate: pre.expectedDate, partyId: pre.partyId });
    initial.lines = pre.lines.map((l) => ({ key: newId(), itemBrandId: l.itemBrandId, description: l.description, quantity: l.quantity, rate: l.rate, discountPct: "0", gstRate: l.gstRate, links: { prLineId: l.prLineId } }));
    source = " from requisition";
  } else if (str(sp.itemBrandId)) {
    const o = options.find((x) => x.id === sp.itemBrandId);
    if (o) initial.lines = [{ key: newId(), itemBrandId: o.id, description: "", quantity: str(sp.qty) ?? "", rate: o.lastRate ?? "", discountPct: "0", gstRate: o.gstRate ?? "18", links: {} }];
    source = " from material planning";
  }
  return (
    <>
      <PageHeader title={`New purchase order${source}`} description="Saved as a draft. Finalize it, then share it with the supplier." breadcrumbs={docCrumbs(projects.find((p) => p.id === initial.projectId), "purchase-orders", { label: "New purchase order" })} />
      <PoForm lockProject={!!initial.projectId && projects.some((p) => p.id === initial.projectId)} initial={initial} suppliers={suppliers} projects={projects} locations={locations} options={options} companyStateCode={settings.stateCode} defaultTerms={settings.poTerms} />
    </>
  );
}
