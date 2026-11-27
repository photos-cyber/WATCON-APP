import type { Metadata } from "next";
import { listCrumbs, lockedProject } from "@/components/procurement/crumbs";
import { MrpSection } from "@/components/planning/mrp-section";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { listProjectOptions } from "@/modules/projects/service";

export const metadata: Metadata = { title: "Material planning" };

export default async function MaterialPlanningPage({ searchParams }: PageProps<"/material-planning">) {
  const user = await requirePagePermission("mrp.view");
  const sp = await searchParams;
  const locked = lockedProject(await listProjectOptions(user), sp);
  return (
    <>
      <PageHeader
        title="Material planning"
        description={locked ? `Requirements for ${locked.code} – ${locked.name}, each traced to its sales order, against stock, open orders and site receipts.` : "Project requirements (created automatically from approved sales orders) and general warehouse stock, against stock, reservations and open orders. Order several projects and general stock together — each line stays allocated."}
        breadcrumbs={listCrumbs(locked, "material-planning")}
      />
      <MrpSection user={user} sp={sp} projectId={locked?.id} basePath={locked ? `/material-planning?projectId=${locked.id}` : "/material-planning"} />
    </>
  );
}
