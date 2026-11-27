import type { Metadata } from "next";
import { PageHeader } from "@/components/shared/page-header";
import { SiteIssueForm } from "@/components/stores/site-issue-form";
import { requirePagePermission } from "@/lib/auth/session";
import { orNotFound } from "@/lib/pages";
import { siteIssueData } from "@/modules/stores/site-issue";

export const metadata: Metadata = { title: "Issue material to site" };

export default async function IssueToSitePage({ params, searchParams }: PageProps<"/projects/[projectId]/issue">) {
  const user = await requirePagePermission("stock.transfer");
  const { projectId } = await params;
  const sp = await searchParams;
  const data = await orNotFound(siteIssueData(user, projectId, typeof sp.from === "string" ? sp.from : null));
  return (
    <>
      <PageHeader
        title="Issue material to site"
        description="Sales-order materials for this project with what was already issued, what remains and what the warehouse can give. Issuing moves stock from the warehouse into transit; the site receives it with photos and the signed challan."
        breadcrumbs={[{ label: "Projects", href: "/projects" }, { label: data.project.code, href: `/projects/${data.project.id}` }, { label: "Issue material" }]}
      />
      <SiteIssueForm projectId={data.project.id} projectName={`${data.project.code} – ${data.project.name}`} warehouses={data.warehouses} fromLocationId={data.fromLocationId} rows={data.rows} />
    </>
  );
}
