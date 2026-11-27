import { BookOpen } from "lucide-react";
import { RecordClientPaymentButton } from "@/components/payables/client-account";
import { can } from "@/lib/permissions/definitions";
import type { Metadata } from "next";
import Link from "next/link";
import { Money, Section } from "@/components/commercial/ui";
import { KpiDefinitions } from "@/components/insights/command-center";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/states";
import { UrlTabs } from "@/components/shared/url-tabs";
import { FilterBar, FilterSelect } from "@/components/tables/filters";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { cmpMoney, formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { partyLedger, projectAccountsSummary } from "@/modules/insights/accounts";
import { KPI_HELP } from "@/modules/insights/finance";
import { partyOptions } from "@/modules/parties/service";
import { listProjectOptions } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Accounts" };

const drCr = (v: string) => {
  const c = cmpMoney(v, "0");
  return c === 0 ? formatINR("0") : `${formatINR(c < 0 ? v.replace("-", "") : v)} ${c > 0 ? "Dr" : "Cr"}`;
};

export default async function AccountsPage({ searchParams }: PageProps<"/accounts">) {
  const user = await requirePagePermission("accounts.view");
  const sp = await searchParams;
  const partyId = typeof sp.partyId === "string" ? sp.partyId : undefined;
  const tab = sp.tab === "ledger" || partyId ? "ledger" : "projects";
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Operational project accounts and party ledgers, built from approved bills, invoices, payments and notes. This is a sub-ledger for tracking, not a general ledger."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Accounts" }]}
        actions={can(user, "payments.manage") ? <RecordClientPaymentButton /> : undefined}
      />
      <UrlTabs current={tab} tabs={[{ key: "projects", label: "Project accounts" }, { key: "ledger", label: "Party ledger" }]} />
      {tab === "projects" ? <ProjectsTable user={user} /> : <Ledger user={user} partyId={partyId} projectId={typeof sp.projectId === "string" ? sp.projectId : undefined} />}
    </>
  );
}

type User = Awaited<ReturnType<typeof requirePagePermission>>;

async function ProjectsTable({ user }: { user: User }) {
  const { rows, totals } = await projectAccountsSummary(user);
  const cols = [
    ["contractValue", "Contract"],
    ["billed", "Billed"],
    ["received", "Received"],
    ["receivable", "Receivable"],
    ["committed", "Committed"],
    ["supplierBilled", "Supplier billed"],
    ["paid", "Paid"],
    ["payable", "Payable"],
    ["margin", "Margin"],
  ] as const;
  if (!rows.length) return <EmptyState title="No projects" description="Projects you can access appear here with their billing and payment position." />;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="sticky left-0 bg-muted/40 px-3 py-2 text-left font-medium">Project</th>
              {cols.map(([k, l]) => (
                <th key={k} className="px-3 py-2 text-right font-medium whitespace-nowrap" title={KPI_HELP[k]}>
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.project.id} className="hover:bg-muted/30">
                <td className="sticky left-0 bg-card px-3 py-2">
                  <Link href={`/projects/${r.project.id}?tab=accounts`} className="font-medium hover:text-primary hover:underline">
                    {r.project.code}
                  </Link>
                  <div className="max-w-48 truncate text-xs text-muted-foreground">{r.project.name}</div>
                </td>
                {cols.map(([k]) => (
                  <td key={k} className={cn("px-3 py-2 text-right", (k === "receivable" || k === "payable") && cmpMoney(r[k], "0") > 0 && "text-amber-700", k === "margin" && cmpMoney(r[k], "0") < 0 && "text-rose-700")}>
                    <Money value={r[k]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 bg-muted/30 font-semibold">
            <tr>
              <td className="sticky left-0 bg-muted/30 px-3 py-2">Total</td>
              {cols.map(([k]) => (
                <td key={k} className="px-3 py-2 text-right">
                  <Money value={totals[k]} />
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <KpiDefinitions items={cols.map(([k, l]) => ({ label: l, help: KPI_HELP[k] }))} />
    </div>
  );
}

async function Ledger({ user, partyId, projectId }: { user: User; partyId?: string; projectId?: string }) {
  const [parties, projects] = await Promise.all([partyOptions(user, "any"), listProjectOptions(user)]);
  const ledger = partyId ? await partyLedger(user, { partyId, projectId }).catch(() => null) : null;
  return (
    <div className="space-y-4">
      <FilterBar params={["partyId", "projectId"]}>
        <FilterSelect param="partyId" label="Party" allLabel="Choose…" options={parties.map((p) => ({ value: p.id, label: p.name }))} />
        <FilterSelect param="projectId" label="Project" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />
      </FilterBar>
      {!ledger ? (
        <EmptyState icon={BookOpen} title="Choose a client or supplier" description="The ledger lists every approved bill, invoice, payment, receipt and note with that party, with a running balance." />
      ) : (
        <Section
          title={`${ledger.party.name}${ledger.party.gstin ? ` · ${ledger.party.gstin}` : ""}`}
          actions={<span className="text-sm">Closing balance: <strong className="tabular-nums">{drCr(ledger.closing)}</strong></span>}
          bodyClassName="p-0"
        >
          <p className="border-b px-4 py-2 text-xs text-muted-foreground">Dr = the party owes us (receivable). Cr = we owe the party (payable). Debit: invoices, our payments, supplier notes. Credit: supplier bills, client receipts, client credit notes.</p>
          {ledger.entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">No approved transactions with this party yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Document</th>
                    <th className="px-3 py-2 text-left font-medium">Project</th>
                    <th className="px-3 py-2 text-left font-medium">Details</th>
                    <th className="px-3 py-2 text-right font-medium">Debit</th>
                    <th className="px-3 py-2 text-right font-medium">Credit</th>
                    <th className="px-3 py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ledger.entries.map((e) => (
                    <tr key={e.key}>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(e.date)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Link href={e.href} className="font-medium hover:text-primary hover:underline">
                          {e.number}
                        </Link>
                        <div className="text-xs text-muted-foreground">{e.type}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{e.project ?? "—"}</td>
                      <td className="max-w-xs truncate px-3 py-2 text-muted-foreground">{e.description}</td>
                      <td className="px-3 py-2 text-right">{cmpMoney(e.debit, "0") ? <Money value={e.debit} /> : ""}</td>
                      <td className="px-3 py-2 text-right">{cmpMoney(e.credit, "0") ? <Money value={e.credit} /> : ""}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{drCr(e.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 bg-muted/30 font-semibold">
                  <tr>
                    <td className="px-3 py-2" colSpan={4}>
                      Total
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money value={ledger.totalDebit} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Money value={ledger.totalCredit} />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{drCr(ledger.closing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
