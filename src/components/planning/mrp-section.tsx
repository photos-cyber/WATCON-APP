import { Plus } from "lucide-react";
import Link from "next/link";
import { DocStatusBadge, SummaryCards } from "@/components/commercial/ui";
import { EmptyState } from "@/components/shared/states";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Button } from "@/components/ui/button";
import type { SessionUser } from "@/modules/auth/service";
import { listLocationOptions } from "@/modules/inventory/locations";
import { listStockPositionOptions } from "@/modules/inventory/service";
import { partyOptions } from "@/modules/parties/service";
import { getMrp, listPlanningOrders, planningCapabilities } from "@/modules/planning/service";
import { listProjectOptions } from "@/modules/projects/service";
import { formatDate, formatQty } from "@/lib/format";
import { formatINRCompact } from "@/lib/money";
import { cn } from "@/lib/utils";
import { MrpTable, RequirementDialog } from "./mrp-table";

const STATUS_OPTIONS = [
  ["TO_ORDER", "Needs ordering"],
  ["SHORTAGE", "Shortage"],
  ["LOW_STOCK", "Low stock"],
  ["AVAILABLE", "Available"],
  ["ALREADY_ORDERED", "Already ordered"],
  ["AWAITING_DELIVERY", "Awaiting delivery"],
  ["PARTIALLY_RECEIVED", "Partially received"],
  ["DELAYED", "Delayed"],
  ["FULLY_RECEIVED", "Fully received"],
  ["DAMAGED", "Damaged / rejected"],
  ["BELOW_REORDER", "Below minimum stock"],
] as const;

type Tab = "requirements" | "general" | "all" | "ordered";
const TABS: { key: Tab; label: string; global?: boolean }[] = [
  { key: "requirements", label: "Project requirements" },
  { key: "general", label: "General inventory", global: true },
  { key: "all", label: "All requirements", global: true },
  { key: "ordered", label: "Already ordered" },
];
const SCOPE: Record<Exclude<Tab, "ordered">, "project" | "general" | "all"> = { requirements: "project", general: "general", all: "all" };

/**
 * Material planning for one project (project tab) or the whole company (global page). Sub-tabs use the
 * `plan` URL parameter so they also work inside the project hub (which owns `tab`).
 */
export async function MrpSection({ user, sp, projectId, basePath }: { user: SessionUser; sp: Record<string, string | string[] | undefined>; projectId?: string; basePath: string }) {
  const tabs = TABS.filter((t) => !projectId || !t.global);
  const tab = (tabs.find((t) => t.key === sp.plan)?.key ?? "requirements") as Tab;
  const caps = planningCapabilities(user);
  const sep = basePath.includes("?") ? "&" : "?";
  const tabHref = (t: Tab) => (t === "requirements" ? basePath : `${basePath}${sep}plan=${t}`);
  const here = tabHref(tab);
  const hsep = here.includes("?") ? "&" : "?";
  const scopeArg = { ...sp, projectId: projectId ?? sp.projectId };

  const nav = (
    <div role="tablist" aria-label="Planning views" className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => (
        <Link key={t.key} role="tab" aria-selected={tab === t.key} href={tabHref(t.key)} scroll={false} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {t.label}
        </Link>
      ))}
    </div>
  );

  if (tab === "ordered") {
    const { rows } = await listPlanningOrders(user, { ...scopeArg, scope: projectId ? "project" : "all" });
    return (
      <section className="space-y-3" aria-label="Material planning">
        {nav}
        <FilterBar params={["q", ...(projectId ? [] : ["projectId"])]}>
          <SearchInput placeholder="Search item…" />
        </FilterBar>
        {!rows.length ? (
          <EmptyState title="Nothing ordered from planning yet" description="Requisitions, rate enquiries and purchase orders raised for planned requirements appear here, line by line." />
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left font-medium">Document</th>
                  <th className="px-2 py-2 text-left font-medium">For</th>
                  <th className="px-2 py-2 text-left font-medium">Item – brand</th>
                  <th className="px-2 py-2 text-right font-medium">Quantity</th>
                  <th className="px-2 py-2 text-right font-medium" title="Ordered (requisition) or accepted (purchase order)">Done</th>
                  <th className="px-2 py-2 text-left font-medium">Supplier</th>
                  <th className="px-2 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="px-2 py-2">
                      <Link href={r.href} className="font-medium hover:text-primary hover:underline">{r.number}</Link>
                      <div className="text-xs text-muted-foreground">{r.docType === "PO" ? "Purchase order" : r.docType === "RFQ" ? "Rate enquiry" : "Requisition"} · {formatDate(r.date)}</div>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{r.project ? <Link href={`/projects/${r.project.id}?tab=planning`} className="hover:underline">{r.project.code}</Link> : <span className="font-sans text-muted-foreground">General stock</span>}</td>
                    <td className="px-2 py-2">{r.item.name}<div className="text-xs text-muted-foreground">{r.brand ?? "Any brand"} · {r.item.code}</div></td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.quantity)} <span className="text-xs text-muted-foreground">{r.item.unit}</span></td>
                    <td className="px-2 py-2 text-right tabular-nums">{r.progress === null ? "—" : formatQty(r.progress)}</td>
                    <td className="px-2 py-2 text-xs">{r.supplier ?? "—"}</td>
                    <td className="px-2 py-2"><DocStatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  const [mrp, positions, locations, projects, suppliers] = await Promise.all([
    getMrp(user, { ...scopeArg, scope: SCOPE[tab] }),
    listStockPositionOptions(user),
    listLocationOptions(user),
    listProjectOptions(user, { forTaskCreation: true }),
    caps.canPo || caps.canRfq ? partyOptions(user, "supplier") : Promise.resolve([]),
  ]);
  const s = mrp.summary;
  const href = (status: string) => `${here}${hsep}status=${status}`;
  const generalTab = tab === "general";
  return (
    <section className="space-y-3" aria-label="Material planning">
      {nav}
      <SummaryCards
        items={
          generalTab
            ? [
                { label: "Stock lines planned", value: s.total, href: here },
                { label: "At or below minimum", value: s.belowMinimum, tone: s.belowMinimum ? "bad" : "default", href: href("BELOW_REORDER") },
                { label: "Lines to order", value: s.toOrderLines, tone: s.toOrderLines ? "warn" : "default", hint: s.unpricedLines ? `${s.unpricedLines} without a price` : undefined },
                { label: "Awaiting delivery", value: s.awaiting, href: href("AWAITING_DELIVERY") },
                { label: "Est. procurement", value: formatINRCompact(s.estimatedCost), hint: "to order × last rate" },
              ]
            : [
                { label: "Requirement lines", value: s.total, href: here },
                { label: "Shortage / low stock", value: s.shortage, tone: s.shortage ? "bad" : "default", href: href("SHORTAGE") },
                { label: "Lines to order", value: s.toOrderLines, tone: s.toOrderLines ? "warn" : "default", hint: s.unpricedLines ? `${s.unpricedLines} without a price` : undefined },
                { label: "Awaiting delivery", value: s.awaiting, href: href("AWAITING_DELIVERY") },
                { label: "Delayed deliveries", value: s.delayed, tone: s.delayed ? "bad" : "default", href: href("DELAYED") },
                { label: "Est. procurement", value: formatINRCompact(s.estimatedCost), hint: "to order × last rate" },
              ]
        }
      />
      <FilterBar params={["q", "status", "view", ...(projectId ? [] : ["projectId"])]}>
        <SearchInput placeholder={generalTab ? "Search item or brand…" : "Search item, brand or project…"} />
        {!projectId && tab === "requirements" && <FilterSelect param="projectId" label="Project" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />}
        <FilterSelect param="status" label="Status" options={STATUS_OPTIONS.map(([value, label]) => ({ value, label }))} />
        {!generalTab && <FilterSelect param="view" label="Requirements" allLabel="Open" options={[{ value: "all", label: "Include closed" }]} />}
        {caps.canManage && (
          <div className="ml-auto">
            <RequirementDialog
              projects={projects}
              positions={positions}
              allowGeneral={!projectId}
              initial={projectId ? { projectId } : generalTab ? { projectId: null, general: true } : undefined}
              trigger={
                <Button size="sm">
                  <Plus /> {generalTab ? "Add stock purchase" : "Add requirement"}
                </Button>
              }
            />
          </div>
        )}
      </FilterBar>
      <MrpTable rows={mrp.rows} caps={caps} projects={projects} positions={positions} locations={locations} suppliers={suppliers.filter((p) => p.status === "ACTIVE").map((p) => ({ id: p.id, name: p.name, code: p.code }))} mode={generalTab ? "general" : tab === "all" ? "all" : "project"} showProject={!projectId} />
    </section>
  );
}
