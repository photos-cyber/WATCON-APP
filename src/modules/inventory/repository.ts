import "server-only";
import { randomUUID } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { nextCode } from "@/lib/codes";
import { db, Prisma, type Tx } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { ensureSystemLocations, postMovementTx as postEngineMovement } from "./engine";
import { fromMilli, toMilli, type StockDirection, type StockSummary, type StockTxnType } from "./rules";

/**
 * Inventory data access. Services call only these functions (never `db` directly), so a
 * later move to another store (e.g. Firestore) replaces this file, not the business rules.
 * Quantities cross this boundary as decimal strings; dates as UTC-midnight Dates.
 */

type RecordStatus = "ACTIVE" | "INACTIVE";
const qty = (d: Prisma.Decimal | null | undefined) => (d ? fromMilli(toMilli(d.toFixed())) : "0");

// ─────────────────────────────── Items ───────────────────────────────

export type ItemFilter = { organizationId: string; q?: string; status?: RecordStatus; category?: string };

function itemWhere(f: ItemFilter): Prisma.ItemWhereInput {
  const and: Prisma.ItemWhereInput[] = [{ organizationId: f.organizationId }];
  if (f.status) and.push({ status: f.status });
  if (f.category) and.push({ category: { equals: f.category, mode: "insensitive" } });
  if (f.q) {
    and.push({
      OR: [
        { name: { contains: f.q, mode: "insensitive" } },
        { code: { contains: f.q, mode: "insensitive" } },
        { category: { contains: f.q, mode: "insensitive" } },
        { brands: { some: { brand: { name: { contains: f.q, mode: "insensitive" } } } } },
      ],
    });
  }
  return { AND: and };
}

export async function findItems(f: ItemFilter, opts: { sort: "name" | "code" | "category" | "createdAt"; dir: "asc" | "desc"; skip: number; take: number }) {
  const where = itemWhere(f);
  const [total, rows] = await Promise.all([
    db.item.count({ where }),
    db.item.findMany({
      where,
      orderBy: [{ [opts.sort]: opts.dir }, { id: "asc" }],
      skip: opts.skip,
      take: opts.take,
      select: { id: true, code: true, name: true, category: true, unit: true, description: true, status: true, _count: { select: { brands: true } } },
    }),
  ]);
  const sums = rows.length
    ? await db.itemBrand.groupBy({ by: ["itemId"], where: { itemId: { in: rows.map((r) => r.id) } }, _sum: { currentQty: true } })
    : [];
  const stock = new Map(sums.map((s) => [s.itemId, qty(s._sum.currentQty)]));
  return {
    total,
    rows: rows.map(({ _count, ...r }) => ({ ...r, brandCount: _count.brands, totalStock: stock.get(r.id) ?? "0" })),
  };
}

export async function findItemCategories(organizationId: string): Promise<string[]> {
  const rows = await db.item.findMany({ where: { organizationId, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } });
  return rows.map((r) => r.category!).filter(Boolean);
}

export async function findItem(organizationId: string, id: string) {
  return db.item.findFirst({
    where: { id, organizationId },
    select: { id: true, code: true, name: true, category: true, unit: true, description: true, status: true, createdAt: true, updatedAt: true, createdBy: { select: { fullName: true } }, images: { select: { id: true, path: true }, orderBy: { sortOrder: "asc" } } },
  });
}

export async function itemCodeTaken(organizationId: string, code: string, exceptId?: string) {
  return (await db.item.count({ where: { organizationId, code, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
}

export type ItemData = { code: string | null; name: string; category: string | null; unit: string; description: string | null; status: RecordStatus };

export async function insertItem(organizationId: string, actorId: string, data: ItemData) {
  return db.$transaction(async (tx) => {
    let code = data.code;
    // Generated codes skip any number a manually-entered code already uses.
    for (let i = 0; !code && i < 50; i++) {
      const candidate = await nextCode(tx, organizationId, "ITEM");
      if (!(await tx.item.count({ where: { organizationId, code: candidate } }))) code = candidate;
    }
    if (!code) throw new ConflictError("Could not allocate an item code. Enter one manually.");
    const item = await tx.item.create({ data: { ...data, code, organizationId, createdById: actorId } });
    await writeAudit({ organizationId, actorId, action: "item.created", entityType: "item", entityId: item.id, summary: `Created item ${code} – ${item.name}` }, tx);
    return item;
  });
}

export async function updateItemRow(organizationId: string, actorId: string, id: string, data: ItemData & { code: string }, action: string) {
  return db.$transaction(async (tx) => {
    const item = await tx.item.update({ where: { id }, data });
    await writeAudit({ organizationId, actorId, action, entityType: "item", entityId: id, summary: `Updated item ${item.code}` }, tx);
    return item;
  });
}

export async function setItemStatusRow(organizationId: string, actorId: string, id: string, status: RecordStatus) {
  return db.$transaction(async (tx) => {
    const item = await tx.item.update({ where: { id }, data: { status } });
    await writeAudit({ organizationId, actorId, action: status === "ACTIVE" ? "item.activated" : "item.deactivated", entityType: "item", entityId: id, summary: `${status === "ACTIVE" ? "Activated" : "Deactivated"} item ${item.code}` }, tx);
    return item;
  });
}

// ─────────────────────────────── Brands ───────────────────────────────

export type BrandFilter = { organizationId: string; q?: string; status?: RecordStatus };

export async function findBrands(f: BrandFilter, opts: { sort: "name" | "code" | "createdAt"; dir: "asc" | "desc"; skip: number; take: number }) {
  const and: Prisma.BrandWhereInput[] = [{ organizationId: f.organizationId }];
  if (f.status) and.push({ status: f.status });
  if (f.q) and.push({ OR: [{ name: { contains: f.q, mode: "insensitive" } }, { code: { contains: f.q, mode: "insensitive" } }] });
  const where: Prisma.BrandWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    db.brand.count({ where }),
    db.brand.findMany({
      where,
      orderBy: [{ [opts.sort]: opts.dir }, { id: "asc" }],
      skip: opts.skip,
      take: opts.take,
      select: { id: true, code: true, name: true, description: true, status: true, _count: { select: { items: true } } },
    }),
  ]);
  return { total, rows: rows.map(({ _count, ...r }) => ({ ...r, itemCount: _count.items })) };
}

export async function findBrand(organizationId: string, id: string) {
  return db.brand.findFirst({ where: { id, organizationId } });
}

export async function brandNameTaken(organizationId: string, name: string, exceptId?: string) {
  return (await db.brand.count({ where: { organizationId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) } })) > 0;
}

export async function findBrandOptions(organizationId: string) {
  return db.brand.findMany({ where: { organizationId }, orderBy: { name: "asc" }, select: { id: true, code: true, name: true, status: true } });
}

export type BrandData = { name: string; description: string | null; status: RecordStatus };

export async function insertBrand(organizationId: string, actorId: string, data: BrandData) {
  return db.$transaction(async (tx) => {
    const code = await nextCode(tx, organizationId, "BRAND");
    const brand = await tx.brand.create({ data: { ...data, code, organizationId, createdById: actorId } });
    await writeAudit({ organizationId, actorId, action: "brand.created", entityType: "brand", entityId: brand.id, summary: `Created brand ${code} – ${brand.name}` }, tx);
    return brand;
  });
}

export async function updateBrandRow(organizationId: string, actorId: string, id: string, data: BrandData, action: string) {
  return db.$transaction(async (tx) => {
    const brand = await tx.brand.update({ where: { id }, data });
    await writeAudit({ organizationId, actorId, action, entityType: "brand", entityId: id, summary: `Updated brand ${brand.code}` }, tx);
    return brand;
  });
}

// ───────────────────────── Item ↔ brand positions ─────────────────────────

export async function findItemBrands(organizationId: string, itemId: string) {
  const rows = await db.itemBrand.findMany({
    where: { organizationId, itemId },
    orderBy: { brand: { name: "asc" } },
    select: { id: true, currentQty: true, brand: { select: { id: true, code: true, name: true, status: true } }, _count: { select: { transactions: true } } },
  });
  return rows.map((r) => ({ id: r.id, brand: r.brand, currentQty: qty(r.currentQty), transactionCount: r._count.transactions }));
}

export async function findItemBrand(organizationId: string, id: string) {
  const row = await db.itemBrand.findFirst({
    where: { id, organizationId },
    select: { id: true, itemId: true, brandId: true, currentQty: true, item: { select: { code: true, name: true, status: true, unit: true } }, brand: { select: { name: true, status: true } }, _count: { select: { transactions: true } } },
  });
  return row && { ...row, currentQty: qty(row.currentQty), transactionCount: row._count.transactions };
}

/** Active positions for movement pickers. */
export async function findStockPositionOptions(organizationId: string) {
  const rows = await db.itemBrand.findMany({
    where: { organizationId, item: { status: "ACTIVE" }, brand: { status: "ACTIVE" } },
    orderBy: [{ item: { name: "asc" } }, { brand: { name: "asc" } }],
    take: 5000,
    select: { id: true, currentQty: true, item: { select: { code: true, name: true, unit: true } }, brand: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, itemCode: r.item.code, itemName: r.item.name, brandName: r.brand.name, unit: r.item.unit, currentQty: qty(r.currentQty) }));
}

export type MovementData = {
  organizationId: string;
  actorId: string;
  itemBrandId: string;
  /** Defaults to the Central Warehouse (Phase 2 behaviour). */
  locationId?: string | null;
  projectId?: string | null;
  type: StockTxnType;
  direction: StockDirection;
  quantity: string;
  txnDate: Date;
  today: Date;
  reference: string | null;
  remarks: string | null;
  reason: string | null;
  idempotencyKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
};

const txnSelect = { id: true, code: true, itemBrandId: true, locationId: true, type: true, direction: true, quantity: true, balanceAfter: true, txnDate: true } as const;
type TxnRow = Prisma.StockTransactionGetPayload<{ select: typeof txnSelect }>;
const toTxn = (t: TxnRow) => ({ ...t, quantity: qty(t.quantity), balanceAfter: qty(t.balanceAfter) });

async function postMovementTx(tx: Tx, m: MovementData) {
  const locationId = m.locationId ?? (await ensureSystemLocations(tx, m.organizationId)).WAREHOUSE;
  return postEngineMovement(tx, { ...m, locationId });
}

async function findByIdempotencyKey(organizationId: string, key: string) {
  const t = await db.stockTransaction.findUnique({ where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } }, select: txnSelect });
  return t && toTxn(t);
}

/**
 * Idempotent: re-submitting the same key returns the original posting instead of
 * posting again (also when two identical requests race — the loser's whole
 * transaction, including its balance change, rolls back on the unique key).
 */
export async function postMovement(m: MovementData, afterPost?: (tx: Tx, txn: { id: string; code: string }) => Promise<unknown>): Promise<{ txn: ReturnType<typeof toTxn>; duplicate: boolean }> {
  const existing = await findByIdempotencyKey(m.organizationId, m.idempotencyKey);
  if (existing) return assertSamePosting(existing, m);
  try {
    const txn = await db.$transaction(async (tx) => {
      const t = await postMovementTx(tx, m);
      if (afterPost) await afterPost(tx, t);
      return t;
    });
    return { txn: { ...txn, locationId: txn.locationId }, duplicate: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const winner = await findByIdempotencyKey(m.organizationId, m.idempotencyKey);
      if (winner) return assertSamePosting(winner, m);
    }
    throw e;
  }
}

function assertSamePosting(t: ReturnType<typeof toTxn>, m: MovementData) {
  if (t.itemBrandId !== m.itemBrandId || t.type !== m.type || t.direction !== m.direction || toMilli(t.quantity) !== toMilli(m.quantity) || (m.locationId && t.locationId !== m.locationId)) {
    throw new ConflictError("This submission was already used for a different stock entry. Reload the form and try again.");
  }
  return { txn: t, duplicate: true };
}

/** Links a brand to an item and (optionally) posts its opening stock in the same transaction. */
export async function insertItemBrand(organizationId: string, actorId: string, input: { itemId: string; brandId: string; opening: { quantity: string; txnDate: Date; today: Date } | null }) {
  try {
    return await db.$transaction(async (tx) => {
      const link = await tx.itemBrand.create({ data: { organizationId, itemId: input.itemId, brandId: input.brandId }, include: { item: { select: { code: true } }, brand: { select: { name: true } } } });
      await writeAudit({ organizationId, actorId, action: "item.brand_linked", entityType: "item", entityId: input.itemId, summary: `Linked brand ${link.brand.name} to item ${link.item.code}` }, tx);
      if (input.opening) {
        await postMovementTx(tx, {
          organizationId,
          actorId,
          itemBrandId: link.id,
          type: "OPENING",
          direction: "IN",
          quantity: input.opening.quantity,
          txnDate: input.opening.txnDate,
          today: input.opening.today,
          reference: null,
          remarks: null,
          reason: "Opening stock",
          idempotencyKey: randomUUID(),
        });
      }
      return link;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("This brand is already linked to the item.", { brandId: "Already linked to this item." });
    throw e;
  }
}

/** Only unused links (no ledger entries) may be removed; history is never deleted. */
export async function deleteItemBrand(organizationId: string, actorId: string, id: string) {
  await db.$transaction(async (tx) => {
    const link = await tx.itemBrand.findFirst({ where: { id, organizationId }, include: { item: { select: { id: true, code: true } }, brand: { select: { name: true } }, _count: { select: { transactions: true } } } });
    if (!link) throw new NotFoundError("Brand link");
    if (link._count.transactions > 0) throw new ConflictError("This brand has stock history for the item and cannot be removed. Deactivate the brand instead.");
    await tx.itemBrand.delete({ where: { id } });
    await writeAudit({ organizationId, actorId, action: "item.brand_unlinked", entityType: "item", entityId: link.item.id, summary: `Removed brand ${link.brand.name} from item ${link.item.code}` }, tx);
  });
}

// ─────────────────────────── Stock summary & ledger ───────────────────────────

export type StockFilter = { organizationId: string; q?: string; itemId?: string; brandId?: string; category?: string };

function positionWhere(f: StockFilter): Prisma.ItemBrandWhereInput {
  const and: Prisma.ItemBrandWhereInput[] = [{ organizationId: f.organizationId }];
  if (f.itemId) and.push({ itemId: f.itemId });
  if (f.brandId) and.push({ brandId: f.brandId });
  if (f.category) and.push({ item: { category: { equals: f.category, mode: "insensitive" } } });
  if (f.q) {
    and.push({
      OR: [
        { item: { name: { contains: f.q, mode: "insensitive" } } },
        { item: { code: { contains: f.q, mode: "insensitive" } } },
        { brand: { name: { contains: f.q, mode: "insensitive" } } },
      ],
    });
  }
  return { AND: and };
}

/** Rule S4 in SQL, for a page of positions. */
async function summaries(ids: string[], from: Date | null, to: Date | null): Promise<Map<string, StockSummary>> {
  if (!ids.length) return new Map();
  const rows = await db.$queryRaw<{ id: string; opening: string; inward: string; outward: string }[]>`
    SELECT t.item_brand_id::text AS id,
      COALESCE(SUM(CASE WHEN t.type = 'OPENING' OR (${from}::date IS NOT NULL AND t.txn_date < ${from}::date)
        THEN CASE WHEN t.direction = 'IN' THEN t.quantity ELSE -t.quantity END END), 0)::text AS opening,
      COALESCE(SUM(CASE WHEN t.type <> 'OPENING' AND (${from}::date IS NULL OR t.txn_date >= ${from}::date) AND t.direction = 'IN' THEN t.quantity END), 0)::text AS inward,
      COALESCE(SUM(CASE WHEN t.type <> 'OPENING' AND (${from}::date IS NULL OR t.txn_date >= ${from}::date) AND t.direction = 'OUT' THEN t.quantity END), 0)::text AS outward
    FROM stock_transactions t
    WHERE t.item_brand_id = ANY(${ids}::uuid[]) AND (${to}::date IS NULL OR t.txn_date <= ${to}::date)
    GROUP BY t.item_brand_id`;
  return new Map(
    rows.map((r) => {
      const [o, i, out] = [toMilli(r.opening), toMilli(r.inward), toMilli(r.outward)];
      return [r.id, { opening: fromMilli(o), inward: fromMilli(i), outward: fromMilli(out), closing: fromMilli(o + i - out) }];
    }),
  );
}

const EMPTY: StockSummary = { opening: "0", inward: "0", outward: "0", closing: "0" };

export async function findStockPositions(f: StockFilter, period: { from: Date | null; to: Date | null }, opts: { skip: number; take: number }) {
  const where = positionWhere(f);
  const [total, rows] = await Promise.all([
    db.itemBrand.count({ where }),
    db.itemBrand.findMany({
      where,
      orderBy: [{ item: { name: "asc" } }, { brand: { name: "asc" } }, { id: "asc" }],
      skip: opts.skip,
      take: opts.take,
      select: { id: true, currentQty: true, item: { select: { id: true, code: true, name: true, unit: true, category: true, status: true } }, brand: { select: { id: true, name: true, status: true } } },
    }),
  ]);
  const sums = await summaries(rows.map((r) => r.id), period.from, period.to);
  return { total, rows: rows.map((r) => ({ id: r.id, item: r.item, brand: r.brand, currentQty: qty(r.currentQty), ...(sums.get(r.id) ?? EMPTY) })) };
}

export async function summarizePositions(ids: string[]) {
  return summaries(ids, null, null);
}

export type LedgerFilter = StockFilter & { type?: StockTxnType; from: Date | null; to: Date | null; locationId?: string; projectId?: string; sourceType?: string; sourceId?: string };

export async function findLedger(f: LedgerFilter, opts: { skip: number; take: number }) {
  const and: Prisma.StockTransactionWhereInput[] = [{ organizationId: f.organizationId }];
  if (f.itemId) and.push({ itemId: f.itemId });
  if (f.brandId) and.push({ brandId: f.brandId });
  if (f.type) and.push({ type: f.type });
  if (f.locationId) and.push({ locationId: f.locationId });
  if (f.projectId) and.push({ projectId: f.projectId });
  if (f.sourceType) and.push({ sourceType: f.sourceType });
  if (f.sourceId) and.push({ sourceId: f.sourceId });
  if (f.from) and.push({ txnDate: { gte: f.from } });
  if (f.to) and.push({ txnDate: { lte: f.to } });
  if (f.category) and.push({ item: { category: { equals: f.category, mode: "insensitive" } } });
  if (f.q) {
    and.push({
      OR: [
        { code: { contains: f.q, mode: "insensitive" } },
        { reference: { contains: f.q, mode: "insensitive" } },
        { item: { name: { contains: f.q, mode: "insensitive" } } },
        { item: { code: { contains: f.q, mode: "insensitive" } } },
        { brand: { name: { contains: f.q, mode: "insensitive" } } },
      ],
    });
  }
  const where: Prisma.StockTransactionWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    db.stockTransaction.count({ where }),
    db.stockTransaction.findMany({
      where,
      orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: opts.skip,
      take: opts.take,
      select: {
        id: true,
        code: true,
        type: true,
        direction: true,
        quantity: true,
        balanceAfter: true,
        txnDate: true,
        reference: true,
        remarks: true,
        reason: true,
        createdAt: true,
        sourceType: true,
        sourceId: true,
        item: { select: { id: true, code: true, name: true, unit: true } },
        brand: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        project: { select: { id: true, code: true } },
        reversedBy: { select: { id: true } },
        createdBy: { select: { fullName: true } },
      },
    }),
  ]);
  return { total, rows: rows.map((r) => ({ ...r, quantity: qty(r.quantity), balanceAfter: qty(r.balanceAfter) })) };
}

/** Recomputes a position's balance from its ledger (consistency checks / tests). */
export async function ledgerBalance(itemBrandId: string): Promise<{ ledger: string; current: string }> {
  const [sums, position] = await Promise.all([
    db.stockTransaction.groupBy({ by: ["direction"], where: { itemBrandId }, _sum: { quantity: true } }),
    db.itemBrand.findUniqueOrThrow({ where: { id: itemBrandId }, select: { currentQty: true } }),
  ]);
  const get = (d: StockDirection) => toMilli(qty(sums.find((s) => s.direction === d)?._sum.quantity));
  return { ledger: fromMilli(get("IN") - get("OUT")), current: qty(position.currentQty) };
}

