import "server-only";
import { writeAudit } from "@/lib/audit";
import { db, type Tx } from "@/lib/db";

/**
 * Project progress & status driven by the sales order (the project's driver).
 *
 * Progress = value delivered to the client ÷ sales order value, over the project's approved
 * sales orders and their material lines (lines with an item; services can't be delivered by
 * challan). Delivered quantity is net of returns and capped at the ordered quantity; values use
 * the saved line taxable amounts. Projects without a sales order fall back to task progress.
 */

const DRIVING_SO = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"];
const APPROVED_PO = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED"];

export type DeliveryProgress = { progress: number; orderValue: string; deliveredValue: string };

export async function deliveryProgressByProject(projectIds: string[]): Promise<Map<string, DeliveryProgress>> {
  const map = new Map<string, DeliveryProgress>();
  if (!projectIds.length) return map;
  const rows = await db.$queryRaw<{ project_id: string; order_value: string; delivered_value: string }[]>`
    SELECT so.project_id::text AS project_id,
           COALESCE(SUM(l.taxable), 0)::text AS order_value,
           COALESCE(SUM(CASE WHEN l.quantity > 0
             THEN l.taxable * LEAST(GREATEST(l.delivered_qty - l.returned_qty, 0), l.quantity) / l.quantity
             ELSE 0 END), 0)::numeric(18,2)::text AS delivered_value
    FROM so_lines l
    JOIN sales_orders so ON so.id = l.so_id
    WHERE so.project_id = ANY(${projectIds}::uuid[])
      AND so.status::text = ANY(${DRIVING_SO}::text[])
      AND l.item_brand_id IS NOT NULL
    GROUP BY so.project_id`;
  for (const r of rows) {
    const order = Number(r.order_value);
    if (order <= 0) continue;
    const pct = Math.round((Number(r.delivered_value) / order) * 100);
    map.set(r.project_id, { progress: Math.min(100, Math.max(0, pct)), orderValue: r.order_value, deliveredValue: r.delivered_value });
  }
  return map;
}

/**
 * Moves the project status forward automatically:
 *   PLANNING → ACTIVE      when a sales order or a purchase order is approved;
 *   ACTIVE   → COMPLETED   when every approved sales order is fully delivered (or closed) and at
 *                          least one was actually fulfilled.
 * ON_HOLD, CANCELLED and COMPLETED are never changed here, so manual decisions always stand.
 */
export async function advanceProjectStatus(tx: Tx, projectId: string | null | undefined, actorId: string | null) {
  if (!projectId) return;
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, organizationId: true, code: true, status: true, archivedAt: true } });
  if (!project || project.archivedAt || !["PLANNING", "ACTIVE"].includes(project.status)) return;

  const sos = await tx.salesOrder.findMany({ where: { projectId, status: { in: DRIVING_SO as never } }, select: { status: true } });
  let next = project.status;
  if (project.status === "PLANNING") {
    const approvedPo = sos.length ? 0 : await tx.purchaseOrder.count({ where: { projectId, status: { in: APPROVED_PO as never } } });
    if (sos.length || approvedPo) next = "ACTIVE";
  }
  if (sos.length && sos.every((s) => s.status === "FULFILLED" || s.status === "CLOSED") && sos.some((s) => s.status === "FULFILLED")) next = "COMPLETED";
  if (next === project.status) return;

  await tx.project.update({ where: { id: projectId }, data: { status: next } });
  const why = next === "COMPLETED" ? "all approved sales orders are fully delivered" : "work started (approved sales order / purchase order)";
  await writeAudit({ organizationId: project.organizationId, actorId, action: "project.status_auto", entityType: "project", entityId: projectId, projectId, summary: `${project.code} status changed automatically: ${project.status.toLowerCase()} → ${next.toLowerCase()} (${why})` }, tx);
}
