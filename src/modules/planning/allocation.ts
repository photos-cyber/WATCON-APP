import "server-only";
import type { db, Tx } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { addQty, cmpQty, fmtQty, qtyUnits, subQty } from "@/lib/money";

/**
 * Line-level allocation of procurement documents to material requirements (project or general
 * inventory). One requirement can be covered by several documents; one document (a combined PO or
 * RFQ without a project) can cover requirements of several projects and general stock — each line
 * carries its own `requirement_id`.
 *
 * Allocated quantity of a requirement =
 *   Σ requisition lines (live requisitions; a closed requisition counts what was ordered)
 * + Σ PO lines raised directly (not via a requisition line; a short-closed PO counts what was accepted)
 * + Σ RFQ lines raised directly, while the enquiry is open: the part not yet on a live PO from it
 *   (a quotation converted for part of the quantity keeps the rest allocated to the enquiry).
 *
 * Lines that came from a requisition line are counted once, through the requisition. This is the
 * single guard against double allocation / duplicate ordering: no document may push a requirement's
 * allocated quantity above its required quantity.
 */

const NONE = "00000000-0000-0000-0000-000000000000";

export type AllocationExclude = { prId?: string | null; poId?: string | null; rfqId?: string | null };

export async function allocatedByRequirement(tx: Tx | typeof db, requirementIds: string[], exclude: AllocationExclude = {}): Promise<Map<string, string>> {
  if (!requirementIds.length) return new Map();
  const rows = await tx.$queryRaw<{ id: string; qty: string }[]>`
    SELECT a.req_id::text AS id, SUM(a.qty)::text AS qty FROM (
      SELECT pl.requirement_id AS req_id, CASE WHEN pr.status = 'CLOSED' THEN pl.ordered_qty ELSE pl.quantity END AS qty
      FROM pr_lines pl JOIN purchase_requisitions pr ON pr.id = pl.pr_id
      WHERE pl.requirement_id = ANY(${requirementIds}::uuid[]) AND pr.status NOT IN ('CANCELLED','REJECTED') AND pr.id <> ${exclude.prId ?? NONE}::uuid
      UNION ALL
      SELECT pol.requirement_id, CASE WHEN po.status = 'CLOSED' THEN pol.accepted_qty ELSE pol.quantity END
      FROM po_lines pol JOIN purchase_orders po ON po.id = pol.po_id
      WHERE pol.requirement_id = ANY(${requirementIds}::uuid[]) AND pol.pr_line_id IS NULL AND po.status <> 'CANCELLED' AND po.id <> ${exclude.poId ?? NONE}::uuid
      UNION ALL
      SELECT rl.requirement_id, GREATEST(rl.quantity - COALESCE((SELECT SUM(xl.quantity) FROM po_lines xl JOIN quotation_lines xq ON xq.id = xl.quotation_line_id JOIN purchase_orders xp ON xp.id = xl.po_id WHERE xq.rfq_line_id = rl.id AND xp.status <> 'CANCELLED'), 0), 0)
      FROM rfq_lines rl JOIN rfqs r ON r.id = rl.rfq_id
      WHERE rl.requirement_id = ANY(${requirementIds}::uuid[]) AND rl.pr_line_id IS NULL AND r.id <> ${exclude.rfqId ?? NONE}::uuid
        AND r.status IN ('DRAFT','SENT','RESPONSES_IN','AWARD_PENDING','AWARDED')
    ) a GROUP BY a.req_id`;
  return new Map(rows.map((r) => [r.id, fmtQty(qtyUnits(r.qty))]));
}

export type AllocationLine = { requirementId: string | null; itemBrandId: string; quantity: string; prLineId?: string | null; quotationLineId?: string | null };

/**
 * Validates requirement links on a document's lines inside the caller's transaction (rows locked):
 *   - the requirement exists in the organisation, is OPEN and is for the same item–brand;
 *   - a document raised for a project may only cover that project's requirements;
 *   - allocated (other documents) + this document ≤ required quantity.
 * Lines derived from a requisition line are skipped (the requisition already holds the allocation).
 * A PO line ordered from a quotation of an enquiry raised for the same requirement takes over the
 * enquiry's open quantity (moved, not added); only any excess over that open quantity is new.
 */
export async function assertAllocations(tx: Tx, organizationId: string, doc: { projectId: string | null; label: string }, lines: AllocationLine[], exclude: AllocationExclude = {}) {
  const direct = lines.filter((l) => l.requirementId && !l.prLineId);
  if (!direct.length) return;
  const ids = [...new Set(direct.map((l) => l.requirementId!))];
  const reqs = await tx.$queryRaw<{ id: string; organization_id: string; project_id: string | null; item_brand_id: string; required_qty: string; status: string; project_code: string | null; item_name: string }[]>`
    SELECT r.id::text, r.organization_id::text, r.project_id::text, r.item_brand_id::text, r.required_qty::text, r.status::text, p.code AS project_code, i.name AS item_name
    FROM material_requirements r
    JOIN items i ON i.id = r.item_id
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE r.id = ANY(${ids}::uuid[])
    ORDER BY r.id
    FOR UPDATE OF r`;
  const byId = new Map(reqs.map((r) => [r.id, { ...r, required_qty: fmtQty(qtyUnits(r.required_qty)) }]));
  // Open enquiry quantity each quotation line can take over (same requirement, enquiry still open).
  const qlIds = [...new Set(direct.map((l) => l.quotationLineId).filter((x): x is string => !!x))];
  const takeOver = new Map<string, { rfqLineId: string; requirementId: string | null; open: string }>();
  if (qlIds.length) {
    const rows = await tx.$queryRaw<{ ql: string; rl: string; req: string | null; open: string }[]>`
      SELECT ql.id::text AS ql, rl.id::text AS rl, rl.requirement_id::text AS req,
        GREATEST(rl.quantity - COALESCE((SELECT SUM(xl.quantity) FROM po_lines xl JOIN quotation_lines xq ON xq.id = xl.quotation_line_id JOIN purchase_orders xp ON xp.id = xl.po_id
          WHERE xq.rfq_line_id = rl.id AND xp.status <> 'CANCELLED' AND xp.id <> ${exclude.poId ?? NONE}::uuid), 0), 0)::text AS open
      FROM quotation_lines ql JOIN rfq_lines rl ON rl.id = ql.rfq_line_id JOIN rfqs r ON r.id = rl.rfq_id
      WHERE ql.id = ANY(${qlIds}::uuid[]) AND rl.pr_line_id IS NULL AND r.status IN ('DRAFT','SENT','RESPONSES_IN','AWARD_PENDING','AWARDED')`;
    for (const r of rows) takeOver.set(r.ql, { rfqLineId: r.rl, requirementId: r.req, open: fmtQty(qtyUnits(r.open)) });
  }
  const openLeft = new Map<string, string>();
  const wanted = new Map<string, string>();
  for (const [i, l] of lines.entries()) {
    if (!l.requirementId || l.prLineId) continue;
    const r = byId.get(l.requirementId);
    if (!r || r.organization_id !== organizationId) throw new ValidationError("A planning requirement linked to this document was not found.", { [`lines.${i}.requirementId`]: "Not found." });
    if (r.status !== "OPEN") throw new ValidationError(`The requirement for ${r.item_name} is closed. Reopen it in material planning first.`, { [`lines.${i}.requirementId`]: "Requirement closed." });
    if (r.item_brand_id !== l.itemBrandId) throw new ValidationError(`Line ${i + 1} must be the same item and brand as its planning requirement (${r.item_name}).`, { [`lines.${i}.itemBrandId`]: "Different item–brand from the requirement." });
    if (doc.projectId && r.project_id !== doc.projectId) throw new ValidationError(`Line ${i + 1} (${r.item_name}) is planned for ${r.project_code ?? "general stock"}, not this project. Raise a combined order without a project instead.`, { [`lines.${i}.requirementId`]: "Different project." });
    let added = l.quantity;
    const t = l.quotationLineId ? takeOver.get(l.quotationLineId) : undefined;
    if (t && t.requirementId === r.id) {
      const open = openLeft.get(t.rfqLineId) ?? t.open;
      const moved = cmpQty(open, added) < 0 ? open : added;
      openLeft.set(t.rfqLineId, subQty(open, moved));
      added = subQty(added, moved);
    }
    wanted.set(r.id, addQty(wanted.get(r.id) ?? "0", added));
  }
  const already = await allocatedByRequirement(tx, ids, exclude);
  for (const [id, qty] of wanted) {
    const r = byId.get(id)!;
    const used = already.get(id) ?? "0";
    if (cmpQty(addQty(used, qty), r.required_qty) > 0) {
      const left = cmpQty(r.required_qty, used) > 0 ? subQty(r.required_qty, used) : "0";
      throw new ValidationError(`${r.item_name} (${r.project_code ?? "general stock"}): only ${left} left to order — required ${r.required_qty}, already on requisitions, enquiries or orders ${used}. ${doc.label} would order it twice.`, { lines: "More than the planned requirement." });
    }
  }
}
