import type { Metadata } from "next";
import { QuotationForm, type QuotationFormValues } from "@/components/sales/quotation-form";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { can } from "@/lib/permissions/definitions";
import { getCommercialSettings } from "@/modules/commercial/core";
import { DEFAULT_CLIENT_MILESTONES } from "@/modules/commercial/payment-terms";
import { itemBrandOptions } from "@/modules/inventory/locations";
import { todayString } from "@/modules/inventory/serialize";
import { partyOptions } from "@/modules/parties/service";
import { listProjectOptions } from "@/modules/projects/service";
import { listPaymentTemplates } from "@/modules/sales/quotation";

export const metadata: Metadata = { title: "New quotation" };

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function NewQuotationPage({ searchParams }: PageProps<"/quotations/new">) {
  const user = await requirePagePermission("so.manage");
  const sp = await searchParams;
  const [clients, projects, options, settings, templates] = await Promise.all([partyOptions(user, "client"), listProjectOptions(user, { forTaskCreation: true }), itemBrandOptions(user), getCommercialSettings(user.organizationId), listPaymentTemplates(user)]);
  const projectId = typeof sp.projectId === "string" && projects.some((p) => p.id === sp.projectId) ? sp.projectId : null;
  const today = todayString();
  const initial: QuotationFormValues = {
    projectId,
    partyId: null,
    subject: "",
    quoteDate: today,
    validUntil: addDays(today, 30),
    deliveryTerms: "",
    paymentTermsText: "",
    terms: "",
    notes: "",
    lines: [],
    milestones: DEFAULT_CLIENT_MILESTONES.map((m) => ({ ...m })),
  };
  return (
    <>
      <PageHeader title="New quotation" description="Quote a client for a project. After approval, share it by link, WhatsApp or email; once accepted it converts into a sales order." breadcrumbs={[{ label: "Quotations", href: "/quotations" }, { label: "New" }]} />
      <QuotationForm initial={initial} projects={projects} clients={clients} options={options} companyStateCode={settings.stateCode} savedTemplates={templates} canSaveTemplate={can(user, "so.manage")} lockProject={!!projectId} />
    </>
  );
}
