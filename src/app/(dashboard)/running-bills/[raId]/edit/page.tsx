import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { RaForm } from "@/components/sales/ra-ui";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { addQty } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { getRaBill, raPrefill } from "@/modules/sales/ra-bill";

export const metadata: Metadata = { title: "Edit running bill" };

export default async function EditRunningBillPage({ params }: PageProps<"/running-bills/[raId]/edit">) {
  const user = await requirePagePermission("rabill.manage");
  const { raId } = await params;
  const { bill, can } = await orNotFound(getRaBill(user, raId));
  if (!can.edit || !bill.clientPoId) redirect(`/running-bills/${bill.id}`);
  const pre = await orNotFound(raPrefill(user, bill.clientPoId));
  const own = new Map(bill.lines.map((l) => [l.clientPoLineId ?? "", l]));
  // This bill's own claim is not "already billed" while editing it.
  const lines = pre.lines.map((l) => ({ ...l, leftQty: addQty(l.leftQty, own.get(l.clientPoLineId)?.claimedQty ?? "0") }));
  return (
    <>
      <PageHeader title={`Edit ${bill.number} (RA-${bill.raNumber})`} breadcrumbs={[...projectCrumbs(bill.project, "running-bills"), { label: bill.number, href: `/running-bills/${bill.id}` }, { label: "Edit" }]} />
      <RaForm
        clientPoId={bill.clientPoId!}
        raId={bill.id}
        version={bill.version}
        lines={lines}
        terms={{ retentionPct: pre.clientPo.retentionPct, advanceRecoveryPct: pre.clientPo.advanceRecoveryPct }}
        initial={{
          billDate: bill.billDate.toISOString().slice(0, 10),
          periodFrom: bill.periodFrom.toISOString().slice(0, 10),
          periodTo: bill.periodTo.toISOString().slice(0, 10),
          otherDeductions: bill.otherDeductions === "0.00" ? "" : bill.otherDeductions,
          deductionNotes: bill.deductionNotes ?? "",
          remarks: bill.remarks ?? "",
          claims: Object.fromEntries(bill.lines.map((l) => [l.clientPoLineId, { claimedQty: l.claimedQty, measurementRef: l.measurementRef ?? "", remarks: l.remarks ?? "" }])),
        }}
      />
    </>
  );
}
