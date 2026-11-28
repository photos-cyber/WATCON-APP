import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SummaryCards } from "@/components/commercial/ui";
import { NoteTable } from "@/components/payables/tables";
import { PageHeader } from "@/components/shared/page-header";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { can } from "@/lib/permissions/definitions";
import { listNotes } from "@/modules/payables/notes";
import { listProjectOptions } from "@/modules/projects/service";
import { payablesCrumbs } from "@/components/payables/crumbs";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Credit & debit notes" };

export default async function NotesPage({ searchParams }: PageProps<"/notes">) {
  const user = await requireUser();
  if (!can(user, "bills.view") && !can(user, "invoice.view")) redirect("/dashboard?denied=1");
  const sp = await searchParams;
  const [r, projects] = await Promise.all([listNotes(user, sp), listProjectOptions(user)]);
  const project = projects.find((p) => p.id === r.query.projectId) ?? null;
  return (
    <>
      <PageHeader
        title="Credit & debit notes"
        description="Adjustments that reduce what is owed on a supplier bill or a client invoice."
        breadcrumbs={payablesCrumbs(project, "notes")}
        actions={
          (can(user, "bills.manage") || can(user, "invoice.manage")) && (
            <Button asChild size="sm">
              <Link href={`/notes/new${r.query.projectId ? `?projectId=${r.query.projectId}` : ""}`}>
                <Plus /> New note
              </Link>
            </Button>
          )
        }
      />
      <SummaryCards items={[{ label: "Drafts to apply", value: r.drafts, tone: r.drafts ? "warn" : "default", href: "/notes?status=DRAFT" }]} />
      <FilterBar params={project ? ["q", "partyRole", "status"] : ["q", "partyRole", "status", "projectId"]}>
        <SearchInput placeholder="Search number, party or reason…" />
        <FilterSelect param="partyRole" label="Side" options={[{ value: "SUPPLIER", label: "Supplier" }, { value: "CLIENT", label: "Client" }]} />
        <FilterSelect param="status" label="Status" options={[{ value: "DRAFT", label: "draft" }, { value: "APPROVED", label: "approved" }, { value: "CANCELLED", label: "cancelled" }]} />
        {!project && <FilterSelect param="projectId" label="Project" options={projects.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))} />}
      </FilterBar>
      <NoteTable rows={r.rows} />
      <Pagination total={r.total} page={r.page} pageSize={r.pageSize} />
    </>
  );
}
