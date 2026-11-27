import "server-only";
import { db, type Prisma } from "@/lib/db";
import { can, type Actor } from "@/lib/permissions/definitions";
import { projectRequiredScoped } from "@/modules/commercial/core";

/** Sales orders that drove a procurement document, via requisition lines → material requirements → SO lines. */
export async function traceSalesOrders(actor: Actor, opts: { prIds?: (string | null | undefined)[]; prLineIds?: (string | null | undefined)[]; requirementIds?: (string | null | undefined)[] }) {
  const prIds = [...new Set(opts.prIds?.filter((x): x is string => !!x) ?? [])];
  const prLineIds = [...new Set(opts.prLineIds?.filter((x): x is string => !!x) ?? [])];
  const requirementIds = [...new Set(opts.requirementIds?.filter((x): x is string => !!x) ?? [])];
  if (!prIds.length && !prLineIds.length && !requirementIds.length) return [];
  const viaPr = prIds.length || prLineIds.length ? [{ prLines: { some: { OR: [...(prIds.length ? [{ prId: { in: prIds } }] : []), ...(prLineIds.length ? [{ id: { in: prLineIds } }] : [])] } } }] : [];
  // Lines ordered straight from planning carry their requirement (workflow v2), no requisition needed.
  const viaReq = requirementIds.length ? [{ id: { in: requirementIds } }] : [];
  return db.salesOrder.findMany({
    where: {
      AND: [
        projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput,
        { lines: { some: { requirements: { some: { OR: [...viaPr, ...viaReq] } } } } },
      ],
    },
    orderBy: { orderDate: "asc" },
    select: { id: true, number: true },
    take: 20,
  });
}

export type TracedDoc = { type: string; id: string; number: string; status: string; href: string };

type PrLineTrace = {
  pr: { id: string; number: string; status: string };
  rfqLines: { rfq: { id: string; number: string; status: string } }[];
  poLines: { po: { id: string; number: string; status: string }; grnLines: { grn: { id: string; number: string; status: string } }[] }[];
};

const prLineTraceSelect = {
  pr: { select: { id: true, number: true, status: true } },
  rfqLines: { select: { rfq: { select: { id: true, number: true, status: true } } } },
  poLines: { select: { po: { select: { id: true, number: true, status: true } }, grnLines: { select: { grn: { select: { id: true, number: true, status: true } } } } } },
} satisfies Prisma.PrLineSelect;

/** Flattens requisition lines into a de-duplicated PR → RFQ → PO → receipt document list. */
function flatten(lines: PrLineTrace[], include: { pr: boolean }): TracedDoc[] {
  const out = new Map<string, TracedDoc>();
  const add = (d: TracedDoc) => out.set(`${d.type}:${d.id}`, d);
  for (const l of lines) {
    if (include.pr) add({ type: "Requisition", id: l.pr.id, number: l.pr.number, status: l.pr.status, href: `/purchase-requisitions/${l.pr.id}` });
    for (const r of l.rfqLines) add({ type: "Rate enquiry", id: r.rfq.id, number: r.rfq.number, status: r.rfq.status, href: `/rate-enquiries/${r.rfq.id}` });
    for (const p of l.poLines) {
      add({ type: "Purchase order", id: p.po.id, number: p.po.number, status: p.po.status, href: `/purchase-orders/${p.po.id}` });
      for (const g of p.grnLines) add({ type: "Site receipt", id: g.grn.id, number: g.grn.number, status: g.grn.status, href: `/site-receipts/${g.grn.id}` });
    }
  }
  const order = ["Requisition", "Rate enquiry", "Purchase order", "Site receipt"];
  return [...out.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.number.localeCompare(b.number));
}

/**
 * Procurement documents behind a sales order. Material is planned per project and item–brand
 * (the same basis as the SO's fulfilment panel), so this follows the project's requirements for
 * the SO's item–brands through requisition lines to RFQs, POs and site receipts.
 * Callers must already have checked that the actor can see the sales order.
 */
export async function procurementForSalesOrder(organizationId: string, projectId: string, itemBrandIds: string[]): Promise<TracedDoc[]> {
  if (!itemBrandIds.length) return [];
  const lines = await db.prLine.findMany({
    where: { pr: { organizationId, projectId }, requirement: { projectId, itemBrandId: { in: itemBrandIds } } },
    select: prLineTraceSelect,
    take: 200,
  });
  return flatten(lines, { pr: true });
}

/** RFQs, POs and site receipts raised from a requisition's lines (callers check PR visibility). */
export async function procurementForRequisition(organizationId: string, prId: string): Promise<TracedDoc[]> {
  const lines = await db.prLine.findMany({ where: { prId, pr: { organizationId } }, select: prLineTraceSelect, take: 200 });
  return flatten(lines, { pr: false });
}

const VIEW_PERMISSION: Record<string, "pr.view" | "rfq.view" | "po.view" | "grn.view"> = {
  Requisition: "pr.view",
  "Rate enquiry": "rfq.view",
  "Purchase order": "po.view",
  "Site receipt": "grn.view",
};

/** Keeps only the traced documents this actor may open, so related-document links never lead to a 403. */
export function visibleTraced(actor: Actor, docs: TracedDoc[]): TracedDoc[] {
  return docs.filter((d) => can(actor, VIEW_PERMISSION[d.type]!));
}

/** Sales orders behind a site receipt / bill: PO lines → requisition lines → requirements → SO lines. */
export async function traceSalesOrdersForPoLines(actor: Actor, poLineIds: (string | null | undefined)[]) {
  const ids = [...new Set(poLineIds.filter((x): x is string => !!x))];
  if (!ids.length) return [];
  const lines = await db.poLine.findMany({ where: { id: { in: ids }, po: { organizationId: actor.organizationId } }, select: { prLineId: true, po: { select: { prId: true } } } });
  return traceSalesOrders(actor, { prIds: lines.map((l) => l.po.prId), prLineIds: lines.map((l) => l.prLineId) });
}
