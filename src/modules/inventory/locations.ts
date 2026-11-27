import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { nextCode } from "@/lib/codes";
import { db, type Prisma } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { can, type Actor } from "@/lib/permissions/definitions";
import { optionalText, text, uuid, dateString, toDbDate } from "@/lib/validations/common";
import { assertProjectUsable, assertProjectVisible, dec3, parseInput, projectRequiredScoped, requirePermission } from "@/modules/commercial/core";
import { startOfToday } from "@/modules/tasks/rules";
import { ensureSiteLocation, ensureSystemLocations, postMovementTx, reverseMovementTx } from "./engine";
import { fromMilli, toMilli } from "./rules";
import { quantity } from "./validation";

/** Locations, location-wise balances, reservations, site consumption and reversals. */

export type LocationOption = { id: string; code: string; name: string; type: string; projectId: string | null; status: string };

export async function listLocationOptions(actor: Actor): Promise<LocationOption[]> {
  await db.$transaction((tx) => ensureSystemLocations(tx, actor.organizationId));
  return db.stockLocation.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ type: "asc" }, { name: "asc" }], select: { id: true, code: true, name: true, type: true, projectId: true, status: true } });
}

export async function listLocations(actor: Actor) {
  requirePermission(actor, "items.view");
  await db.$transaction((tx) => ensureSystemLocations(tx, actor.organizationId));
  const rows = await db.stockLocation.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: { project: { select: { id: true, code: true, name: true } }, _count: { select: { balances: { where: { onHand: { gt: 0 } } } } } },
  });
  return rows.map(({ _count, ...r }) => ({ ...r, positions: _count.balances }));
}

const locationSchema = z.object({
  name: text("Name", 120, 2),
  type: z.enum(["WAREHOUSE", "SITE"]),
  projectId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  address: optionalText("Address", 500),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

export async function createLocation(actor: Actor, input: unknown) {
  requirePermission(actor, "locations.manage");
  const data = parseInput(locationSchema, input);
  if (data.type === "SITE") {
    if (!data.projectId) throw new ValidationError("A site store must belong to a project.", { projectId: "Choose the project." });
    await assertProjectVisible(actor, data.projectId);
    if (await db.stockLocation.count({ where: { projectId: data.projectId } })) throw new ConflictError("This project already has a site store.", { projectId: "Already has a site store." });
  }
  try {
    return await db.$transaction(async (tx) => {
      const code = await nextCode(tx, actor.organizationId, "LOCATION");
      const loc = await tx.stockLocation.create({ data: { organizationId: actor.organizationId, code, name: data.name, type: data.type, projectId: data.type === "SITE" ? data.projectId : null, address: data.address, status: data.status } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "location.created", entityType: "location", entityId: loc.id, projectId: loc.projectId, summary: `Created ${data.type.toLowerCase()} location ${code} – ${loc.name}` }, tx);
      return loc;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("A location with this code or project already exists.");
    throw e;
  }
}

export async function updateLocation(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "locations.manage");
  const data = parseInput(locationSchema.pick({ name: true, address: true, status: true }), input);
  const loc = await db.stockLocation.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!loc) throw new NotFoundError("Location");
  if (loc.isSystem && data.status === "INACTIVE") throw new ValidationError("System locations cannot be deactivated.");
  if (data.status === "INACTIVE" && (await db.stockBalance.count({ where: { locationId: id, onHand: { gt: 0 } } }))) throw new ValidationError("Move or issue the remaining stock before deactivating this location.");
  return db.$transaction(async (tx) => {
    const row = await tx.stockLocation.update({ where: { id }, data });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "location.updated", entityType: "location", entityId: id, projectId: loc.projectId, summary: `Updated location ${loc.code} – ${row.name}` }, tx);
    return row;
  });
}

// ─────────────────────────── Balances ───────────────────────────

const balanceQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  locationId: uuid.optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  brandId: uuid.optional().catch(undefined),
  nonZero: z.enum(["1", "0"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).catch(50).default(50),
});

/** Item–brand–location balances with reserved / available quantities (server-computed). */
export async function listLocationBalances(actor: Actor, raw: unknown) {
  requirePermission(actor, "items.view");
  const q = balanceQuerySchema.parse(raw ?? {});
  const and: Prisma.StockBalanceWhereInput[] = [{ organizationId: actor.organizationId }];
  if (q.locationId) and.push({ locationId: q.locationId });
  if (q.projectId) and.push({ location: { projectId: q.projectId } });
  if (q.brandId) and.push({ itemBrand: { brandId: q.brandId } });
  if (q.nonZero !== "0") and.push({ onHand: { gt: 0 } });
  if (q.q) and.push({ OR: [{ itemBrand: { item: { name: { contains: q.q, mode: "insensitive" } } } }, { itemBrand: { item: { code: { contains: q.q, mode: "insensitive" } } } }, { itemBrand: { brand: { name: { contains: q.q, mode: "insensitive" } } } }] });
  const where: Prisma.StockBalanceWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    db.stockBalance.count({ where }),
    db.stockBalance.findMany({
      where,
      orderBy: [{ location: { name: "asc" } }, { itemBrand: { item: { name: "asc" } } }, { id: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, onHand: true, itemBrandId: true, locationId: true, location: { select: { id: true, name: true, type: true } }, itemBrand: { select: { item: { select: { id: true, code: true, name: true, unit: true } }, brand: { select: { id: true, name: true } } } } },
    }),
  ]);
  const reserved = await reservedMap(rows.map((r) => ({ itemBrandId: r.itemBrandId, locationId: r.locationId })));
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    query: q,
    rows: rows.map((r) => {
      const res = reserved.get(`${r.itemBrandId}:${r.locationId}`) ?? BigInt(0);
      const onHand = toMilli(dec3(r.onHand));
      return { id: r.id, itemBrandId: r.itemBrandId, location: r.location, item: r.itemBrand.item, brand: r.itemBrand.brand, onHand: fromMilli(onHand), reserved: fromMilli(res), available: fromMilli(onHand - res) };
    }),
  };
}

async function reservedMap(keys: { itemBrandId: string; locationId: string }[]) {
  const map = new Map<string, bigint>();
  if (!keys.length) return map;
  const rows = await db.stockReservation.groupBy({ by: ["itemBrandId", "locationId"], where: { status: "ACTIVE", itemBrandId: { in: [...new Set(keys.map((k) => k.itemBrandId))] } }, _sum: { quantity: true, issuedQty: true } });
  for (const r of rows) map.set(`${r.itemBrandId}:${r.locationId}`, toMilli(dec3(r._sum.quantity)) - toMilli(dec3(r._sum.issuedQty)));
  return map;
}

// ─────────────────────────── Reservations ───────────────────────────

const reserveSchema = z.object({ projectId: uuid, itemBrandId: uuid, locationId: uuid, quantity, notes: optionalText("Notes", 300) });

/**
 * Reserve stock for a project. Available-to-promise is checked under a row lock on the
 * balance, so two simultaneous reservations can never promise the same units twice.
 */
export async function reserveStock(actor: Actor, input: unknown) {
  requirePermission(actor, "stock.reserve");
  const data = parseInput(reserveSchema, input);
  const project = await assertProjectUsable(actor, data.projectId);
  return db.$transaction(async (tx) => {
    const loc = await tx.stockLocation.findFirst({ where: { id: data.locationId, organizationId: actor.organizationId }, select: { id: true, name: true, type: true } });
    if (!loc) throw new NotFoundError("Location");
    if (loc.type === "TRANSIT" || loc.type === "QUARANTINE") throw new ValidationError("Stock in transit or quarantine cannot be reserved.");
    const [bal] = await tx.$queryRaw<{ on_hand: string }[]>`SELECT on_hand::text FROM stock_balances WHERE item_brand_id = ${data.itemBrandId}::uuid AND location_id = ${data.locationId}::uuid FOR UPDATE`;
    const [res] = await tx.$queryRaw<{ q: string }[]>`SELECT COALESCE(SUM(quantity - issued_qty),0)::text AS q FROM stock_reservations WHERE item_brand_id = ${data.itemBrandId}::uuid AND location_id = ${data.locationId}::uuid AND status = 'ACTIVE'`;
    const atp = toMilli(bal?.on_hand ?? "0") - toMilli(res?.q ?? "0");
    if (atp < toMilli(data.quantity)) throw new ValidationError(`Only ${fromMilli(atp < BigInt(0) ? BigInt(0) : atp)} is available to reserve at ${loc.name}.`, { quantity: "More than the available-to-promise quantity." });
    const row = await tx.stockReservation.create({ data: { organizationId: actor.organizationId, projectId: data.projectId, itemBrandId: data.itemBrandId, locationId: data.locationId, quantity: data.quantity, notes: data.notes, createdById: actor.id }, include: { itemBrand: { select: { item: { select: { name: true } }, brand: { select: { name: true } } } } } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "stock.reserved", entityType: "reservation", entityId: row.id, projectId: data.projectId, summary: `Reserved ${data.quantity} ${row.itemBrand.item.name} (${row.itemBrand.brand.name}) at ${loc.name} for ${project.code}` }, tx);
    return row;
  });
}

export async function releaseReservation(actor: Actor, id: string) {
  requirePermission(actor, "stock.reserve");
  const r = await db.stockReservation.findFirst({ where: { id, organizationId: actor.organizationId }, include: { project: { select: { code: true } } } });
  if (!r) throw new NotFoundError("Reservation");
  await assertProjectVisible(actor, r.projectId);
  const res = await db.$transaction(async (tx) => {
    const u = await tx.stockReservation.updateMany({ where: { id, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date() } });
    if (u.count !== 1) throw new ConflictError("This reservation is no longer active.");
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "stock.reservation_released", entityType: "reservation", entityId: id, projectId: r.projectId, summary: `Released reservation of ${fromMilli(toMilli(dec3(r.quantity)) - toMilli(dec3(r.issuedQty)))} for ${r.project.code}` }, tx);
    return u;
  });
  return res;
}

export async function listReservations(actor: Actor, opts: { projectId?: string; status?: "ACTIVE" | "RELEASED" | "FULFILLED" } = {}) {
  requirePermission(actor, "items.view");
  const rows = await db.stockReservation.findMany({
    where: { AND: [projectRequiredScoped(actor) as Prisma.StockReservationWhereInput, opts.projectId ? { projectId: opts.projectId } : {}, { status: opts.status ?? "ACTIVE" }] },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { project: { select: { id: true, code: true, name: true } }, location: { select: { name: true } }, createdBy: { select: { fullName: true } }, itemBrand: { select: { item: { select: { id: true, code: true, name: true, unit: true } }, brand: { select: { name: true } } } } },
  });
  return rows.map((r) => ({ id: r.id, project: r.project, location: r.location.name, item: r.itemBrand.item, brand: r.itemBrand.brand.name, quantity: dec3(r.quantity), issuedQty: dec3(r.issuedQty), open: fromMilli(toMilli(dec3(r.quantity)) - toMilli(dec3(r.issuedQty))), status: r.status, notes: r.notes, createdBy: r.createdBy.fullName, createdAt: r.createdAt.toISOString() }));
}

// ─────────────────────────── Consumption & reversal ───────────────────────────

const consumeSchema = z.object({ projectId: uuid, itemBrandId: uuid, quantity, txnDate: dateString, remarks: optionalText("Remarks", 500), idempotencyKey: z.string().uuid() });

/** Material consumed / installed at a project site (OUT of the project's site store). */
export async function recordConsumption(actor: Actor, input: unknown) {
  requirePermission(actor, "stock.consume");
  const data = parseInput(consumeSchema, input);
  const project = await assertProjectUsable(actor, data.projectId);
  const existing = await db.stockTransaction.findUnique({ where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey: data.idempotencyKey } }, select: { id: true, code: true } });
  if (existing) return { ...existing, duplicate: true };
  return db.$transaction(async (tx) => {
    const locationId = await ensureSiteLocation(tx, actor.organizationId, data.projectId);
    const txn = await postMovementTx(tx, { organizationId: actor.organizationId, actorId: actor.id, itemBrandId: data.itemBrandId, locationId, projectId: data.projectId, type: "CONSUMPTION", direction: "OUT", quantity: data.quantity, txnDate: toDbDate(data.txnDate)!, today: startOfToday(), reference: project.code, remarks: data.remarks, idempotencyKey: data.idempotencyKey, sourceType: "project", sourceId: data.projectId });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "stock.consumed", entityType: "stock", entityId: txn.id, projectId: data.projectId, summary: `Recorded consumption of ${data.quantity} at ${project.code} site (${txn.code})` }, tx);
    return { id: txn.id, code: txn.code, duplicate: false };
  });
}

const reverseSchema = z.object({ reason: z.string().trim().min(5, "Explain why this entry is reversed.").max(500) });

/** Correction workflow for manual entries: posts an opposite entry, never edits history. */
export async function reverseStockEntry(actor: Actor, txnId: string, input: unknown) {
  requirePermission(actor, "stock.adjust");
  const data = parseInput(reverseSchema, input);
  const t = await db.stockTransaction.findFirst({ where: { id: txnId, organizationId: actor.organizationId }, select: { sourceType: true, type: true } });
  if (!t) throw new NotFoundError("Stock entry");
  if (t.sourceType && t.sourceType !== "manual" && t.sourceType !== "project") throw new ValidationError("This entry was posted by a document. Reverse or cancel the source document instead.");
  return db.$transaction((tx) => reverseMovementTx(tx, actor.organizationId, actor.id, txnId, data.reason, startOfToday()));
}

export function locationCapabilities(actor: Actor) {
  return { canManageLocations: can(actor, "locations.manage"), canReserve: can(actor, "stock.reserve"), canConsume: can(actor, "stock.consume"), canReverse: can(actor, "stock.adjust") };
}

export type ItemBrandOption = { id: string; itemId: string; itemCode: string; itemName: string; brandName: string; unit: string; currentQty: string; hsnCode: string | null; gstRate: string | null; lastRate: string | null };

/** Picker data for commercial documents (active item–brands with tax defaults and last purchase rate). */
export async function itemBrandOptions(actor: Actor): Promise<ItemBrandOption[]> {
  const rows = await db.itemBrand.findMany({
    where: { organizationId: actor.organizationId, item: { status: "ACTIVE" }, brand: { status: "ACTIVE" } },
    orderBy: [{ item: { name: "asc" } }, { brand: { name: "asc" } }],
    take: 5000,
    select: { id: true, itemId: true, currentQty: true, lastPurchaseRate: true, item: { select: { code: true, name: true, unit: true, hsnCode: true, gstRate: true } }, brand: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, itemId: r.itemId, itemCode: r.item.code, itemName: r.item.name, brandName: r.brand.name, unit: r.item.unit, currentQty: dec3(r.currentQty), hsnCode: r.item.hsnCode, gstRate: r.item.gstRate ? String(Number(r.item.gstRate)) : null, lastRate: r.lastPurchaseRate ? String(Number(r.lastPurchaseRate)) : null }));
}

/** Evidence on a manual stock entry: visible with inventory access, added by the owner, never deleted. */
export async function stockTxnAccess(actor: Actor, id: string): Promise<import("@/modules/documents/access").EntityAccess | null> {
  if (!can(actor, "items.view")) return null;
  const t = await db.stockTransaction.findFirst({ where: { id, organizationId: actor.organizationId }, select: { code: true, projectId: true } });
  if (!t) return null;
  return { projectId: t.projectId, label: `stock entry ${t.code}`, canView: true, canUpload: can(actor, "stock.adjust"), locked: true };
}
