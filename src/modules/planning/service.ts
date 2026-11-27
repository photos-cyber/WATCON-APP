import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { addMoney, addQty, cmpQty, fmtQty, qtyTimesRate, qtyUnits } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { projectAccessWhere } from "@/lib/permissions/scopes";
import { PRIORITIES, dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { assertProjectUsable, assertProjectVisible, dec3, dec4, parseInput, requirePermission } from "@/modules/commercial/core";
import { qtyOrZero } from "@/modules/commercial/pricing";
import { quantity } from "@/modules/inventory/validation";
import { startOfToday } from "@/modules/tasks/rules";
import { allocatedByRequirement } from "./allocation";
import { computeGeneral, computeMrp, type MrpResult } from "./mrp";

// ─────────────────────────── Requirements ───────────────────────────

const requirementSchema = z.object({
  /** Empty = general inventory (warehouse stock, no project). */
  projectId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  itemBrandId: uuid,
  requiredQty: quantity,
  requiredBy: z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
  priority: z.enum(PRIORITIES).default("MEDIUM"),
  notes: optionalText("Notes", 500),
});

/**
 * Adds a requirement, or updates the existing one for the same project + item–brand. Without a
 * project it is a general-inventory purchase quantity (one open requirement per item–brand).
 * The quantity can never go below what is already on requisitions, enquiries or orders for it.
 */
export async function saveRequirement(actor: Actor, input: unknown) {
  requirePermission(actor, "mrp.manage");
  const data = parseInput(requirementSchema, input);
  const project = data.projectId ? await assertProjectUsable(actor, data.projectId) : null;
  const ib = await db.itemBrand.findFirst({ where: { id: data.itemBrandId, organizationId: actor.organizationId }, include: { item: { select: { name: true, status: true, unit: true } }, brand: { select: { name: true, status: true } } } });
  if (!ib) throw new NotFoundError("Item–brand");
  const where = project ? `for ${project.code}` : "for general stock";
  try {
    return await db.$transaction(async (tx) => {
      const existing = data.projectId
        ? await tx.materialRequirement.findUnique({ where: { projectId_itemBrandId: { projectId: data.projectId, itemBrandId: data.itemBrandId } } })
        : await tx.materialRequirement.findFirst({ where: { organizationId: actor.organizationId, projectId: null, itemBrandId: data.itemBrandId, status: "OPEN" } });
      if (existing) {
        await tx.$queryRaw`SELECT id FROM material_requirements WHERE id = ${existing.id}::uuid FOR UPDATE`;
        const used = (await allocatedByRequirement(tx, [existing.id])).get(existing.id) ?? "0";
        if (cmpQty(data.requiredQty, used) < 0) throw new ValidationError(`${used} ${ib.item.unit} is already on requisitions, enquiries or orders for this requirement, so it cannot be set lower.`, { requiredQty: `Minimum ${used}.` });
      }
      const row = existing
        ? await tx.materialRequirement.update({ where: { id: existing.id }, data: { requiredQty: data.requiredQty, requiredBy: toDbDate(data.requiredBy), priority: data.priority, notes: data.notes, status: "OPEN", version: { increment: 1 } } })
        : await tx.materialRequirement.create({ data: { organizationId: actor.organizationId, projectId: data.projectId, itemBrandId: ib.id, itemId: ib.itemId, requiredQty: data.requiredQty, requiredBy: toDbDate(data.requiredBy), priority: data.priority, notes: data.notes, createdById: actor.id } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: existing ? "requirement.updated" : "requirement.created", entityType: "material_requirement", entityId: row.id, projectId: data.projectId, summary: `${existing ? "Updated" : "Added"} requirement ${data.requiredQty} ${ib.item.unit} ${ib.item.name} (${ib.brand.name}) ${where}${existing ? ` (was ${dec3(existing.requiredQty)})` : ""}` }, tx);
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("This item–brand was just added by someone else. Reload and edit it.");
    throw e;
  }
}

export async function setRequirementStatus(actor: Actor, id: string, status: "OPEN" | "CLOSED" | "CANCELLED") {
  requirePermission(actor, "mrp.manage");
  const r = await db.materialRequirement.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!r) throw new NotFoundError("Requirement");
  if (r.projectId) await assertProjectUsable(actor, r.projectId);
  try {
    await db.$transaction(async (tx) => {
      await tx.materialRequirement.update({ where: { id }, data: { status, version: { increment: 1 } } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `requirement.${status.toLowerCase()}`, entityType: "material_requirement", entityId: id, projectId: r.projectId, summary: `Requirement marked ${status.toLowerCase()}` }, tx);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Another open general-stock requirement exists for this item–brand. Edit that one instead.");
    throw e;
  }
}

const generalQtySchema = z.object({ itemBrandId: uuid, quantity: qtyOrZero, notes: optionalText("Notes", 500) });

/**
 * Manual general-inventory purchase quantity: "still to order" for an item–brand without a project.
 * Stored on the item–brand's OPEN general requirement as allocated + quantity, so what is already on
 * order is never asked for again. 0 clears the outstanding manual quantity.
 */
export async function setGeneralPurchaseQty(actor: Actor, input: unknown) {
  requirePermission(actor, "mrp.manage");
  const data = parseInput(generalQtySchema, input);
  const ib = await db.itemBrand.findFirst({ where: { id: data.itemBrandId, organizationId: actor.organizationId }, include: { item: { select: { name: true, unit: true, status: true } }, brand: { select: { name: true, status: true } } } });
  if (!ib) throw new NotFoundError("Item–brand");
  if (ib.item.status !== "ACTIVE" || ib.brand.status !== "ACTIVE") throw new ValidationError(`${ib.item.name} (${ib.brand.name}) is inactive.`, { itemBrandId: "Inactive." });
  try {
    return await db.$transaction(async (tx) => {
      const [existing] = await tx.$queryRaw<{ id: string; required_qty: string }[]>`
        SELECT id::text, required_qty::text FROM material_requirements
        WHERE organization_id = ${actor.organizationId}::uuid AND item_brand_id = ${ib.id}::uuid AND project_id IS NULL AND status = 'OPEN' FOR UPDATE`;
      if (!existing && cmpQty(data.quantity, "0") === 0) return null;
      const used = existing ? ((await allocatedByRequirement(tx, [existing.id])).get(existing.id) ?? "0") : "0";
      const required = addQty(used, data.quantity);
      const row = existing
        ? await tx.materialRequirement.update({ where: { id: existing.id }, data: { requiredQty: required, ...(data.notes !== null ? { notes: data.notes } : {}), version: { increment: 1 } } })
        : await tx.materialRequirement.create({ data: { organizationId: actor.organizationId, projectId: null, itemBrandId: ib.id, itemId: ib.itemId, requiredQty: required, notes: data.notes ?? "General stock", createdById: actor.id } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: existing ? "requirement.updated" : "requirement.created", entityType: "material_requirement", entityId: row.id, projectId: null, summary: `General stock: ${data.quantity} ${ib.item.unit} ${ib.item.name} (${ib.brand.name}) to order${existing ? ` (requested ${existing.required_qty} → ${required})` : ""}` }, tx);
      return row;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Someone else just updated this item. Reload and try again.");
    throw e;
  }
}

// ─────────────────────────── MRP ───────────────────────────

export const PLAN_SCOPES = ["project", "general", "all"] as const;

export const mrpQuerySchema = z.object({
  projectId: uuid.optional().catch(undefined),
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  view: z.enum(["open", "all"]).catch("open").default("open"),
  /** project = project requirements (default) · general = general inventory · all = both. */
  scope: z.enum(PLAN_SCOPES).catch("project").default("project"),
});

type Key = string;
const k = (...parts: (string | null)[]) => parts.map((p) => p ?? "-").join(":");

export type MrpRow = {
  /** Stable row id: the requirement id, or `gen:<itemBrandId>` for a general-stock line without one yet. */
  rowKey: string;
  scope: "PROJECT" | "GENERAL";
  requirementId: string | null;
  project: { id: string; code: string; name: string } | null;
  salesOrder: { id: string; number: string } | null;
  itemBrandId: string;
  item: { id: string; code: string; name: string; unit: string; image: string | null };
  brand: { id: string; name: string };
  requiredQty: string;
  requiredBy: string | null;
  priority: string;
  reqStatus: string;
  notes: string | null;
  /** Issued to the project (received at / sent to site, incl. consumed); 0 for general stock. */
  issuedQty: string;
  /** Free warehouse stock (projects) / warehouse stock not reserved (general). */
  availableStock: string;
  /** Reserved for this project (projects) / warehouse stock reserved for projects (general). */
  reservedStock: string;
  totalPhysical: string;
  usable: string;
  reservedForOthers: string;
  projectReserved: string;
  freeStock: string;
  incoming: string;
  expectedDate: string | null;
  poPipeline: string;
  openPr: string;
  openRfq: string;
  issuedToSite: string;
  inTransit: string;
  receivedAtSite: string;
  siteStock: string;
  consumed: string;
  returned: string;
  damagedRejected: string;
  lastPurchaseRate: string | null;
  gstRate: string | null;
  estimatedCost: string | null;
  preferredSupplier: { id: string; name: string } | null;
  reorderLevel: string | null;
  /** Most that may still be ordered for a project line (null = no cap: general stock). */
  maxOrderQty: string | null;
  minStock: string | null;
  targetStock: string | null;
  suggestedQty: string | null;
  manualQty: string | null;
  manualLeft: string | null;
} & MrpResult;

const itemSelect = { id: true, code: true, name: true, unit: true, gstRate: true, images: { select: { path: true }, orderBy: { sortOrder: "asc" as const }, take: 1 } } as const;
const ibSelect = { id: true, currentQty: true, reorderLevel: true, targetStock: true, lastPurchaseRate: true, preferredSupplier: { select: { id: true, name: true } }, item: { select: itemSelect }, brand: { select: { id: true, name: true } } } as const;
type IbRow = Prisma.ItemBrandGetPayload<{ select: typeof ibSelect }>;

/**
 * Material planning across project requirements and/or general inventory. Every figure is
 * aggregated in PostgreSQL from the ledger, balances, reservations, POs, requisitions, enquiries,
 * challans and GRNs; nothing is computed from client data. Order / requisition / enquiry lines are
 * attributed through their requirement link (combined orders keep line-level allocations); unlinked
 * lines count for the document's project, or general stock when it has none.
 */
export async function getMrp(actor: Actor, raw: unknown) {
  requirePermission(actor, "mrp.view");
  const q = mrpQuerySchema.parse(raw ?? {});
  if (q.projectId) await assertProjectVisible(actor, q.projectId);
  const wantProject = q.scope !== "general" || !!q.projectId;
  const wantGeneral = q.scope !== "project" && !q.projectId;
  const ins = "insensitive" as const;
  const search = q.q ? [{ itemBrand: { item: { name: { contains: q.q, mode: ins } } } }, { itemBrand: { item: { code: { contains: q.q, mode: ins } } } }, { itemBrand: { brand: { name: { contains: q.q, mode: ins } } } }] : null;
  const reqs = wantProject
    ? await db.materialRequirement.findMany({
        where: {
          organizationId: actor.organizationId,
          projectId: q.projectId ?? { not: null },
          ...(q.view === "open" ? { status: "OPEN" } : {}),
          project: { is: projectAccessWhere(actor) },
          ...(search ? { OR: [...search, { project: { code: { contains: q.q!, mode: ins } } }] } : {}),
        },
        orderBy: [{ requiredBy: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        take: 2000,
        include: { project: { select: { id: true, code: true, name: true } }, salesOrderLine: { select: { so: { select: { id: true, number: true } } } }, itemBrand: { select: ibSelect } },
      })
    : [];
  const genReqs = wantGeneral ? await db.materialRequirement.findMany({ where: { organizationId: actor.organizationId, projectId: null, status: "OPEN", ...(search ? { OR: search } : {}) }, include: { itemBrand: { select: ibSelect } }, take: 2000 }) : [];
  const genIbs: IbRow[] = wantGeneral
    ? await db.itemBrand.findMany({
        where: {
          organizationId: actor.organizationId,
          OR: [{ reorderLevel: { not: null } }, { targetStock: { not: null } }],
          item: { status: "ACTIVE" },
          brand: { status: "ACTIVE" },
          ...(q.q ? { AND: [{ OR: [{ item: { name: { contains: q.q, mode: ins } } }, { item: { code: { contains: q.q, mode: ins } } }, { brand: { name: { contains: q.q, mode: ins } } }] }] } : {}),
        },
        select: ibSelect,
        take: 2000,
      })
    : [];
  const general = new Map<string, { ib: IbRow; req: (typeof genReqs)[number] | null }>();
  for (const ib of genIbs) general.set(ib.id, { ib, req: null });
  for (const r of genReqs) general.set(r.itemBrandId, { ib: r.itemBrand, req: r });
  if (!reqs.length && !general.size) return { rows: [] as MrpRow[], summary: summarize([]), query: q };

  const ibIds = [...new Set([...reqs.map((r) => r.itemBrandId), ...general.keys()])];
  const [balances, reservations, pos, prs, rfqs, siteMoves, challans, damaged, lastPo, manualAlloc] = await Promise.all([
    db.$queryRaw<{ ib: string; type: string; project_id: string | null; qty: string }[]>`
      SELECT b.item_brand_id::text AS ib, l.type::text AS type, l.project_id::text AS project_id, SUM(b.on_hand)::text AS qty
      FROM stock_balances b JOIN stock_locations l ON l.id = b.location_id
      WHERE b.item_brand_id = ANY(${ibIds}::uuid[]) GROUP BY 1, 2, 3`,
    db.$queryRaw<{ ib: string; project_id: string; type: string; qty: string }[]>`
      SELECT r.item_brand_id::text AS ib, r.project_id::text AS project_id, l.type::text AS type, SUM(r.quantity - r.issued_qty)::text AS qty
      FROM stock_reservations r JOIN stock_locations l ON l.id = r.location_id
      WHERE r.status = 'ACTIVE' AND r.item_brand_id = ANY(${ibIds}::uuid[]) GROUP BY 1, 2, 3`,
    db.$queryRaw<{ ib: string; project_id: string | null; approved: boolean; qty: string; expected: Date | null }[]>`
      SELECT pl.item_brand_id::text AS ib, (CASE WHEN mr.id IS NOT NULL THEN mr.project_id ELSE po.project_id END)::text AS project_id,
        (po.status IN ('APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_RECEIVED')) AS approved,
        SUM(GREATEST(pl.quantity - pl.accepted_qty, 0))::text AS qty, MIN(po.expected_date) AS expected
      FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      LEFT JOIN pr_lines prl ON prl.id = pl.pr_line_id
      LEFT JOIN material_requirements mr ON mr.id = COALESCE(pl.requirement_id, prl.requirement_id)
      WHERE pl.item_brand_id = ANY(${ibIds}::uuid[]) AND po.status IN ('DRAFT','PENDING_APPROVAL','REJECTED','APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_RECEIVED')
      GROUP BY 1, 2, 3`,
    db.$queryRaw<{ ib: string; project_id: string | null; qty: string }[]>`
      SELECT pl.item_brand_id::text AS ib, (CASE WHEN mr.id IS NOT NULL THEN mr.project_id ELSE pr.project_id END)::text AS project_id, SUM(GREATEST(pl.quantity - pl.ordered_qty, 0))::text AS qty
      FROM pr_lines pl JOIN purchase_requisitions pr ON pr.id = pl.pr_id
      LEFT JOIN material_requirements mr ON mr.id = pl.requirement_id
      WHERE pl.item_brand_id = ANY(${ibIds}::uuid[]) AND pr.status IN ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_ORDERED')
      GROUP BY 1, 2`,
    // Enquiries raised directly from planning, still open: the part not yet on a live PO from them.
    db.$queryRaw<{ ib: string; project_id: string | null; qty: string }[]>`
      SELECT rl.item_brand_id::text AS ib, mr.project_id::text AS project_id, SUM(GREATEST(rl.quantity - COALESCE((SELECT SUM(xl.quantity) FROM po_lines xl JOIN quotation_lines xq ON xq.id = xl.quotation_line_id JOIN purchase_orders xp ON xp.id = xl.po_id WHERE xq.rfq_line_id = rl.id AND xp.status <> 'CANCELLED'), 0), 0))::text AS qty
      FROM rfq_lines rl JOIN rfqs r ON r.id = rl.rfq_id JOIN material_requirements mr ON mr.id = rl.requirement_id
      WHERE rl.item_brand_id = ANY(${ibIds}::uuid[]) AND rl.pr_line_id IS NULL
        AND r.status IN ('DRAFT','SENT','RESPONSES_IN','AWARD_PENDING','AWARDED')
      GROUP BY 1, 2`,
    // Effective movement type: a reversal counts against the type it reversed.
    db.$queryRaw<{ ib: string; project_id: string; etype: string; qty: string }[]>`
      SELECT m.item_brand_id::text AS ib, l.project_id::text AS project_id, COALESCE(o.type, m.type)::text AS etype,
        SUM(CASE WHEN m.type = 'REVERSAL' THEN -m.quantity ELSE m.quantity END)::text AS qty
      FROM stock_transactions m
      JOIN stock_locations l ON l.id = m.location_id AND l.type = 'SITE'
      LEFT JOIN stock_transactions o ON o.id = m.reversal_of_id
      WHERE m.item_brand_id = ANY(${ibIds}::uuid[])
      GROUP BY 1, 2, 3`,
    db.$queryRaw<{ ib: string; project_id: string; issued: string; transit: string }[]>`
      SELECT cl.item_brand_id::text AS ib, l.project_id::text AS project_id,
        SUM(cl.quantity)::text AS issued, SUM(GREATEST(cl.quantity - cl.received_qty - cl.written_off_qty, 0))::text AS transit
      FROM challan_lines cl JOIN challans c ON c.id = cl.challan_id JOIN stock_locations l ON l.id = c.to_location_id AND l.type = 'SITE'
      WHERE cl.item_brand_id = ANY(${ibIds}::uuid[]) AND c.status IN ('DISPATCHED','PARTIALLY_RECEIVED','RECEIVED','CLOSED')
      GROUP BY 1, 2`,
    db.$queryRaw<{ ib: string; project_id: string; qty: string }[]>`
      SELECT gl.item_brand_id::text AS ib, g.project_id::text AS project_id, SUM(gl.damaged_qty + gl.rejected_qty)::text AS qty
      FROM grn_lines gl JOIN grns g ON g.id = gl.grn_id
      WHERE gl.item_brand_id = ANY(${ibIds}::uuid[]) AND g.status = 'POSTED' AND g.project_id IS NOT NULL
      GROUP BY 1, 2`,
    db.$queryRaw<{ ib: string; rate: string; party_id: string; party_name: string }[]>`
      SELECT DISTINCT ON (pl.item_brand_id) pl.item_brand_id::text AS ib, pl.rate::text AS rate, p.id::text AS party_id, p.name AS party_name
      FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id JOIN parties p ON p.id = po.party_id
      WHERE pl.item_brand_id = ANY(${ibIds}::uuid[]) AND po.status NOT IN ('DRAFT','REJECTED','CANCELLED')
      ORDER BY pl.item_brand_id, po.order_date DESC, po.created_at DESC`,
    allocatedByRequirement(db, genReqs.map((r) => r.id)),
  ]);

  const usable = new Map<Key, bigint>();
  const warehouse = new Map<Key, bigint>();
  const physical = new Map<Key, bigint>();
  const site = new Map<Key, bigint>();
  for (const b of balances) {
    const v = qtyUnits(b.qty);
    physical.set(b.ib, (physical.get(b.ib) ?? BigInt(0)) + v);
    if (b.type === "WAREHOUSE" || b.type === "SITE") usable.set(b.ib, (usable.get(b.ib) ?? BigInt(0)) + v);
    if (b.type === "WAREHOUSE") warehouse.set(b.ib, (warehouse.get(b.ib) ?? BigInt(0)) + v);
    if (b.type === "SITE" && b.project_id) site.set(k(b.ib, b.project_id), v);
  }
  const resAll = new Map<Key, bigint>();
  const resWarehouse = new Map<Key, bigint>();
  const resProj = new Map<Key, bigint>();
  for (const r of reservations) {
    const v = qtyUnits(r.qty);
    resAll.set(r.ib, (resAll.get(r.ib) ?? BigInt(0)) + v);
    if (r.type === "WAREHOUSE") resWarehouse.set(r.ib, (resWarehouse.get(r.ib) ?? BigInt(0)) + v);
    resProj.set(k(r.ib, r.project_id), (resProj.get(k(r.ib, r.project_id)) ?? BigInt(0)) + v);
  }
  const incoming = new Map<Key, { qty: bigint; expected: Date | null }>();
  const pipeline = new Map<Key, bigint>();
  for (const p of pos) {
    const key = k(p.ib, p.project_id);
    if (p.approved) {
      const prev = incoming.get(key);
      const expected = prev?.expected && p.expected ? (prev.expected < p.expected ? prev.expected : p.expected) : (prev?.expected ?? p.expected);
      incoming.set(key, { qty: (prev?.qty ?? BigInt(0)) + qtyUnits(p.qty), expected });
    } else pipeline.set(key, (pipeline.get(key) ?? BigInt(0)) + qtyUnits(p.qty));
  }
  const sumBy = (list: { ib: string; project_id: string | null; qty: string }[]) => {
    const m = new Map<Key, bigint>();
    for (const r of list) m.set(k(r.ib, r.project_id), (m.get(k(r.ib, r.project_id)) ?? BigInt(0)) + qtyUnits(r.qty));
    return m;
  };
  const openPr = sumBy(prs);
  const openRfq = sumBy(rfqs);
  const moves = new Map<Key, bigint>();
  for (const m of siteMoves) moves.set(k(m.ib, m.project_id, m.etype), qtyUnits(m.qty));
  const norm = (x: string) => fmtQty(qtyUnits(x));
  const ch = new Map(challans.map((c) => [k(c.ib, c.project_id), { ...c, issued: norm(c.issued), transit: norm(c.transit) }]));
  const dmg = new Map(damaged.map((d) => [k(d.ib, d.project_id), norm(d.qty)]));
  const last = new Map(lastPo.map((l) => [l.ib, l]));
  const today = startOfToday();
  const g = (m: Map<Key, bigint>, key: Key) => m.get(key) ?? BigInt(0);
  const rateOf = (ib: IbRow) => (ib.lastPurchaseRate ? dec4(ib.lastPurchaseRate) : (last.get(ib.id)?.rate ?? null));
  const supplierOf = (ib: IbRow) => {
    const l = last.get(ib.id);
    return ib.preferredSupplier ?? (l ? { id: l.party_id, name: l.party_name } : null);
  };
  const itemOf = (ib: IbRow) => ({ id: ib.item.id, code: ib.item.code, name: ib.item.name, unit: ib.item.unit, image: ib.item.images[0]?.path ?? null });
  const gstOf = (ib: IbRow) => (ib.item.gstRate ? String(Number(ib.item.gstRate)) : null);

  const projectRows: MrpRow[] = reqs.map((r) => {
    const ib = r.itemBrandId;
    const pk = k(ib, r.projectId);
    const mv = (t: string) => g(moves, k(ib, r.projectId, t));
    const receivedAtSite = mv("RECEIPT") + mv("TRANSFER_IN") + mv("INWARD") + mv("OPENING");
    // Material delivered to the client against the sales order has left site stock but has
    // fulfilled the requirement — count it with consumption, or planning would re-order it.
    const consumed = mv("CONSUMPTION") + mv("CLIENT_DELIVERY");
    const returned = mv("TRANSFER_OUT") + mv("RETURN_TO_SUPPLIER");
    // Free (available-to-promise) = warehouse stock not reserved for any project. Stock at other
    // projects' sites belongs to them; this project's site stock already counts as fulfilled.
    const freeStock = g(warehouse, ib) - g(resWarehouse, ib);
    const reservedOthers = g(resAll, ib) - g(resProj, pk);
    const inc = incoming.get(pk);
    const rate = rateOf(r.itemBrand);
    const chal = ch.get(pk);
    const result = computeMrp({
      required: dec3(r.requiredQty),
      siteStock: fmtQty(g(site, pk)),
      inTransit: chal?.transit ?? "0",
      consumed: fmtQty(consumed),
      projectReserved: fmtQty(g(resProj, pk)),
      incoming: fmtQty(inc?.qty ?? BigInt(0)),
      poPipeline: fmtQty(g(pipeline, pk)),
      openPr: fmtQty(g(openPr, pk)),
      openRfq: fmtQty(g(openRfq, pk)),
      freeStock: fmtQty(freeStock),
      receivedAtSite: fmtQty(receivedAtSite),
      damagedRejected: dmg.get(pk) ?? "0",
      expectedDate: inc?.expected ?? null,
      requiredBy: r.requiredBy,
      usableCompany: fmtQty(g(usable, ib)),
      reorderLevel: r.itemBrand.reorderLevel ? dec3(r.itemBrand.reorderLevel) : null,
      today,
    });
    const free = fmtQty(freeStock < BigInt(0) ? BigInt(0) : freeStock);
    return {
      rowKey: r.id,
      scope: "PROJECT",
      requirementId: r.id,
      project: r.project,
      salesOrder: r.salesOrderLine?.so ?? null,
      itemBrandId: ib,
      item: itemOf(r.itemBrand),
      brand: r.itemBrand.brand,
      requiredQty: dec3(r.requiredQty),
      requiredBy: r.requiredBy?.toISOString() ?? null,
      priority: r.priority,
      reqStatus: r.status,
      notes: r.notes,
      issuedQty: result.fulfilled,
      availableStock: free,
      reservedStock: fmtQty(g(resProj, pk)),
      totalPhysical: fmtQty(g(physical, ib)),
      usable: fmtQty(g(usable, ib)),
      reservedForOthers: fmtQty(reservedOthers),
      projectReserved: fmtQty(g(resProj, pk)),
      freeStock: free,
      incoming: fmtQty(inc?.qty ?? BigInt(0)),
      expectedDate: inc?.expected?.toISOString() ?? null,
      poPipeline: fmtQty(g(pipeline, pk)),
      openPr: fmtQty(g(openPr, pk)),
      openRfq: fmtQty(g(openRfq, pk)),
      issuedToSite: chal?.issued ?? "0",
      inTransit: chal?.transit ?? "0",
      receivedAtSite: fmtQty(receivedAtSite),
      siteStock: fmtQty(g(site, pk)),
      consumed: fmtQty(consumed),
      returned: fmtQty(returned),
      damagedRejected: dmg.get(pk) ?? "0",
      lastPurchaseRate: rate,
      gstRate: gstOf(r.itemBrand),
      estimatedCost: rate && cmpQty(result.toOrder, "0") > 0 ? qtyTimesRate(result.toOrder, rate) : null,
      preferredSupplier: supplierOf(r.itemBrand),
      reorderLevel: r.itemBrand.reorderLevel ? dec3(r.itemBrand.reorderLevel) : null,
      maxOrderQty: result.orderable,
      minStock: null,
      targetStock: null,
      suggestedQty: null,
      manualQty: null,
      manualLeft: null,
      ...result,
    };
  });

  const generalRows: MrpRow[] = [...general.values()].map(({ ib, req }) => {
    const gk = k(ib.id, null);
    const inc = incoming.get(gk);
    const minStock = ib.reorderLevel ? dec3(ib.reorderLevel) : null;
    const targetStock = ib.targetStock ? dec3(ib.targetStock) : null;
    const manualQty = req ? dec3(req.requiredQty) : "0";
    const res = computeGeneral({
      onHand: fmtQty(g(warehouse, ib.id)),
      reserved: fmtQty(g(resWarehouse, ib.id)),
      incoming: fmtQty(inc?.qty ?? BigInt(0)),
      pipeline: fmtQty(g(pipeline, gk) + g(openPr, gk) + g(openRfq, gk)),
      minStock,
      targetStock,
      manualQty,
      manualAllocated: req ? (manualAlloc.get(req.id) ?? "0") : "0",
    });
    const rate = rateOf(ib);
    const levels = targetStock ?? minStock ?? "0";
    return {
      rowKey: req?.id ?? `gen:${ib.id}`,
      scope: "GENERAL",
      requirementId: req?.id ?? null,
      project: null,
      salesOrder: null,
      itemBrandId: ib.id,
      item: itemOf(ib),
      brand: ib.brand,
      requiredQty: cmpQty(manualQty, levels) >= 0 ? manualQty : levels,
      requiredBy: req?.requiredBy?.toISOString() ?? null,
      priority: req?.priority ?? "MEDIUM",
      reqStatus: req?.status ?? "OPEN",
      notes: req?.notes ?? null,
      issuedQty: "0",
      availableStock: res.available,
      reservedStock: fmtQty(g(resWarehouse, ib.id)),
      totalPhysical: fmtQty(g(physical, ib.id)),
      usable: fmtQty(g(usable, ib.id)),
      reservedForOthers: fmtQty(g(resAll, ib.id)),
      projectReserved: "0",
      freeStock: res.available,
      incoming: fmtQty(inc?.qty ?? BigInt(0)),
      expectedDate: inc?.expected?.toISOString() ?? null,
      poPipeline: fmtQty(g(pipeline, gk)),
      openPr: fmtQty(g(openPr, gk)),
      openRfq: fmtQty(g(openRfq, gk)),
      issuedToSite: "0",
      inTransit: "0",
      receivedAtSite: "0",
      siteStock: "0",
      consumed: "0",
      returned: "0",
      damagedRejected: "0",
      lastPurchaseRate: rate,
      gstRate: gstOf(ib),
      estimatedCost: rate && cmpQty(res.toOrder, "0") > 0 ? qtyTimesRate(res.toOrder, rate) : null,
      preferredSupplier: supplierOf(ib),
      reorderLevel: minStock,
      maxOrderQty: null,
      minStock,
      targetStock,
      suggestedQty: res.suggested,
      manualQty,
      manualLeft: res.manualLeft,
      fulfilled: "0",
      remainingNeed: res.toOrder,
      shortage: res.toOrder,
      toOrder: res.toOrder,
      orderable: res.toOrder,
      canReserveNow: "0",
      status: res.status,
      flags: res.belowMinimum ? ["BELOW_REORDER"] : [],
      urgency: res.belowMinimum ? "HIGH" : cmpQty(res.toOrder, "0") > 0 ? "MEDIUM" : "LOW",
    };
  });
  generalRows.sort((a, b) => a.item.name.localeCompare(b.item.name) || a.brand.name.localeCompare(b.brand.name));
  const all = [...projectRows, ...generalRows];
  const filtered = q.status ? all.filter((r) => (q.status === "TO_ORDER" ? cmpQty(r.toOrder, "0") > 0 : r.status === q.status || (r.flags as string[]).includes(q.status!))) : all;
  return { rows: filtered, summary: summarize(all), query: q };
}

function summarize(rows: MrpRow[]) {
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    general: rows.filter((r) => r.scope === "GENERAL").length,
    belowMinimum: rows.filter((r) => r.scope === "GENERAL" && r.flags.includes("BELOW_REORDER")).length,
    shortage: count("SHORTAGE") + count("LOW_STOCK"),
    toOrderLines: rows.filter((r) => cmpQty(r.toOrder, "0") > 0).length,
    awaiting: count("AWAITING_DELIVERY") + count("PARTIALLY_RECEIVED"),
    delayed: count("DELAYED"),
    alreadyOrdered: count("ALREADY_ORDERED"),
    fulfilled: count("FULLY_RECEIVED"),
    estimatedCost: addMoney(...rows.map((r) => r.estimatedCost ?? "0")),
    unpricedLines: rows.filter((r) => cmpQty(r.toOrder, "0") > 0 && !r.lastPurchaseRate).length,
  };
}

export function planningCapabilities(actor: Actor) {
  return { canManage: can(actor, "mrp.manage"), canReserve: can(actor, "stock.reserve"), canRaisePr: can(actor, "pr.create"), canRfq: can(actor, "rfq.manage"), canPo: can(actor, "po.create"), canTransfer: can(actor, "stock.transfer"), canPlanStock: can(actor, "items.manage") };
}

// ─────────────────────────── Already ordered (allocations) ───────────────────────────

export type PlanOrderRow = {
  key: string;
  docType: "PR" | "RFQ" | "PO";
  docId: string;
  number: string;
  status: string;
  href: string;
  date: string;
  supplier: string | null;
  project: { id: string; code: string } | null;
  item: { name: string; code: string; unit: string };
  brand: string | null;
  quantity: string;
  /** Ordered (requisition) / accepted (PO); null for enquiries. */
  progress: string | null;
};

/** Requisition, enquiry and PO lines allocated to planning requirements (project and general stock). */
export async function listPlanningOrders(actor: Actor, raw: unknown) {
  requirePermission(actor, "mrp.view");
  const q = mrpQuerySchema.parse(raw ?? {});
  if (q.projectId) await assertProjectVisible(actor, q.projectId);
  const scopeWhere: Prisma.MaterialRequirementWhereInput = q.projectId
    ? { projectId: q.projectId }
    : q.scope === "project"
      ? { project: { is: projectAccessWhere(actor) } }
      : q.scope === "general"
        ? { projectId: null }
        : { OR: [{ projectId: null }, { project: { is: projectAccessWhere(actor) } }] };
  const req = { is: { organizationId: actor.organizationId, ...scopeWhere } };
  const ins = "insensitive" as const;
  const itemQ = q.q ? { OR: [{ name: { contains: q.q, mode: ins } }, { code: { contains: q.q, mode: ins } }] } : undefined;
  const ibSel = { select: { item: { select: { name: true, code: true, unit: true } }, brand: { select: { name: true } } } } as const;
  const reqSel = { select: { project: { select: { id: true, code: true } } } } as const;
  const [prLines, rfqLines, poLines] = await Promise.all([
    db.prLine.findMany({ where: { requirement: req, pr: { status: { notIn: ["CANCELLED", "REJECTED"] } }, ...(itemQ ? { itemBrand: { item: itemQ } } : {}) }, include: { pr: { select: { id: true, number: true, status: true, createdAt: true } }, requirement: reqSel, itemBrand: ibSel }, orderBy: { pr: { createdAt: "desc" } }, take: 300 }),
    db.rfqLine.findMany({ where: { requirement: req, prLineId: null, rfq: { status: { not: "CANCELLED" } }, ...(itemQ ? { item: itemQ } : {}) }, include: { rfq: { select: { id: true, number: true, status: true, createdAt: true } }, requirement: reqSel, item: { select: { name: true, code: true, unit: true } }, itemBrand: { select: { brand: { select: { name: true } } } } }, orderBy: { rfq: { createdAt: "desc" } }, take: 300 }),
    db.poLine.findMany({ where: { requirement: req, po: { status: { not: "CANCELLED" } }, ...(itemQ ? { itemBrand: { item: itemQ } } : {}) }, include: { po: { select: { id: true, number: true, status: true, orderDate: true, party: { select: { name: true } } } }, requirement: reqSel, itemBrand: ibSel }, orderBy: { po: { createdAt: "desc" } }, take: 300 }),
  ]);
  const rows: PlanOrderRow[] = [
    ...poLines.map((l) => ({ key: `po:${l.id}`, docType: "PO" as const, docId: l.po.id, number: l.po.number, status: l.po.status, href: `/purchase-orders/${l.po.id}`, date: l.po.orderDate.toISOString(), supplier: l.po.party.name, project: l.requirement?.project ?? null, item: l.itemBrand.item, brand: l.itemBrand.brand.name, quantity: dec3(l.quantity), progress: dec3(l.acceptedQty) })),
    ...rfqLines.map((l) => ({ key: `rfq:${l.id}`, docType: "RFQ" as const, docId: l.rfq.id, number: l.rfq.number, status: l.rfq.status, href: `/rate-enquiries/${l.rfq.id}`, date: l.rfq.createdAt.toISOString(), supplier: null, project: l.requirement?.project ?? null, item: l.item, brand: l.itemBrand?.brand.name ?? null, quantity: dec3(l.quantity), progress: null })),
    ...prLines.map((l) => ({ key: `pr:${l.id}`, docType: "PR" as const, docId: l.pr.id, number: l.pr.number, status: l.pr.status, href: `/purchase-requisitions/${l.pr.id}`, date: l.pr.createdAt.toISOString(), supplier: null, project: l.requirement?.project ?? null, item: l.itemBrand.item, brand: l.itemBrand.brand.name, quantity: dec3(l.quantity), progress: dec3(l.orderedQty) })),
  ];
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return { rows, query: q };
}

// ─────────────────────────── Item planning attributes ───────────────────────────

const optQtyField = z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.null(), z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Enter a quantity.")]));

const planningAttrSchema = z.object({
  /** Minimum stock (reorder level). */
  reorderLevel: optQtyField,
  /** "Order up to" level for general inventory; omitted = unchanged. */
  targetStock: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === undefined ? undefined : v === null || String(v).trim() === "" ? null : String(v).trim())).pipe(z.union([z.undefined(), z.null(), z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Enter a quantity.")])),
  /** Omitted = unchanged. */
  preferredSupplierId: z.union([uuid, z.literal(""), z.null()]).optional().transform((v) => (v === undefined ? undefined : v ? v : null)),
});

/** Minimum stock (reorder level), target stock and preferred supplier for an item–brand. */
export async function setPlanningAttributes(actor: Actor, itemBrandId: string, input: unknown) {
  requirePermission(actor, "items.manage");
  const data = parseInput(planningAttrSchema, input);
  const ib = await db.itemBrand.findFirst({ where: { id: itemBrandId, organizationId: actor.organizationId }, include: { item: { select: { code: true } }, brand: { select: { name: true } } } });
  if (!ib) throw new NotFoundError("Item–brand");
  const target = data.targetStock === undefined ? (ib.targetStock ? dec3(ib.targetStock) : null) : data.targetStock;
  if (target !== null && data.reorderLevel !== null && cmpQty(target, data.reorderLevel) < 0) throw new ValidationError("Target stock cannot be below the minimum stock.", { targetStock: "Below the minimum." });
  if (data.preferredSupplierId) {
    const s = await db.party.findFirst({ where: { id: data.preferredSupplierId, organizationId: actor.organizationId, isSupplier: true } });
    if (!s) throw new ValidationError("Choose a supplier.", { preferredSupplierId: "Not a supplier." });
  }
  await db.$transaction(async (tx) => {
    await tx.itemBrand.update({ where: { id: itemBrandId }, data });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "item.planning_updated", entityType: "item", entityId: ib.itemId, summary: `Planning for ${ib.item.code} / ${ib.brand.name}: minimum stock ${data.reorderLevel ?? "none"}, target ${target ?? "none"}` }, tx);
  });
}
