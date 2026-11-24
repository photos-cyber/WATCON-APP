import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shared/page-header";
import { ProjectsTable } from "@/components/projects/projects-table";
import { DateRangeFilter, FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { PROJECT_STATUS_LABELS } from "@/lib/format";
import { can } from "@/lib/permissions/definitions";
import { listProjects } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  const user = await requireUser();
  const result = await listProjects(user, await searchParams);
  const canCreate = can(user, "projects.create");

  return (
    <>
      <PageHeader
        title="Projects"
        description="Company sites and their current progress."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Projects" }]}
        actions={
          canCreate && (
            <Button asChild>
              <Link href="/projects/new">
                <Plus /> Create new project
              </Link>
            </Button>
          )
        }
      />
      <FilterBar params={["q", "status", "archived", "from", "to"]}>
        <SearchInput placeholder="Search name, code or address…" />
        <FilterSelect param="status" label="Status" options={Object.entries(PROJECT_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
        <FilterSelect
          param="archived"
          label="Archived"
          allLabel="Hidden"
          options={[
            { value: "include", label: "Include archived" },
            { value: "only", label: "Archived only" },
          ]}
        />
        <DateRangeFilter fromParam="from" toParam="to" label="Updated" />
      </FilterBar>
      <ProjectsTable
        canCreate={canCreate}
        canEdit={can(user, "projects.edit")}
        canArchive={can(user, "projects.archive")}
        rows={result.rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          siteAddress: r.siteAddress,
          status: r.status,
          updatedAt: r.updatedAt.toISOString(),
          archived: r.archivedAt !== null,
          manager: r.manager?.fullName ?? null,
          total: r.counts.total,
          completed: r.counts.completed,
          progress: r.counts.progress,
          progressBasis: r.counts.progressBasis,
        }))}
      />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}
