import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { fmtQty, qtyUnits } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { ForbiddenError } from "@/lib/errors";

/**
 * Item–brand stock overview (workflow v2 · Phase 5), all from balances, reservations and POs:
 *   physical    warehouse + site stores (usable stock you can touch)
 *   reserved    open reservations (any location)
 *   available   warehouse stock not reserved for any project
 *   incoming    approved POs not yet received (ordered − accepted)
 *   inTransit   on challans dispatched but not yet received
 *   site        at project site stores
 *   damaged     in quarantine (damaged in transit / held)
 *   reorderQty  when available + incoming ≤ minimum (reorder level): target (else minimum) − that
 */
export const overviewQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  filter: z.enum(["all", "reorder", "in-stock"]).catch("all").default("all"),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).catch(50).default(50),
});

export type OverviewRow = {
  itemBrandId: string;
  item: { id: string; code: string; name: string; unit: string };
  brand: string;
  physical: string;
  reserved: string;
  available: string;
  incoming: string;
  inTransit: string;
  site: string;
  damaged: string;
  reorderLevel: string | null;
  targetStock: string | null;
  reorderQty: string;
};

export async function stockOverview(actor: Actor, raw: unknown) {
  if (!can(actor, "items.view")) throw new ForbiddenError();
  const q = overviewQuerySchema.parse(raw ?? {});
  const like = q.q ? `%${q.q}%` : null;
  const rows = await db.$queryRaw<{ id: string; item_id: string; code: string; name: string; unit: string; brand: string; reorder_level: string | null; target_stock: string | null; warehouse: string; site: string; transit: string; quarantine: string; reserved: string; reserved_wh: string; incoming: string }[]>`
    SELECT ib.id::text, i.id::text AS item_id, i.code, i.name, i.unit, b.name AS brand, ib.reorder_level::text, ib.target_stock::text,
      COALESCE((SELECT SUM(sb.on_hand) FROM stock_balances sb JOIN stock_locations l ON l.id = sb.location_id WHERE sb.item_brand_id = ib.id AND l.type = 'WAREHOUSE'), 0)::text AS warehouse,
      COALESCE((SELECT SUM(sb.on_hand) FROM stock_balances sb JOIN stock_locations l ON l.id = sb.location_id WHERE sb.item_brand_id = ib.id AND l.type = 'SITE'), 0)::text AS site,
      COALESCE((SELECT SUM(sb.on_hand) FROM stock_balances sb JOIN stock_locations l ON l.id = sb.location_id WHERE sb.item_brand_id = ib.id AND l.type = 'TRANSIT'), 0)::text AS transit,
      COALESCE((SELECT SUM(sb.on_hand) FROM stock_balances sb JOIN stock_locations l ON l.id = sb.location_id WHERE sb.item_brand_id = ib.id AND l.type = 'QUARANTINE'), 0)::text AS quarantine,
      COALESCE((SELECT SUM(r.quantity - r.issued_qty) FROM stock_reservations r WHERE r.item_brand_id = ib.id AND r.status = 'ACTIVE'), 0)::text AS reserved,
      COALESCE((SELECT SUM(r.quantity - r.issued_qty) FROM stock_reservations r JOIN stock_locations l ON l.id = r.location_id WHERE r.item_brand_id = ib.id AND r.status = 'ACTIVE' AND l.type = 'WAREHOUSE'), 0)::text AS reserved_wh,
      COALESCE((SELECT SUM(GREATEST(pl.quantity - pl.accepted_qty, 0)) FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id WHERE pl.item_brand_id = ib.id AND po.status IN ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_RECEIVED')), 0)::text AS incoming
    FROM item_brands ib JOIN items i ON i.id = ib.item_id JOIN brands b ON b.id = ib.brand_id
    WHERE ib.organization_id = ${actor.organizationId}::uuid AND i.status = 'ACTIVE'
      AND (${like}::text IS NULL OR i.name ILIKE ${like} OR i.code ILIKE ${like} OR b.name ILIKE ${like})
    ORDER BY i.name, b.name`;
  const Z = BigInt(0);
  const all: OverviewRow[] = rows.map((r) => {
    const u = qtyUnits;
    const available = u(r.warehouse) - u(r.reserved_wh) > Z ? u(r.warehouse) - u(r.reserved_wh) : Z;
    const projected = available + u(r.incoming);
    const minimum = r.reorder_level !== null ? u(r.reorder_level) : null;
    const target = r.target_stock !== null ? u(r.target_stock) : minimum;
    const reorder = minimum !== null && target !== null && projected <= minimum && target > projected ? target - projected : Z;
    return {
      itemBrandId: r.id,
      item: { id: r.item_id, code: r.code, name: r.name, unit: r.unit },
      brand: r.brand,
      physical: fmtQty(u(r.warehouse) + u(r.site)),
      reserved: fmtQty(u(r.reserved)),
      available: fmtQty(available),
      incoming: fmtQty(u(r.incoming)),
      inTransit: fmtQty(u(r.transit)),
      site: fmtQty(u(r.site)),
      damaged: fmtQty(u(r.quarantine)),
      reorderLevel: r.reorder_level !== null ? fmtQty(u(r.reorder_level)) : null,
      targetStock: r.target_stock !== null ? fmtQty(u(r.target_stock)) : null,
      reorderQty: fmtQty(reorder),
    };
  });
  const filtered = all.filter((r) => (q.filter === "reorder" ? r.reorderQty !== "0" : q.filter === "in-stock" ? r.physical !== "0" || r.inTransit !== "0" || r.damaged !== "0" : true));
  return { rows: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: filtered.length, page: q.page, pageSize: q.pageSize, query: q, reorderCount: all.filter((r) => r.reorderQty !== "0").length };
}
