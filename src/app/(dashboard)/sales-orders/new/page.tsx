import type { Metadata } from "next";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { SoForm, type SoFormValues } from "@/components/sales/so-form";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { newId } from "@/lib/utils";
import { getCommercialSettings } from "@/modules/commercial/core";
import { DEFAULT_CLIENT_MILESTONES } from "@/modules/commercial/payment-terms";
import { itemBrandOptions } from "@/modules/inventory/locations";
import { todayString } from "@/modules/inventory/serialize";
import { partyOptions } from "@/modules/parties/service";
import { listProjectOptions } from "@/modules/projects/service";
import { clientPoOptions } from "@/modules/sales/client-po";
import { salesOrderPrefill } from "@/modules/sales/sales-order";

export const metadata: Metadata = { title: "New sales order" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function NewSalesOrderPage({ searchParams }: PageProps<"/sales-orders/new">) {
  const user = await requirePagePermission("so.manage");
  const sp = await searchParams;
  // Client, delivery address and (when linked) contract lines default from the project / client PO.
  const pre = await salesOrderPrefill(user, { projectId: str(sp.projectId), clientPoId: str(sp.clientPoId) });
  const [clients, projects, clientPos, options, settings] = await Promise.all([partyOptions(user, "client"), listProjectOptions(user, { forTaskCreation: true }), clientPoOptions(user, pre.projectId ? { projectId: pre.projectId } : {}), itemBrandOptions(user), getCommercialSettings(user.organizationId)]);
  const initial: SoFormValues = {
    projectId: pre.projectId,
    partyId: pre.partyId,
    clientPoId: pre.clientPoId,
    orderDate: todayString(),
    deliveryDate: "",
    deliveryAddress: pre.deliveryAddress,
    deliverySchedule: "",
    billingSchedule: "",
    paymentTerms: "",
    notes: "",
    milestones: DEFAULT_CLIENT_MILESTONES.map((m) => ({ ...m })),
    lines: pre.lines.map((l) => ({ key: newId(), clientPoLineId: l.clientPoLineId, description: l.description, hsnSac: l.hsnSac ?? "", unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, note: l.note })),
  };
  const project = projects.find((p) => p.id === initial.projectId);
  return (
    <>
      <PageHeader title="New sales order" description="Saved as a draft. Once approved it drives the project's material planning and is locked." breadcrumbs={[...projectCrumbs(project, "sales-orders", { label: "Sales orders", href: "/sales-orders" }), { label: "New sales order" }]} />
      <SoForm mode="create" lockProject={!!project} initial={initial} projects={projects} clients={clients} clientPos={clientPos} options={options} companyStateCode={settings.stateCode} />
    </>
  );
}
