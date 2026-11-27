import { listCrumbs, lockedProject } from "@/components/procurement/crumbs";
import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SummaryCards } from "@/components/commercial/ui";
import { PrTable } from "@/components/procurement/tables";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/session";
import { can } from "@/lib/permissions/definitions";
import { listPrs } from "@/modules/procurement/pr";
import { listProjectOptions } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Purchase requisitions" };

const STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PARTIALLY_ORDERED", "ORDERED", "CLOSED", "CANCELLED"];

export default async function PrListPage({ searchParams }: PageProps<"/purchase-requisitions">) {
  const user = await requirePagePermission("pr.view");
  const sp = await searchParams;
  const [result, projects] = await Promise.all([listPrs(user, sp), listProjectOptions(user)]);
  const locked = lockedProject(projects, sp);
  const n = (k: string) => result.byStatus[k] ?? 0;
  return (
    <>
      <PageHeader
        title="Purchase requisitions"
        description="Material requests from sites and stores, approved before sourcing."
        breadcrumbs={listCrumbs(locked, "requisitions")}
        actions={can(user, "pr.create") && (<Button asChild size="sm"><Link href={`/purchase-requisitions/new${typeof sp.projectId === "string" ? `?projectId=${sp.projectId}` : ""}`}><Plus /> New requisition</Link></Button>)}
      />
      <SummaryCards
        items={[
          { label: "Drafts", value: n("DRAFT"), href: "/purchase-requisitions?status=DRAFT" },
          { label: "Waiting to finalize", value: n("SUBMITTED"), tone: n("SUBMITTED") ? "warn" : "default", href: "/purchase-requisitions?status=SUBMITTED" },
          { label: "Approved – to source", value: n("APPROVED"), href: "/purchase-requisitions?status=APPROVED" },
          { label: "Partially ordered", value: n("PARTIALLY_ORDERED"), href: "/purchase-requisitions?status=PARTIALLY_ORDERED" },
          { label: "Ordered", value: n("ORDERED"), tone: "good", href: "/purchase-requisitions?status=ORDERED" },
          { label: "Rejected", value: n("REJECTED"), tone: n("REJECTED") ? "bad" : "default", href: "/purchase-requisitions?status=REJECTED" },
        ]}
      />
      <FilterBar params={["projectId", "q", "status"]}>{!locked && <FilterSelect param="projectId" label="Project" allLabel="All my projects" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />}
        <SearchInput placeholder="Search number, purpose or item…" />
        <FilterSelect param="status" label="Status" options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} />
      </FilterBar>
      <PrTable rows={result.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, createdAt: r.createdAt.toISOString(), requiredBy: r.requiredBy?.toISOString() ?? null, purpose: r.purpose, project: r.project, createdBy: r.createdBy.fullName, lines: r._count.lines }))} />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}
