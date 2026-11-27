import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SummaryCards } from "@/components/commercial/ui";
import { InvoiceTable } from "@/components/sales/tables";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/session";
import { formatINRCompact } from "@/lib/money";
import { can } from "@/lib/permissions/definitions";
import { partyOptions } from "@/modules/parties/service";
import { listProjectOptions } from "@/modules/projects/service";
import { listClientInvoices } from "@/modules/sales/invoice";

export const metadata: Metadata = { title: "Client invoices" };

const STATUSES = ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "CANCELLED"];

export default async function ClientInvoicesPage({ searchParams }: PageProps<"/client-invoices">) {
  const user = await requirePagePermission("invoice.view");
  const sp = await searchParams;
  const [result, projects, clients] = await Promise.all([listClientInvoices(user, sp), listProjectOptions(user), partyOptions(user, "client")]);
  const n = (k: string) => result.byStatus[k]?.count ?? 0;
  const projectId = typeof sp.projectId === "string" ? sp.projectId : undefined;
  return (
    <>
      <PageHeader
        title="Client invoices"
        description="Tax invoices raised to clients, from running bills, delivered sales orders or a contract."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Client invoices" }]}
        actions={
          can(user, "invoice.manage") && (
            <Button asChild size="sm">
              <Link href={`/client-invoices/new${projectId ? `?projectId=${projectId}` : ""}`}>
                <Plus /> New invoice
              </Link>
            </Button>
          )
        }
      />
      <SummaryCards
        items={[
          { label: "Drafts", value: n("DRAFT"), href: "/client-invoices?status=DRAFT" },
          { label: "Open invoices", value: n("ISSUED") + n("PARTIALLY_PAID"), href: "/client-invoices?status=ISSUED" },
          { label: "Overdue", value: result.overdueCount, tone: result.overdueCount ? "bad" : "default", href: "/client-invoices?overdue=1" },
          { label: "Receivable", value: formatINRCompact(result.receivable), tone: result.receivable !== "0.00" ? "warn" : "default", hint: "issued, not yet received" },
          { label: "Paid", value: n("PAID"), tone: "good", href: "/client-invoices?status=PAID" },
        ]}
      />
      <FilterBar params={["projectId", "q", "status", "partyId", "overdue", "outstanding"]}>
        <FilterSelect param="projectId" label="Project" allLabel="All my projects" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />
        <SearchInput placeholder="Search invoice or client…" />
        <FilterSelect param="status" label="Status" options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} />
        <FilterSelect param="partyId" label="Client" options={clients.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect param="outstanding" label="Payment" allLabel="All" options={[{ value: "1", label: "Outstanding" }]} />
      </FilterBar>
      <InvoiceTable rows={result.rows} />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}
