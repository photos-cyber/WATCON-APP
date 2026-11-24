import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { QuotationForm } from "@/components/sales/quotation-form";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { orNotFound } from "@/lib/pages";
import { can } from "@/lib/permissions/definitions";
import { newId } from "@/lib/utils";
import { getCommercialSettings } from "@/modules/commercial/core";
import { itemBrandOptions } from "@/modules/inventory/locations";
import { partyOptions } from "@/modules/parties/service";
import { listProjectOptions } from "@/modules/projects/service";
import { formValues, listPaymentTemplates, loadQuotationScoped } from "@/modules/sales/quotation";

export const metadata: Metadata = { title: "Edit quotation" };

export default async function EditQuotationPage({ params }: PageProps<"/quotations/[quotationId]/edit">) {
  const user = await requirePagePermission("so.manage");
  const { quotationId } = await params;
  const q = await orNotFound(loadQuotationScoped(user, quotationId));
  if (q.status !== "DRAFT") redirect(`/quotations/${q.id}`);
  const [clients, projects, options, settings, templates] = await Promise.all([partyOptions(user, "client"), listProjectOptions(user), itemBrandOptions(user), getCommercialSettings(user.organizationId), listPaymentTemplates(user)]);
  const f = formValues(q);
  return (
    <>
      <PageHeader title={`Edit ${q.number}${q.revision ? ` · Rev ${q.revision}` : ""}`} breadcrumbs={[{ label: "Quotations", href: "/quotations" }, { label: q.number, href: `/quotations/${q.id}` }, { label: "Edit" }]} />
      <QuotationForm
        quotationId={q.id}
        version={q.version}
        initial={{
          projectId: f.projectId,
          partyId: f.partyId,
          subject: f.subject ?? "",
          quoteDate: f.quoteDate,
          validUntil: f.validUntil ?? "",
          deliveryTerms: f.deliveryTerms ?? "",
          paymentTermsText: f.paymentTermsText ?? "",
          terms: f.terms ?? "",
          notes: f.notes ?? "",
          lines: f.lines.map((l) => ({ key: newId(), itemBrandId: l.itemBrandId, description: l.description, brand: l.brand ?? "", hsnSac: l.hsnSac ?? "", unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: String(Number(l.gstRate)) })),
          milestones: f.milestones,
        }}
        projects={projects}
        clients={clients}
        options={options}
        companyStateCode={settings.stateCode}
        savedTemplates={templates}
        canSaveTemplate={can(user, "so.manage")}
      />
    </>
  );
}
