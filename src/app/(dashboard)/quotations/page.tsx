import { FileText, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DocStatusBadge, Money, SummaryCards } from "@/components/commercial/ui";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/states";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { can } from "@/lib/permissions/definitions";
import { cn } from "@/lib/utils";
import { listProjectOptions } from "@/modules/projects/service";
import { listQuotations } from "@/modules/sales/quotation";

export const metadata: Metadata = { title: "Quotations" };

const TABS: [string, string][] = [
  ["ALL", "All"],
  ["DRAFT", "Draft"],
  ["PENDING_APPROVAL", "Pending approval"],
  ["APPROVED", "Approved"],
  ["SENT", "Sent"],
  ["VIEWED", "Viewed"],
  ["ACCEPTED", "Accepted"],
  ["REJECTED", "Rejected"],
  ["EXPIRED", "Expired"],
  ["CONVERTED", "Converted"],
];

export default async function QuotationsPage({ searchParams }: PageProps<"/quotations">) {
  const user = await requirePagePermission("so.view");
  const sp = await searchParams;
  const [result, projects] = await Promise.all([listQuotations(user, sp), listProjectOptions(user)]);
  const current = typeof sp.status === "string" && sp.status ? sp.status : "ALL";
  const tabHref = (s: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "status" && k !== "page") p.set(k, v);
    if (s !== "ALL") p.set("status", s);
    const q = p.toString();
    return `/quotations${q ? `?${q}` : ""}`;
  };
  const c = result.counts;
  return (
    <>
      <PageHeader
        title="Quotations"
        description="Quotations to clients — approve, share, track acceptance and convert into sales orders."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Quotations" }]}
        actions={can(user, "so.manage") && (
          <Button asChild size="sm">
            <Link href={`/quotations/new${typeof sp.projectId === "string" ? `?projectId=${sp.projectId}` : ""}`}>
              <Plus /> New quotation
            </Link>
          </Button>
        )}
      />
      <SummaryCards
        items={[
          { label: "Drafts", value: c.DRAFT ?? 0, href: tabHref("DRAFT") },
          { label: "Awaiting approval", value: c.PENDING_APPROVAL ?? 0, tone: c.PENDING_APPROVAL ? "warn" : "default", href: tabHref("PENDING_APPROVAL") },
          { label: "With client", value: (c.APPROVED ?? 0) + (c.SENT ?? 0), href: tabHref("SENT") },
          { label: "Accepted — to convert", value: c.ACCEPTED ?? 0, tone: c.ACCEPTED ? "good" : "default", href: tabHref("ACCEPTED") },
          { label: "Converted", value: c.CONVERTED ?? 0, href: tabHref("CONVERTED") },
        ]}
      />
      <nav className="mb-3 flex gap-1 overflow-x-auto border-b" aria-label="Quotation status">
        {TABS.map(([s, label]) => (
          <Link key={s} href={tabHref(s)} className={cn("shrink-0 border-b-2 px-3 py-2 text-sm", current === s ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {label}
          </Link>
        ))}
      </nav>
      <FilterBar params={["projectId", "q"]}>
        <FilterSelect param="projectId" label="Project" allLabel="All my projects" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />
        <SearchInput placeholder="Search number, subject or client…" />
      </FilterBar>
      {result.rows.length === 0 ? (
        <EmptyState icon={FileText} title="No quotations here" description="Create a quotation for a project and client, then send it for approval." />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Quotation</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Valid until</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {result.rows.map((r) => (
                <tr key={r.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/quotations/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.number}
                      {r.revision ? <span className="text-xs text-muted-foreground"> · Rev {r.revision}</span> : null}
                    </Link>
                    {r.subject && <div className="max-w-72 truncate text-xs text-muted-foreground">{r.subject}</div>}
                  </td>
                  <td className="px-3 py-2.5">{r.party}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{r.project.code}</td>
                  <td className="px-3 py-2.5">{formatDate(r.quoteDate)}</td>
                  <td className="px-3 py-2.5">{formatDate(r.validUntil)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <Money value={r.total} />
                  </td>
                  <td className="px-4 py-2.5">
                    <DocStatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}
