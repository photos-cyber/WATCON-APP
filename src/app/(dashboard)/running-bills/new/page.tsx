import type { Metadata } from "next";
import { SoRunningBillForm } from "@/components/sales/so-ra-ui";
import { getSalesOrder, salesOrderOptions } from "@/modules/sales/sales-order";
import { soRunningBillPreview } from "@/modules/sales/so-running-bill";
import Link from "next/link";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { RaForm } from "@/components/sales/ra-ui";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/states";
import { requirePagePermission } from "@/lib/auth/session";
import { orNotFound } from "@/lib/pages";
import { todayString } from "@/modules/inventory/serialize";
import { listProjectOptions } from "@/modules/projects/service";
import { legacyClientPoBilling, raPrefill } from "@/modules/sales/ra-bill";

export const metadata: Metadata = { title: "New running bill" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function NewRunningBillPage({ searchParams }: PageProps<"/running-bills/new">) {
  const user = await requirePagePermission("rabill.manage");
  const sp = await searchParams;
  const clientPoId = str(sp.clientPoId);
  const soId = str(sp.soId);
  if (soId) {
    // Cumulative running bill on a sales order (client PO optional): built from delivered material.
    const pre = await orNotFound(soRunningBillPreview(user, soId));
    const so = await orNotFound(getSalesOrder(user, soId));
    return (
      <>
        <PageHeader title={pre.draft ? `Refresh running bill ${pre.draft.number}` : "New running bill"} description={`${so.so.number} · ${so.so.party.name} — material delivered to site / client and services, at the sales-order rates.`} breadcrumbs={[...projectCrumbs(so.so.project, "running-bills", { label: "Running bills", href: "/running-bills" }), { label: "New running bill" }]} />
        {pre.statement.hasFinal ? (
          <EmptyState title="Final bill already raised" description="The final running bill for this sales order exists. Cancel it first to bill again." />
        ) : (
          <SoRunningBillForm soId={soId} lines={pre.lines} statement={pre.statement} draftNumber={pre.draft?.number ?? null} />
        )}
      </>
    );
  }
  if (!clientPoId) {
    // A running bill is raised on a confirmed sales order (client PO optional). Legacy contracts that are
    // already billed on their client PO's own running bills are listed separately to continue there.
    const projectId = str(sp.projectId);
    const [orders, legacy, projects] = await Promise.all([salesOrderOptions(user, projectId ? { projectId } : {}), legacyClientPoBilling(user, projectId), listProjectOptions(user)]);
    const project = projects.find((p) => p.id === projectId);
    const groups = [
      { title: "Sales orders", items: orders.map((o) => ({ ...o, href: `/running-bills/new?soId=${o.id}` })) },
      ...(legacy.length ? [{ title: "Client PO contracts already billed on the client PO", items: legacy.map((o) => ({ ...o, href: `/running-bills/new?clientPoId=${o.id}` })) }] : []),
    ];
    return (
      <>
        <PageHeader title="New running bill" description="Choose the confirmed sales order to bill. Client, rates, GST and delivered material are filled in from it — a client PO is not needed." breadcrumbs={[...projectCrumbs(project, "running-bills", { label: "Running bills", href: "/running-bills" }), { label: "New running bill" }]} />
        <form className="mb-4 flex flex-wrap items-end gap-2" action="/running-bills/new">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select name="projectId" defaultValue={projectId ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm">
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 text-sm hover:bg-muted/40">Show orders</button>
        </form>
        {orders.length + legacy.length === 0 ? (
          <EmptyState title="No confirmed sales order" description="Confirm a sales order first. Running bills are generated from its delivered material and services." />
        ) : (
          groups.map((g) => (
            <section key={g.title} className="mb-4">
              <h2 className="mb-2 text-sm font-semibold">{g.title}</h2>
              <ul className="divide-y rounded-xl border bg-card">
                {g.items.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">None</li>}
                {g.items.map((p) => (
                  <li key={p.id}>
                    <Link href={p.href} className="flex flex-col px-4 py-3 text-sm hover:bg-muted/40">
                      <span className="font-medium">{p.label}</span>
                      <span className="text-xs text-muted-foreground">{p.hint}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </>
    );
  }
  const pre = await orNotFound(raPrefill(user, clientPoId));
  const projects = await listProjectOptions(user);
  const proj = projects.find((p) => p.code === pre.clientPo.project.code) ?? null;
  return (
    <>
      <PageHeader title={`New running bill RA-${pre.nextRa}`} description={`${pre.clientPo.clientPoNumber} · ${pre.clientPo.party}`} breadcrumbs={[...projectCrumbs(proj, "running-bills", { label: "Running bills", href: "/running-bills" }), { label: "New running bill" }]} />
      {pre.pendingBills > 0 && <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">{pre.pendingBills} earlier bill{pre.pendingBills === 1 ? " is" : "s are"} still open on this contract. Quantities already claimed are shown as billed.</p>}
      <RaForm clientPoId={pre.clientPo.id} lines={pre.lines} terms={{ retentionPct: pre.clientPo.retentionPct, advanceRecoveryPct: pre.clientPo.advanceRecoveryPct }} initial={{ billDate: todayString(), periodFrom: pre.periodFrom, periodTo: todayString(), otherDeductions: "", deductionNotes: "", remarks: "", claims: {} }} />
    </>
  );
}
