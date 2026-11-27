import { listCrumbs, lockedProject } from "@/components/procurement/crumbs";
import { Plus } from "lucide-react";
import Link from "next/link";
import { SummaryCards } from "@/components/commercial/ui";
import { RfqTable } from "@/components/procurement/tables";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/session";
import { can } from "@/lib/permissions/definitions";
import { listRfqs } from "@/modules/procurement/rfq";
import { listProjectOptions } from "@/modules/projects/service";

export default async function RateEnquiriesPage({ searchParams }: PageProps<"/rate-enquiries">) {
  const user = await requirePagePermission("rfq.view");
  const sp = await searchParams;
  const [result, projects] = await Promise.all([listRfqs(user, sp), listProjectOptions(user)]);
  const locked = lockedProject(projects, sp);
  const statuses = ["DRAFT", "SENT", "RESPONSES_IN", "AWARD_PENDING", "AWARDED", "CLOSED", "CANCELLED"];
  return <>
    <PageHeader title="Rate enquiries" description="Ask several suppliers for rates, compare their quotations and award the order — always for one project." breadcrumbs={listCrumbs(locked, "rate-enquiries")} actions={can(user, "rfq.manage") && <Button asChild size="sm"><Link href={`/rate-enquiries/new${typeof sp.projectId === "string" ? `?projectId=${sp.projectId}` : ""}`}><Plus /> New enquiry</Link></Button>} />
    <SummaryCards items={[["DRAFT", "Not yet shared"], ["SENT", "Waiting for quotes"], ["RESPONSES_IN", "Ready to compare"], ["AWARD_PENDING", "Award to confirm"], ["AWARDED", "Awarded"]].map(([status, label]) => ({ label: label!, value: result.byStatus[status!] ?? 0, tone: status === "AWARD_PENDING" && result.byStatus[status] ? ("warn" as const) : ("default" as const), href: `/rate-enquiries?status=${status}` }))} />
    <FilterBar params={["projectId", "q", "status"]}>{!locked && <FilterSelect param="projectId" label="Project" allLabel="All my projects" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />}<SearchInput placeholder="Search number or subject…" /><FilterSelect param="status" label="Status" options={statuses.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} /></FilterBar>
    <RfqTable rows={result.rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), responseDue: r.responseDue?.toISOString() ?? null, lines: r._count.lines, suppliers: r._count.suppliers, quotations: r._count.quotations }))} />
    <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
  </>;
}
