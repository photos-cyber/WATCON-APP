import { ArrowRight, CheckCircle2, Clock, Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Money, Section, ToneBadge } from "@/components/commercial/ui";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/states";
import { FilterBar, FilterSelect } from "@/components/tables/filters";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { can } from "@/lib/permissions/definitions";
import { listApprovals, listSoAmendmentRequests, type ApprovalItem } from "@/modules/insights/approvals";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Inbox" };

const KIND_OPTIONS = [
  ["so", "Sales orders"],
  ["cpo", "Client POs"],
  ["pr", "Requisitions"],
  ["rfq", "Supplier awards"],
  ["po", "Purchase orders"],
  ["grn", "Site receipts"],
  ["bill", "Supplier bills"],
  ["rabill", "Running bills"],
] as const;

function ageOf(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
}

export default async function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  const user = await requireUser();
  if (!can(user, "approvals.view") && user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=1");
  const sp = await searchParams;
  const kind = typeof sp.kind === "string" ? sp.kind : undefined;
  const [all, amendments] = await Promise.all([listApprovals(user), listSoAmendmentRequests(user)]);
  const items = kind ? all.filter((i) => i.kind === kind) : all;
  const mine = items.filter((i) => i.mine);
  const others = items.filter((i) => !i.mine);
  const amendMine = amendments.filter((a) => a.mine);
  const amendWaiting = amendments.filter((a) => !a.mine);
  const byProject = groupByProject(mine);
  const projectsInvolved = new Set([
    ...byProject.map((g) => g.project?.code ?? g.key),
    ...amendMine.map((a) => a.project.code),
  ]).size;
  const oldestTimes = [...mine.map((i) => new Date(i.waitingSince).getTime()), ...amendMine.map((a) => new Date(a.requestedAt).getTime())];
  const oldestWaiting = oldestTimes.length ? new Date(Math.min(...oldestTimes)).toISOString() : null;

  return (
    <>
      <PageHeader title="Inbox" description="Daily documents are finalized by the person who prepares them. Listed here: sales-order amendments for the Super Admin, supplier bills held for differences, and anything left waiting from the old approval step." breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Inbox" }]} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Waiting for you" value={mine.length + amendMine.length} tone={mine.length + amendMine.length ? "warn" : undefined} />
        <Stat label="Waiting for others" value={others.length + amendWaiting.length} />
        <Stat label="Projects involved" value={projectsInvolved} />
        <Stat label="Oldest waiting" value={oldestWaiting ? ageOf(oldestWaiting) : "—"} />
      </div>

      {(amendMine.length > 0 || amendWaiting.length > 0) && (
        <Section title="Sales order amendment requests" className="mb-5">
          <p className="mb-3 text-xs text-muted-foreground">Approved sales orders are locked. Changes are applied only after a Super Admin approves the amendment request.</p>
          <ul className="divide-y">
            {[...amendMine, ...amendWaiting].map((a) => (
              <li key={a.id}>
                <Link href={a.href} className="flex flex-col gap-1 py-2.5 hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-3">
                  <span className="font-medium">{a.requestNo}</span>
                  <span className="text-sm">
                    {a.soNumber} · <span className="font-mono text-xs">{a.project.code}</span>
                  </span>
                  <span className="truncate text-sm text-muted-foreground">{a.reason}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground sm:ml-auto">
                    {a.requestedBy} · {ageOf(a.requestedAt)}
                    {a.mine ? <ToneBadge tone="warn">Your decision</ToneBadge> : <ToneBadge tone="neutral">Waiting for Super Admin</ToneBadge>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <FilterBar params={["kind"]}>
        <FilterSelect param="kind" label="Type" options={KIND_OPTIONS.map(([value, label]) => ({ value, label }))} />
      </FilterBar>

      {mine.length === 0 ? (
        amendMine.length > 0 ? (
          <EmptyState icon={CheckCircle2} title="No other documents waiting" description="Only the sales order amendment requests above need your decision." />
        ) : (
          <EmptyState icon={CheckCircle2} title="You're all caught up" description="Nothing is waiting for you right now." />
        )
      ) : (
        <div className="space-y-4">
          {byProject.map((g) => (
            <Section
              key={g.key}
              title={g.project ? `${g.project.code} – ${g.project.name}` : "No project"}
              actions={
                g.project ? (
                  <Link href={`/projects/${g.project.id}`} className="text-xs text-primary hover:underline">
                    Open project
                  </Link>
                ) : undefined
              }
              bodyClassName="p-0"
            >
              <ItemList items={g.items} />
            </Section>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <Section title={`Waiting for other approvers (${others.length})`} className="mt-6" bodyClassName="p-0">
          <ItemList items={others} muted />
        </Section>
      )}
    </>
  );
}

function groupByProject(items: ApprovalItem[]) {
  const map = new Map<string, { key: string; project: ApprovalItem["project"]; items: ApprovalItem[] }>();
  for (const i of items) {
    const key = i.project?.id ?? "none";
    if (!map.has(key)) map.set(key, { key, project: i.project, items: [] });
    map.get(key)!.items.push(i);
  }
  return [...map.values()];
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${tone === "warn" ? "text-amber-700" : ""}`}>{value}</p>
    </div>
  );
}

function ItemList({ items, muted }: { items: ApprovalItem[]; muted?: boolean }) {
  if (!items.length) return <EmptyState icon={Inbox} title="Nothing here" />;
  return (
    <ul className="divide-y">
      {items.map((i) => (
        <li key={`${i.kind}-${i.id}`}>
          <Link href={i.href} className="flex flex-col gap-1 px-4 py-3 hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{i.number}</span>
                <ToneBadge tone={muted ? "neutral" : "warn"}>{i.action}</ToneBadge>
                {muted && i.project && <span className="font-mono text-xs text-muted-foreground">{i.project.code}</span>}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {i.kindLabel}
                {i.party ? ` · ${i.party}` : ""}
                {i.requestedBy ? ` · requested by ${i.requestedBy}` : ""}
              </p>
              {i.blockedReason && <p className="text-xs text-muted-foreground italic">{i.blockedReason}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-3 text-sm">
              {i.amount && <Money value={i.amount} />}
              <span className="flex items-center gap-1 text-xs text-muted-foreground" title={formatDateTime(i.waitingSince)}>
                <Clock className="size-3" aria-hidden /> {ageOf(i.waitingSince)}
              </span>
              <ArrowRight className="hidden size-4 text-muted-foreground sm:block" aria-hidden />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
