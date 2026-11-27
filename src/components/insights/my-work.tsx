import { ArrowRight, Inbox, PackageCheck, Truck } from "lucide-react";
import Link from "next/link";
import { db } from "@/lib/db";
import { can, type Actor } from "@/lib/permissions/definitions";
import { projectAccessWhere } from "@/lib/permissions/scopes";
import { listApprovals, listSoAmendmentRequests } from "@/modules/insights/approvals";
import { startOfToday } from "@/modules/tasks/rules";

/** Dashboard card: what is waiting on this user across modules (approvals, receipts, late deliveries). */
export async function MyWork({ user }: { user: Actor }) {
  const showApprovals = can(user, "approvals.view") || user.role === "SUPER_ADMIN";
  const projectScope = can(user, "projects.view_all") ? {} : { project: { is: projectAccessWhere(user) } };
  const [approvals, amendments, overdue] = await Promise.all([
    showApprovals ? listApprovals(user) : Promise.resolve([]),
    showApprovals ? listSoAmendmentRequests(user) : Promise.resolve([]),
    can(user, "po.view") ? db.purchaseOrder.count({ where: { organizationId: user.organizationId, ...projectScope, status: { in: ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] }, expectedDate: { lt: startOfToday() } } }) : Promise.resolve(0),
  ]);
  const toApprove = approvals.filter((a) => a.mine && a.kind !== "grn").length + amendments.filter((a) => a.mine).length;
  const toVerify = approvals.filter((a) => a.mine && a.kind === "grn").length;
  const tiles = [
    showApprovals && { href: "/approvals", icon: Inbox, label: "Waiting for your approval", value: toApprove, tone: toApprove > 0 },
    showApprovals && can(user, "grn.post") && { href: "/approvals?kind=grn", icon: PackageCheck, label: "Site receipts to confirm", value: toVerify, tone: toVerify > 0 },
    can(user, "po.view") && { href: "/reports?r=pending-deliveries", icon: Truck, label: "Overdue supplier deliveries", value: overdue, tone: overdue > 0 },
  ].filter(Boolean) as { href: string; icon: typeof Inbox; label: string; value: number; tone: boolean }[];
  if (!tiles.length) return null;
  return (
    <section aria-label="My work" className="mb-6 rounded-xl border bg-card">
      <h2 className="border-b px-5 py-3 text-sm font-semibold">My work</h2>
      <div className="grid gap-px bg-border sm:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="flex items-center gap-3 bg-card px-5 py-4 hover:bg-muted/40">
            <t.icon className={t.tone ? "size-5 text-amber-600" : "size-5 text-muted-foreground"} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className={t.tone ? "text-xl font-semibold text-amber-700 tabular-nums" : "text-xl font-semibold tabular-nums"}>{t.value}</p>
              <p className="text-xs text-muted-foreground">{t.label}</p>
            </div>
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
          </Link>
        ))}
      </div>
    </section>
  );
}
