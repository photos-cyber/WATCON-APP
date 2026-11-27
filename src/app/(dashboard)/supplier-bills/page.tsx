import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SummaryCards } from "@/components/commercial/ui";
import { payablesCrumbs } from "@/components/payables/crumbs";
import { BillTable } from "@/components/payables/tables";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/session";
import { formatINRCompact } from "@/lib/money";
import { can } from "@/lib/permissions/definitions";
import { partyOptions } from "@/modules/parties/service";
import { listBills } from "@/modules/payables/bills";
import { listProjectOptions } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Supplier bills" };

const STATUSES = ["DRAFT", "PENDING_APPROVAL", "REJECTED", "APPROVED", "PARTIALLY_PAID", "PAID", "CANCELLED"];

export default async function SupplierBillsPage({ searchParams }: PageProps<"/supplier-bills">) {
  const user = await requirePagePermission("bills.view");
  const sp = await searchParams;
  const [r, projects, suppliers] = await Promise.all([listBills(user, sp), listProjectOptions(user), partyOptions(user, "supplier")]);
  const n = (k: string) => r.byStatus[k] ?? 0;
  const projectQs = r.query.projectId ? `&projectId=${r.query.projectId}` : "";
  const project = projects.find((p) => p.id === r.query.projectId) ?? null;
  return (
    <>
      <PageHeader
        title="Supplier bills"
        description="Supplier invoices, checked against purchase orders and site receipts before they are paid."
        breadcrumbs={payablesCrumbs(project, "supplier-bills")}
        actions={
          can(user, "bills.manage") && (
            <Button asChild size="sm">
              <Link href={`/supplier-bills/new${r.query.projectId ? `?projectId=${r.query.projectId}` : ""}`}>
                <Plus /> Enter supplier bill
              </Link>
            </Button>
          )
        }
      />
      <SummaryCards
        items={[
          { label: "Drafts", value: n("DRAFT") + n("REJECTED"), hint: n("REJECTED") ? `${n("REJECTED")} sent back` : undefined, href: `/supplier-bills?status=DRAFT${projectQs}` },
          { label: "Held for checking", value: n("PENDING_APPROVAL"), tone: n("PENDING_APPROVAL") ? "warn" : "default", href: `/supplier-bills?view=approval${projectQs}` },
          { label: "Don't match PO", value: r.exceptions, tone: r.exceptions ? "bad" : "default", hint: "quantity / rate / GSTIN differences", href: `/supplier-bills?view=exceptions${projectQs}` },
          { label: "Overdue", value: r.overdueCount, tone: r.overdueCount ? "bad" : "default", hint: formatINRCompact(r.overdueValue), href: `/supplier-bills?view=overdue${projectQs}` },
          { label: "Unpaid (approved)", value: formatINRCompact(r.unpaidValue), href: `/supplier-bills?view=unpaid${projectQs}` },
          { label: "Paid", value: n("PAID"), tone: "good", href: `/supplier-bills?status=PAID${projectQs}` },
        ]}
      />
      <FilterBar params={project ? ["q", "status", "partyId", "view"] : ["q", "status", "projectId", "partyId", "view"]}>
        <SearchInput placeholder="Search bill, invoice no., supplier or PO…" />
        <FilterSelect param="status" label="Status" options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} />
        {!project && <FilterSelect param="projectId" label="Project" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />}
        <FilterSelect param="partyId" label="Supplier" options={suppliers.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect param="view" label="Show" options={[{ value: "approval", label: "Held for checking" }, { value: "exceptions", label: "Don't match PO" }, { value: "overdue", label: "Overdue" }, { value: "unpaid", label: "Unpaid" }]} />
      </FilterBar>
      <BillTable rows={r.rows} />
      <Pagination total={r.total} page={r.page} pageSize={r.pageSize} />
    </>
  );
}
