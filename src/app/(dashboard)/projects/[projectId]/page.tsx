import { CalendarDays, MapPin, Pencil, Plus, ShoppingBag, Truck, UserRound } from "lucide-react";
import { RecordClientPaymentButton } from "@/components/payables/client-account";
import { projectAccountsDashboard, projectTransactions } from "@/modules/insights/project-accounts";
import { cn } from "@/lib/utils";
import type { Metadata } from "next";
import Link from "next/link";
import { DocStatusBadge, Money, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { PdfButtons } from "@/components/documents/pdf-buttons";
import { ActionRequired, KpiDefinitions, KpiGrid, MiniStat, NeedsAttention, OrderFlow, type Kpi } from "@/components/insights/command-center";
import { projectActionRequired } from "@/modules/insights/action-required";
import { DocList } from "@/components/insights/doc-list";
import { WorkspaceTabs, type WorkspaceGroup } from "@/components/insights/workspace-tabs";
import { ConsumptionButton, LocationBalancesTable, ReservationsTable } from "@/components/inventory/location-ui";
import { MrpSection } from "@/components/planning/mrp-section";
import { ProjectArchiveButton } from "@/components/projects/project-archive-button";
import { PROJECT_TABS } from "@/components/projects/project-breadcrumbs";
import { ProjectSwitcher } from "@/components/projects/project-switcher";
import { StatusUpdateForm } from "@/components/projects/status-update-form";
import { ReportActions } from "@/components/reports/report-actions";
import { PriorityBadge, ProgressBar, StatusBadge } from "@/components/shared/badges";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/states";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { TaskTable } from "@/components/tasks/task-table";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatDate, formatDateTime, TASK_STATUS_LABELS } from "@/lib/format";
import { cmpMoney, formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { can, type PermissionKey } from "@/lib/permissions/definitions";
import { projectCommercialActivity } from "@/modules/documents/activity";
import { listProjectDocuments } from "@/modules/documents/attachments";
import { CATEGORY_LABELS, type AttachmentCategory } from "@/modules/documents/categories";
import { entityHref, entityLabel } from "@/modules/documents/links";
import { listDepartmentOptions } from "@/modules/departments/service";
import { listSoAmendmentRequests } from "@/modules/insights/approvals";
import { KPI_HELP } from "@/modules/insights/finance";
import { DOC_KINDS, DOC_STATUSES, listProjectDocs, projectCommandCenter, projectDocCounts, projectOrderFlow, projectTeam, type DocCount, type DocKind } from "@/modules/insights/workspace";
import { listLocationBalances, listReservations, locationCapabilities } from "@/modules/inventory/locations";
import { todayString } from "@/modules/inventory/serialize";
import { getProject, listProjectOptions, listStatusUpdates, projectActivity } from "@/modules/projects/service";
import { toTaskRow } from "@/modules/tasks/serialize";
import { listTasks } from "@/modules/tasks/service";

export const metadata: Metadata = { title: "Project" };

type Actor = Awaited<ReturnType<typeof requireUser>>;
type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** Tab key → document kind for the list tabs. */
const DOC_TABS: Record<string, DocKind> = {
  "sales-orders": "so",
  "client-pos": "cpo",
  "running-bills": "rabill",
  invoices: "invoice",
  "client-receipts": "receipt",
  requisitions: "pr",
  "rate-enquiries": "rfq",
  "purchase-orders": "po",
  "site-receipts": "grn",
  challans: "challan",
  "supplier-bills": "bill",
  payments: "payment",
  notes: "note",
};

function buildGroups(user: Actor, counts: Partial<Record<DocKind, DocCount>>, taskTotal: number, amendments: number): WorkspaceGroup[] {
  const doc = (key: keyof typeof PROJECT_TABS) => {
    const kind = DOC_TABS[key]!;
    const c = counts[kind];
    if (!can(user, DOC_KINDS[kind].view)) return [];
    const extra = key === "sales-orders" && amendments ? `${amendments} amendment${amendments === 1 ? "" : "s"}` : null;
    const badge = [c?.pending ? `${c.pending} ${c.pendingLabel}` : null, extra].filter(Boolean).join(" · ") || undefined;
    return [{ key, label: PROJECT_TABS[key], count: c?.total ?? 0, badge }];
  };
  const perm = (p: PermissionKey, key: keyof typeof PROJECT_TABS) => (can(user, p) ? [{ key, label: PROJECT_TABS[key] }] : []);
  // Workflow v2 · Phase 9: Overview · Tasks · Sales Orders · Materials · Purchases · Site Challans ·
  // Running Bills · Accounts · Documents. Tab keys are unchanged so existing links keep working.
  const groups: WorkspaceGroup[] = [
    { key: "overview", label: "Overview", tabs: [{ key: "overview", label: "Overview" }] },
    { key: "tasks", label: "Tasks", tabs: [{ key: "tasks", label: PROJECT_TABS.tasks, count: taskTotal }] },
    { key: "sales", label: "Sales Orders", tabs: [...doc("sales-orders"), ...doc("client-pos")] },
    { key: "materials", label: "Materials", tabs: [...perm("mrp.view", "planning"), ...perm("items.view", "stock")] },
    { key: "purchases", label: "Purchases", tabs: [...doc("purchase-orders"), ...doc("rate-enquiries"), ...doc("requisitions"), ...doc("supplier-bills"), ...doc("payments")] },
    { key: "site", label: "Site Challans", tabs: [...doc("challans"), ...doc("site-receipts")] },
    { key: "billing", label: "Running Bills", tabs: [...doc("running-bills"), ...doc("invoices"), ...doc("client-receipts")] },
    { key: "accounts", label: "Accounts", tabs: [...perm("accounts.view", "accounts"), ...doc("notes")] },
    { key: "records", label: "Documents", tabs: [{ key: "documents", label: PROJECT_TABS.documents }, { key: "activity", label: PROJECT_TABS.activity }, { key: "history", label: PROJECT_TABS.history }, { key: "team", label: PROJECT_TABS.team }] },
  ];
  return groups.filter((g) => g.tabs.length > 0);
}

export default async function ProjectDetailPage({ params, searchParams }: PageProps<"/projects/[projectId]">) {
  const { projectId } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const { project, counts, capabilities } = await orNotFound(getProject(user, projectId));
  const [docCounts, amendments, projects] = await Promise.all([projectDocCounts(user, project.id), listSoAmendmentRequests(user, { projectId: project.id }), listProjectOptions(user)]);
  const groups = buildGroups(user, docCounts, counts.total, amendments.length);
  const allTabs = groups.flatMap((g) => g.tabs.map((t) => t.key));
  const tab = allTabs.includes(String(sp.tab)) ? String(sp.tab) : "overview";
  const archived = project.archivedAt !== null;
  const noSalesOrder = can(user, "so.view") && (docCounts.so?.total ?? 0) === 0;
  const soCta = noSalesOrder && !archived && can(user, "so.manage");

  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: project.code, href: tab === "overview" ? undefined : `/projects/${project.id}` }, ...(tab === "overview" ? [] : [{ label: PROJECT_TABS[tab as keyof typeof PROJECT_TABS] ?? tab }])]}
        meta={
          <>
            <span className="font-mono text-xs text-muted-foreground">{project.code}</span>
            <StatusBadge kind="project" status={project.status} />
            <PriorityBadge priority={project.priority} />
            {archived && <span className="rounded-md border bg-muted px-2 py-0.5 text-xs text-muted-foreground">Archived {formatDate(project.archivedAt)}</span>}
          </>
        }
        actions={
          <>
            <ProjectSwitcher projects={projects} currentId={project.id} tab={tab} />
            {soCta && (
              <Button asChild size="sm">
                <Link href={`/sales-orders/new?projectId=${project.id}`}>
                  <ShoppingBag /> Create sales order
                </Link>
              </Button>
            )}
            {!archived && can(user, "stock.transfer") && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/projects/${project.id}/issue`}>
                  <Truck /> Issue material to site
                </Link>
              </Button>
            )}
            {capabilities.canCreateTask && (
              <Button asChild size="sm" variant={soCta ? "outline" : "default"}>
                <Link href={`/tasks/new?projectId=${project.id}`}>
                  <Plus /> Create task
                </Link>
              </Button>
            )}
            {capabilities.canEdit && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/projects/${project.id}/edit`}>
                  <Pencil /> Edit
                </Link>
              </Button>
            )}
            {capabilities.canArchive && <ProjectArchiveButton projectId={project.id} name={project.name} archived={archived} />}
          </>
        }
      />

      {soCta && tab === "overview" && (
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/[0.04] p-4 sm:flex-row sm:items-center">
          <ShoppingBag className="size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex-1 text-sm">
            <p className="font-medium">Start with a sales order</p>
            <p className="text-muted-foreground">Record what the client has ordered. Material planning, purchasing, deliveries and invoicing for this project all follow from it.</p>
          </div>
          <Button asChild size="sm">
            <Link href={`/sales-orders/new?projectId=${project.id}`}>Create sales order</Link>
          </Button>
        </div>
      )}

      <WorkspaceTabs groups={groups} current={tab} />

      {tab === "overview" && <Overview user={user} project={project} counts={counts} capabilities={capabilities} sp={sp} />}
      {tab in DOC_TABS && <DocTab user={user} projectId={project.id} tab={tab} archived={archived} sp={sp} amendments={amendments} />}
      {tab === "planning" && <MrpSection user={user} sp={sp} projectId={project.id} basePath={`/projects/${project.id}?tab=planning`} />}
      {tab === "stock" && <SiteStock user={user} projectId={project.id} sp={sp} />}
      {tab === "accounts" && <AccountsTab user={user} projectId={project.id} />}
      {tab === "tasks" && <ProjectTasks projectId={project.id} userId={user} sp={sp} canCreate={capabilities.canCreateTask} />}
      {tab === "documents" && <Documents user={user} projectId={project.id} sp={sp} />}
      {tab === "activity" && (
        <div className="space-y-6">
          <CommercialActivity user={user} projectId={project.id} />
          <div>
            <h2 className="mb-2 text-sm font-semibold">Task activity</h2>
            <Activity userId={user} projectId={project.id} />
          </div>
        </div>
      )}
      {tab === "history" && <StatusHistory userId={user} projectId={project.id} page={Number(sp.page) || 1} />}
      {tab === "team" && <Team user={user} projectId={project.id} />}
    </>
  );
}

type ProjectData = Awaited<ReturnType<typeof getProject>>;

async function Overview({ user, project, counts, capabilities, sp }: { user: Actor; project: ProjectData["project"]; counts: ProjectData["counts"]; capabilities: ProjectData["capabilities"]; sp: SP }) {
  const [flow, cc, actions] = await Promise.all([projectOrderFlow(user, project.id), projectCommandCenter(user, project.id), projectActionRequired(user, project.id)]);
  const latest = project.statusUpdates[0];
  const f = cc.financials;
  const nonZero = (v: string) => cmpMoney(v, "0") !== 0;
  const t = (key: string) => `/projects/${project.id}?tab=${key}`;
  const revenue: Kpi[] = f
    ? [
        { label: "Contract value", value: f.contractValue, help: KPI_HELP.contractValue, href: t("client-pos") },
        { label: "Certified", value: f.certified, help: KPI_HELP.certified, href: t("running-bills") },
        { label: "Billed", value: f.billed, help: KPI_HELP.billed, href: t("invoices") },
        { label: "Received", value: f.received, help: KPI_HELP.received, tone: "good", href: t("client-receipts") },
        { label: "Receivable", value: f.receivable, help: KPI_HELP.receivable, tone: nonZero(f.receivable) ? "warn" : undefined },
      ]
    : [];
  const cost: Kpi[] = f
    ? [
        { label: "Committed (POs)", value: f.committed, help: KPI_HELP.committed, href: t("purchase-orders") },
        { label: "Material received", value: f.receivedValue, help: KPI_HELP.receivedValue, href: t("site-receipts") },
        { label: "Supplier billed", value: f.supplierBilled, help: KPI_HELP.supplierBilled, href: t("supplier-bills") },
        { label: "Paid", value: f.paid, help: KPI_HELP.paid, href: t("payments") },
        { label: "Payable", value: f.payable, help: KPI_HELP.payable, tone: nonZero(f.payable) ? "warn" : undefined },
      ]
    : [];
  return (
    <div className="space-y-6">
      <ActionRequired cards={actions} />
      <OrderFlow steps={flow} projectId={project.id} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <NeedsAttention items={cc.attention} />
          {f && (
            <Section
              title="Money position"
              actions={
                <Link href={t("accounts")} className="text-sm text-primary hover:underline">
                  Project accounts
                </Link>
              }
            >
              <div className="space-y-4">
                <KpiGrid title="Client side" kpis={revenue} />
                <KpiGrid title="Supplier side" kpis={cost} />
                <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm" title={KPI_HELP.margin}>
                  <span className="text-muted-foreground">Gross material margin</span>
                  <Money value={f.margin} className={cmpMoney(f.margin, "0") < 0 ? "font-semibold text-rose-700" : "font-semibold"} />
                  {f.marginPct !== null && <span className="text-xs text-muted-foreground">{f.marginPct}% of billed revenue (excl. GST)</span>}
                </div>
                <KpiDefinitions items={[...revenue, ...cost].map((k) => ({ label: k.label, help: k.help })).concat([{ label: "Gross material margin", help: KPI_HELP.margin }])} />
              </div>
            </Section>
          )}
        </div>
        <div className="space-y-4">
          <section className="rounded-xl border bg-card p-4" aria-label="Material status">
            <h2 className="text-sm font-semibold">Material status</h2>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <MiniStat label="Shortages to order" value={cc.material.shortages} tone={cc.material.shortages ? "bad" : undefined} href={`${t("planning")}&status=SHORTAGE`} />
              <MiniStat label="POs awaiting delivery" value={cc.material.openPos} href={t("purchase-orders")} />
              <MiniStat label="Deliveries overdue" value={cc.material.overduePos} tone={cc.material.overduePos ? "bad" : undefined} href={t("purchase-orders")} />
              <MiniStat label="Receipts to confirm" value={cc.material.grnsToPost} tone={cc.material.grnsToPost ? "warn" : undefined} href={`${t("site-receipts")}&status=SUBMITTED`} />
            </dl>
          </section>
          <section className="rounded-xl border bg-card p-4" aria-label="Project details">
            <h2 className="text-sm font-semibold">Project details</h2>
            {project.description && <p className="mt-2 text-sm whitespace-pre-line text-foreground/90">{project.description}</p>}
            <dl className="mt-3 space-y-2 text-sm">
              <Detail icon={MapPin} label="Site address" value={project.siteAddress} />
              <Detail icon={UserRound} label="Project manager" value={project.manager ? project.manager.fullName : "—"} />
              <Detail icon={CalendarDays} label="Start → target completion" value={`${formatDate(project.startDate)} → ${formatDate(project.expectedCompletionDate)}`} />
            </dl>
          </section>
          {counts.delivery && (
            <section className="rounded-xl border bg-card p-4" aria-label="Delivery progress">
              <h2 className="text-sm font-semibold">Project progress</h2>
              <p className="text-xs text-muted-foreground">Material delivered to the client against the approved sales order(s).</p>
              <ProgressBar value={counts.delivery.progress} className="mt-3" />
              <p className="mt-2 text-xs text-muted-foreground">
                {formatINR(counts.delivery.deliveredValue)} delivered of {formatINR(counts.delivery.orderValue)} (before GST)
              </p>
            </section>
          )}
          <section className="rounded-xl border bg-card p-4" aria-label="Task progress">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Task progress</h2>
              <Link href={t("tasks")} className="text-xs text-primary hover:underline">
                All tasks
              </Link>
            </div>
            <ProgressBar value={counts.taskProgress} className="mt-3" />
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <MiniStat label="Total" value={counts.total} />
              <MiniStat label="Open" value={counts.open} />
              <MiniStat label="Done" value={counts.completed} />
            </dl>
            {capabilities.canReport && (
              <div className="mt-3 border-t pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Project task list</p>
                <ReportActions params={{ type: "project", id: project.id }} />
              </div>
            )}
          </section>
        </div>
      </div>

      <section className="rounded-xl border bg-card p-5" aria-labelledby="current-status">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="current-status" className="text-sm font-semibold">
            Current project status
          </h2>
          {latest && (
            <span className="text-xs text-muted-foreground">
              {latest.author.fullName} · {formatDateTime(latest.createdAt)}
            </span>
          )}
        </div>
        {latest ? <p className="text-sm leading-relaxed whitespace-pre-line">{latest.body}</p> : <p className="text-sm text-muted-foreground">No status has been posted yet.</p>}
        {capabilities.canPostStatus && (
          <div className="mt-4 border-t pt-4">
            <StatusUpdateForm projectId={project.id} />
          </div>
        )}
      </section>
      <ProjectTasks projectId={project.id} userId={user} sp={{ ...sp, pageSize: sp.pageSize ?? "5" }} compact canCreate={capabilities.canCreateTask} />
    </div>
  );
}

function Detail({ icon: Icon, label, value }: { icon: typeof MapPin; label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="break-words whitespace-pre-line">{value}</dd>
      </div>
    </div>
  );
}

async function DocTab({ user, projectId, tab, archived, sp, amendments }: { user: Actor; projectId: string; tab: string; archived: boolean; sp: SP; amendments: Awaited<ReturnType<typeof listSoAmendmentRequests>> }) {
  const kind = DOC_TABS[tab]!;
  const def = DOC_KINDS[kind];
  const q = str(sp.q);
  const status = str(sp.status);
  const result = await listProjectDocs(user, projectId, kind, { q, status, page: Number(sp.page) || 1, pageSize: Number(sp.pageSize) || undefined });
  const canCreate = !archived && def.create !== null && can(user, def.create);
  const allHref = kind === "payment" ? `${def.path}?direction=OUT&projectId=${projectId}` : kind === "receipt" ? `${def.path}?direction=IN&projectId=${projectId}` : `${def.path}?projectId=${projectId}`;
  return (
    <div className="space-y-5">
      {kind === "so" && amendments.length > 0 && (
        <Section title={`Amendment requests waiting for Super Admin (${amendments.length})`}>
          <ul className="divide-y text-sm">
            {amendments.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:gap-3">
                <Link href={a.href} className="font-medium hover:underline">
                  {a.requestNo} · {a.soNumber}
                </Link>
                <span className="text-muted-foreground">{a.reason}</span>
                <span className="text-xs text-muted-foreground sm:ml-auto">
                  {a.requestedBy} · {formatDateTime(a.requestedAt)}
                  {a.mine ? " · your decision" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {kind === "so" && (
        <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Approved sales orders are locked. To change one, open it and send an amendment request — a Super Admin approves it and the change is applied as a new revision.
        </p>
      )}
      <DocList
        title={def.plural}
        about={def.about}
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        statuses={DOC_STATUSES[kind]}
        filtered={!!(q || status)}
        newHref={canCreate && def.newHref ? def.newHref(projectId) : null}
        newLabel={def.newLabel}
        allHref={allHref}
        showAmount={!["pr", "rfq", "grn", "challan"].includes(kind)}
      />
    </div>
  );
}

async function SiteStock({ user, projectId, sp }: { user: Actor; projectId: string; sp: SP }) {
  const caps = locationCapabilities(user);
  const [balances, reservations] = await Promise.all([listLocationBalances(user, { projectId, q: str(sp.q), page: Number(sp.page) || 1, pageSize: Number(sp.pageSize) || 50 }), listReservations(user, { projectId, status: "ACTIVE" })]);
  const positions = balances.rows.map((b) => ({ id: b.itemBrandId, itemCode: b.item.code, itemName: b.item.name, brandName: b.brand.name, unit: b.item.unit, currentQty: b.onHand }));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Site stock</h2>
          <p className="text-sm text-muted-foreground">Material held at this project&apos;s site store, what is reserved for it, and consumption at site.</p>
        </div>
        {can(user, "stock.consume") && positions.length > 0 && <ConsumptionButton projectId={projectId} positions={positions} today={todayString()} />}
      </div>
      <FilterBar params={["q"]} className="mb-0">
        <SearchInput placeholder="Search item or brand…" />
      </FilterBar>
      <LocationBalancesTable rows={balances.rows} />
      <Pagination total={balances.total} page={balances.page} pageSize={balances.pageSize} />
      <div>
        <h2 className="mb-2 text-sm font-semibold">Stock reserved for this project</h2>
        <ReservationsTable rows={reservations} canRelease={caps.canReserve} />
      </div>
    </div>
  );
}

async function AccountsTab({ user, projectId }: { user: Actor; projectId: string }) {
  if (!can(user, "accounts.view")) return <EmptyState title="No access to project accounts" description="Ask an administrator for the Project accounts permission." />;
  const [dash, txns] = await Promise.all([projectAccountsDashboard(user, projectId), projectTransactions(user, projectId, 100)]);
  const { client: c, supplier: s, summary: f } = dash;
  const tile = (label: string, value: string | null, hint?: string, tone?: "bad" | "good") => (
    <div key={label}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("font-semibold tabular-nums", tone === "bad" && "text-rose-700", tone === "good" && "text-emerald-700")}>{value === null ? "—" : formatINR(value)}</dd>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">Operational project accounts from approved documents — not a general ledger. Purchase orders are commitments, not expenses; the contract value is not revenue until it is invoiced.</p>
        <PdfButtons href={`/api/documents/pdf?type=project_accounts&id=${projectId}`} />
      </div>
      {c && (
        <Section title="Client side" actions={can(user, "payments.manage") ? <RecordClientPaymentButton projectId={projectId} partyId={c.clients.length === 1 ? c.clients[0]!.id : null} /> : null}>
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            {tile("Contract value", c.contractValue)}
            {tile("Total billed", c.invoiced, "issued tax invoices")}
            {tile("Payment received", c.paymentReceived, "allocated + advances")}
            {tile("Outstanding invoices", c.outstandingBilled, cmpMoney(c.overdue, "0") > 0 ? `${formatINR(c.overdue)} overdue` : undefined, cmpMoney(c.overdue, "0") > 0 ? "bad" : undefined)}
            {tile("Unbilled amount", c.unbilled)}
            {tile("Advances", c.clientAdvances, "not yet set against invoices")}
            {tile("Total remaining payment", c.remainingContract)}
          </dl>
          {c.nextMilestone && <p className="mt-3 text-sm text-muted-foreground">Next payment milestone: <span className="font-medium text-foreground">{c.nextMilestone.label}</span> ({c.nextMilestone.soNumber}) — {formatINR(c.nextMilestone.dueNow)} to receive.</p>}
        </Section>
      )}
      <Section title="Supplier side">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          {tile("PO value", s.poValue, "commitment, not an expense")}
          {tile("Supplier bills", s.supplierBills)}
          {tile("Payments made", s.paymentsMade)}
          {tile("Advances", s.advances, "paid, not yet set against bills")}
          {tile("Outstanding to suppliers", s.outstanding)}
        </dl>
      </Section>
      <Section title="Project financial summary (excl. GST)">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          {tile("Actual material cost", f.materialCost, "material that reached the project")}
          {tile("Other project expenses", f.otherExpenses, "services, labour, freight on supplier bills")}
          {tile("Estimated remaining costs", f.estRemaining, f.unpricedLines ? `${f.unpricedLines} line(s) without a price not included` : "open requirements × last rate")}
          {tile("Estimated profit", f.estProfit, f.estProfitPct !== null ? `${f.estProfitPct}% of contract ${formatINR(f.contractTaxable)}` : undefined, cmpMoney(f.estProfit, "0") < 0 ? "bad" : "good")}
          {tile("Recognised revenue", f.revenue, "invoiced, excl. GST")}
          {tile("Actual margin", f.actualMargin, f.actualMarginPct !== null ? `${f.actualMarginPct}% of invoiced revenue` : "after the first invoice")}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">General-stock purchases count as project cost only when the material is issued to this project.</p>
      </Section>
      <Section title="Transaction history" bodyClassName="p-0">
        {txns.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Record</th>
                  <th className="px-3 py-2 text-left font-medium">Party</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Proofs</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {txns.map((t) => (
                  <tr key={t.key}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(t.date)}</td>
                    <td className="px-3 py-2">
                      <Link href={t.href} className="font-medium hover:text-primary hover:underline">{t.number}</Link>
                      <div className="text-xs text-muted-foreground">{t.kind}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{t.party ?? "—"}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", t.flow === "IN" && "text-emerald-700", t.flow === "OUT" && "text-rose-700")}>{t.amount === null ? "—" : `${t.flow === "IN" ? "+" : t.flow === "OUT" ? "−" : ""}${formatINR(t.amount)}`}</td>
                    <td className="px-3 py-2"><DocStatusBadge status={t.status} /></td>
                    <td className="px-3 py-2 text-right text-xs">{t.proofs ? <Link href={`${t.href}#documents`} className="text-primary hover:underline">{t.proofs} file{t.proofs > 1 ? "s" : ""}</Link> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <p className="text-sm">
        <Link href="/accounts" className="text-primary hover:underline">
          Compare all projects and open party ledgers →
        </Link>
      </p>
    </div>
  );
}

async function Documents({ user, projectId, sp }: { user: Actor; projectId: string; sp: SP }) {
  const docs = await listProjectDocuments(user, projectId, { category: str(sp.category), page: Number(sp.page) || 1 });
  return (
    <section aria-label="Project documents" className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Documents & proofs</h2>
        <p className="text-sm text-muted-foreground">Every file attached to this project or any of its documents — photos, signed challans, invoices, certifications.</p>
      </div>
      <FilterBar params={["category"]} className="mb-0">
        <FilterSelect param="category" label="Category" options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))} />
      </FilterBar>
      {docs.rows.length === 0 ? (
        <EmptyState title="No documents yet" description="Files attached to orders, receipts, bills and invoices of this project appear here." />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {docs.rows.map((d) => {
            const href = entityHref(d.entityType, d.entityId);
            return (
              <li key={d.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-3">
                <a href={`/api/attachments/${d.id}`} target="_blank" rel="noopener" className="min-w-0 truncate font-medium hover:text-primary hover:underline">
                  {d.fileName}
                </a>
                <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[d.category as AttachmentCategory] ?? d.category}</span>
                {href ? (
                  <Link href={href} className="text-xs text-primary hover:underline">
                    {entityLabel(d.entityType)}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">{entityLabel(d.entityType)}</span>
                )}
                <span className="flex items-center gap-2 sm:ml-auto">
                  <DocStatusBadge status={d.verificationStatus === "PENDING" ? "OPEN" : d.verificationStatus} label={d.verificationStatus === "PENDING" ? "Not verified" : undefined} />
                  <span className="text-xs whitespace-nowrap text-muted-foreground">
                    {d.uploadedBy} · {formatDate(d.createdAt)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Pagination total={docs.total} page={docs.page} pageSize={docs.pageSize} />
    </section>
  );
}

async function CommercialActivity({ user, projectId }: { user: Actor; projectId: string }) {
  const items = await projectCommercialActivity(user, projectId, 100);
  return <ActivityTimeline items={items} title="Commercial & stock activity" linkEntities />;
}

async function Team({ user, projectId }: { user: Actor; projectId: string }) {
  const team = await projectTeam(user, projectId);
  const others = team.members.filter((m) => m.user.id !== team.manager?.id);
  return (
    <section aria-label="Project team" className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Team</h2>
        <p className="text-sm text-muted-foreground">People working on this project. Members can raise requisitions, receipts and other documents for it.</p>
      </div>
      <ul className="divide-y rounded-xl border bg-card">
        {team.manager && (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <span className="font-medium">{team.manager.fullName}</span>
            <span className="text-xs text-muted-foreground">{team.manager.designation}</span>
            <span className="ml-auto rounded-md border bg-primary/5 px-2 py-0.5 text-xs text-primary">Project manager</span>
          </li>
        )}
        {others.map((m) => (
          <li key={m.user.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <span className="font-medium">{m.user.fullName}</span>
            <span className="text-xs text-muted-foreground">
              {m.user.designation ?? ""} {m.user.employeeCode}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {m.user.role.name}
              {m.user.status !== "ACTIVE" ? " · inactive" : ""}
            </span>
          </li>
        ))}
        {!team.manager && others.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No team members yet. Edit the project to add members.</li>}
      </ul>
    </section>
  );
}

async function ProjectTasks({ projectId, userId: actor, sp, compact, canCreate }: { projectId: string; userId: Actor; sp: Record<string, string | string[] | undefined>; compact?: boolean; canCreate: boolean }) {
  const [result, departments] = await Promise.all([listTasks(actor, { ...sp, projectId }), compact ? Promise.resolve([]) : listDepartmentOptions(actor)]);
  return (
    <section aria-label="Project tasks">
      {compact ? (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Project tasks</h2>
          <Link href={`/projects/${projectId}?tab=tasks`} className="text-sm text-primary hover:underline">
            View all with filters
          </Link>
        </div>
      ) : (
        <FilterBar params={["q", "status", "departmentId", "priority"]}>
          <SearchInput placeholder="Search tasks…" />
          <FilterSelect param="status" label="Status" options={Object.entries(TASK_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
          <FilterSelect param="departmentId" label="Department" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
        </FilterBar>
      )}
      <TaskTable
        rows={result.rows.map((r) => toTaskRow(r))}
        hide={["project", "startDate"]}
        empty={
          <EmptyState
            title="No tasks yet"
            description="Tasks created for this project appear here."
            action={
              canCreate ? (
                <Button asChild size="sm">
                  <Link href={`/tasks/new?projectId=${projectId}`}>
                    <Plus /> Create task
                  </Link>
                </Button>
              ) : undefined
            }
          />
        }
      />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </section>
  );
}

async function StatusHistory({ userId: actor, projectId, page }: { userId: Actor; projectId: string; page: number }) {
  const history = await listStatusUpdates(actor, projectId, page);
  if (!history.total) return <EmptyState title="No status history" description="Status updates posted on the Overview tab are kept here permanently." />;
  return (
    <section aria-label="Status history">
      <ol className="relative space-y-4 border-l pl-6">
        {history.rows.map((u, i) => (
          <li key={u.id} className="relative">
            <span className={`absolute top-1.5 -left-[29px] size-2.5 rounded-full border-2 border-card ${i === 0 && page === 1 ? "bg-primary" : "bg-muted-foreground/40"}`} aria-hidden />
            <div className="rounded-xl border bg-card p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{u.author.fullName}</span>
                <span>{formatDateTime(u.createdAt)}</span>
                {i === 0 && page === 1 && <span className="rounded bg-primary/10 px-1.5 py-px font-medium text-primary">Current</span>}
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-line">{u.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <Pagination total={history.total} page={history.page} pageSize={history.pageSize} />
    </section>
  );
}

async function Activity({ userId: actor, projectId }: { userId: Actor; projectId: string }) {
  const items = await projectActivity(actor, projectId);
  if (!items.length) return <EmptyState title="No activity yet" />;
  return (
    <ul className="divide-y rounded-xl border bg-card" aria-label="Project activity">
      {items.map((a) => (
        <li key={a.id} className="flex flex-col gap-0.5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-3">
          <span className="w-44 shrink-0 text-xs text-muted-foreground">{formatDateTime(a.at)}</span>
          <span className="font-medium">{a.actor}</span>
          {a.href ? (
            <Link href={a.href} className="text-muted-foreground hover:text-foreground hover:underline">
              {a.text}
            </Link>
          ) : (
            <span className="text-muted-foreground">{a.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
