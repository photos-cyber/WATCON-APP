import "server-only";
import { writeAudit } from "@/lib/audit";
import { nextCode } from "@/lib/codes";
import type { Prisma, Tx } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { fromMilli, movementDateError, RESERVATION_EXEMPT_TYPES, toMilli, type StockDirection, type StockTxnType } from "./rules";

/**
 * Stock posting engine — the ONLY code that changes stock balances.
 *
 * Every movement, whatever document produced it, runs through `postMovementTx` inside the
 * caller's transaction:
 *   1. location balance: conditional UPDATE (OUT only when on_hand − reserved-for-others ≥ q),
 *      so concurrent postings serialise on the row lock and stock never goes negative;
 *   2. company total (item_brands.current_qty) kept equal to the sum of location balances;
 *   3. append-only ledger row with the resulting location balance.
 * The ledger's unique (organization_id, idempotency_key) makes document postings idempotent:
 * documents use deterministic keys such as `grn:<id>:<lineId>`.
 */

export type EngineMovement = {
  organizationId: string;
  actorId: string;
  itemBrandId: string;
  locationId: string;
  projectId?: string | null;
  type: StockTxnType;
  direction: StockDirection;
  quantity: string;
  txnDate: Date;
  today: Date;
  reference?: string | null;
  remarks?: string | null;
  reason?: string | null;
  unitCost?: string | null;
  idempotencyKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
  reversalOfId?: string | null;
};

const qty = (d: Prisma.Decimal | string | null | undefined) => (d === null || d === undefined ? "0" : fromMilli(toMilli(typeof d === "string" ? d : d.toFixed())));

export const SYSTEM_LOCATIONS = {
  WAREHOUSE: { code: "WH-MAIN", name: "Central Warehouse", type: "WAREHOUSE" },
  TRANSIT: { code: "TRANSIT", name: "Goods in transit", type: "TRANSIT" },
  QUARANTINE: { code: "QC-HOLD", name: "Damaged / quarantine", type: "QUARANTINE" },
} as const;

/** Creates the organisation's system locations if missing (new organisations). Returns their ids. */
export async function ensureSystemLocations(tx: Tx, organizationId: string): Promise<Record<keyof typeof SYSTEM_LOCATIONS, string>> {
  const out = {} as Record<keyof typeof SYSTEM_LOCATIONS, string>;
  for (const [key, def] of Object.entries(SYSTEM_LOCATIONS) as [keyof typeof SYSTEM_LOCATIONS, (typeof SYSTEM_LOCATIONS)[keyof typeof SYSTEM_LOCATIONS]][]) {
    const row = await tx.stockLocation.upsert({
      where: { organizationId_code: { organizationId, code: def.code } },
      create: { organizationId, code: def.code, name: def.name, type: def.type, isSystem: true },
      update: {},
      select: { id: true },
    });
    out[key] = row.id;
  }
  return out;
}

/** The project's site store, created on first use (one per project). */
export async function ensureSiteLocation(tx: Tx, organizationId: string, projectId: string): Promise<string> {
  const existing = await tx.stockLocation.findUnique({ where: { projectId }, select: { id: true, organizationId: true } });
  if (existing) {
    if (existing.organizationId !== organizationId) throw new NotFoundError("Project");
    return existing.id;
  }
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId }, select: { code: true, name: true, siteAddress: true } });
  if (!project) throw new NotFoundError("Project");
  const row = await tx.stockLocation.upsert({
    where: { projectId },
    create: { organizationId, projectId, code: `SITE-${project.code}`, name: `${project.name} (site)`, type: "SITE", address: project.siteAddress },
    update: {},
    select: { id: true },
  });
  return row.id;
}

/** Quantity at a location reserved for projects other than `projectId` (all projects when null). */
async function reservedForOthers(tx: Tx, itemBrandId: string, locationId: string, projectId: string | null | undefined): Promise<bigint> {
  const rows = await tx.$queryRaw<{ q: string | null }[]>`
    SELECT COALESCE(SUM(quantity - issued_qty), 0)::text AS q FROM stock_reservations
    WHERE item_brand_id = ${itemBrandId}::uuid AND location_id = ${locationId}::uuid AND status = 'ACTIVE'
      AND (${projectId ?? null}::uuid IS NULL OR project_id <> ${projectId ?? null}::uuid)`;
  return toMilli(rows[0]?.q ?? "0");
}

/** Consumes the project's own active reservations at the location (FIFO) when stock is issued for it. */
async function fulfilReservations(tx: Tx, itemBrandId: string, locationId: string, projectId: string, quantity: string) {
  let remaining = toMilli(quantity);
  const open = await tx.$queryRaw<{ id: string; open: string }[]>`
    SELECT id::text, (quantity - issued_qty)::text AS open FROM stock_reservations
    WHERE item_brand_id = ${itemBrandId}::uuid AND location_id = ${locationId}::uuid AND project_id = ${projectId}::uuid AND status = 'ACTIVE'
    ORDER BY created_at FOR UPDATE`;
  for (const r of open) {
    if (remaining <= BigInt(0)) break;
    const avail = toMilli(r.open);
    const take = avail < remaining ? avail : remaining;
    remaining -= take;
    await tx.$executeRaw`
      UPDATE stock_reservations SET issued_qty = issued_qty + ${fromMilli(take)}::numeric,
        status = CASE WHEN issued_qty + ${fromMilli(take)}::numeric >= quantity THEN 'FULFILLED'::"ReservationStatus" ELSE status END
      WHERE id = ${r.id}::uuid`;
  }
}

export async function postMovementTx(tx: Tx, m: EngineMovement) {
  if (toMilli(m.quantity) <= BigInt(0)) throw new ValidationError("Quantity must be greater than zero.");
  const position = await tx.itemBrand.findFirst({ where: { id: m.itemBrandId, organizationId: m.organizationId }, select: { itemId: true, brandId: true } });
  if (!position) throw new NotFoundError("Stock item");
  const location = await tx.stockLocation.findFirst({ where: { id: m.locationId, organizationId: m.organizationId }, select: { id: true, name: true, status: true } });
  if (!location) throw new NotFoundError("Stock location");

  // Ensure the balance row exists, then lock it for the rest of the transaction.
  await tx.$executeRaw`
    INSERT INTO stock_balances (id, organization_id, item_brand_id, location_id, item_id, brand_id, on_hand, updated_at)
    VALUES (gen_random_uuid(), ${m.organizationId}::uuid, ${m.itemBrandId}::uuid, ${m.locationId}::uuid, ${position.itemId}::uuid, ${position.brandId}::uuid, 0, now())
    ON CONFLICT (item_brand_id, location_id) DO NOTHING`;
  const [locked] = await tx.$queryRaw<{ on_hand: string }[]>`
    SELECT on_hand::text FROM stock_balances WHERE item_brand_id = ${m.itemBrandId}::uuid AND location_id = ${m.locationId}::uuid FOR UPDATE`;
  const onHand = toMilli(locked?.on_hand ?? "0");
  const q = toMilli(m.quantity);

  if (m.direction === "OUT") {
    if (onHand < q) {
      // Say where the item actually is, so the user can pick the right "from" location.
      const elsewhere = await tx.$queryRaw<{ name: string; on_hand: string }[]>`
        SELECT l.name, b.on_hand::text FROM stock_balances b JOIN stock_locations l ON l.id = b.location_id
        WHERE b.item_brand_id = ${m.itemBrandId}::uuid AND b.location_id <> ${m.locationId}::uuid AND b.on_hand > 0 AND l.is_system = false
        ORDER BY b.on_hand DESC LIMIT 3`;
      const item = await tx.itemBrand.findUnique({ where: { id: m.itemBrandId }, select: { item: { select: { name: true } }, brand: { select: { name: true } } } });
      const what = item ? `${item.item.name} – ${item.brand.name}` : "this item";
      const hint = elsewhere.length ? ` It is in stock at ${elsewhere.map((e) => `${e.name} (${fromMilli(toMilli(e.on_hand))})`).join(", ")} — change the "from" location.` : " It is not in stock at any location yet.";
      throw new ValidationError(`Insufficient stock of ${what} at ${location.name}: need ${fromMilli(q)}, available ${fromMilli(onHand)}.${hint}`, { quantity: `Only ${fromMilli(onHand)} in stock at ${location.name}.` });
    }
    if (!RESERVATION_EXEMPT_TYPES.includes(m.type)) {
      const reserved = await reservedForOthers(tx, m.itemBrandId, m.locationId, m.projectId);
      if (onHand - reserved < q) {
        const free = onHand - reserved;
        throw new ValidationError(`Only ${fromMilli(free < BigInt(0) ? BigInt(0) : free)} is free at ${location.name}; ${fromMilli(reserved)} is reserved for other projects. Release the reservation first.`, { quantity: "Stock is reserved for another project." });
      }
    }
  } else if (location.status !== "ACTIVE") {
    throw new ValidationError(`${location.name} is inactive; stock cannot be received there.`);
  }

  const latest = await tx.stockTransaction.findFirst({ where: { itemBrandId: m.itemBrandId, locationId: m.locationId }, orderBy: [{ txnDate: "desc" }], select: { txnDate: true } });
  const dateError = movementDateError(m.txnDate, m.today, latest?.txnDate ?? null);
  if (dateError) throw new ValidationError(dateError, { txnDate: dateError });

  const next = m.direction === "IN" ? onHand + q : onHand - q;
  await tx.$executeRaw`UPDATE stock_balances SET on_hand = ${fromMilli(next)}::numeric, updated_at = now() WHERE item_brand_id = ${m.itemBrandId}::uuid AND location_id = ${m.locationId}::uuid`;
  const delta = m.direction === "IN" ? { increment: m.quantity } : { decrement: m.quantity };
  await tx.itemBrand.update({ where: { id: m.itemBrandId }, data: { currentQty: delta } });

  if (m.direction === "OUT" && m.projectId && !RESERVATION_EXEMPT_TYPES.includes(m.type)) {
    await fulfilReservations(tx, m.itemBrandId, m.locationId, m.projectId, m.quantity);
  }

  const code = await nextCode(tx, m.organizationId, "STOCK_TXN");
  const txn = await tx.stockTransaction.create({
    data: {
      organizationId: m.organizationId,
      code,
      itemBrandId: m.itemBrandId,
      itemId: position.itemId,
      brandId: position.brandId,
      locationId: m.locationId,
      projectId: m.projectId ?? null,
      type: m.type,
      direction: m.direction,
      quantity: m.quantity,
      balanceAfter: fromMilli(next),
      unitCost: m.unitCost ?? null,
      txnDate: m.txnDate,
      reference: m.reference ?? null,
      remarks: m.remarks ?? null,
      reason: m.reason ?? null,
      idempotencyKey: m.idempotencyKey,
      sourceType: m.sourceType ?? null,
      sourceId: m.sourceId ?? null,
      reversalOfId: m.reversalOfId ?? null,
      createdById: m.actorId,
    },
    select: { id: true, code: true, itemBrandId: true, locationId: true, type: true, direction: true, quantity: true, balanceAfter: true, txnDate: true },
  });
  if (m.type === "ADJUSTMENT" || m.type === "OPENING" || m.type === "WRITE_OFF" || m.type === "REVERSAL") {
    await writeAudit(
      {
        organizationId: m.organizationId,
        actorId: m.actorId,
        // Phase 2 action names are kept ("stock.opening", "stock.adjusted").
        action: m.type === "OPENING" ? "stock.opening" : m.type === "ADJUSTMENT" ? "stock.adjusted" : m.type === "WRITE_OFF" ? "stock.written_off" : "stock.reversed",
        entityType: "stock",
        entityId: txn.id,
        projectId: m.projectId ?? null,
        summary: `${m.type === "OPENING" ? "Opening stock" : m.type === "ADJUSTMENT" ? `Adjustment ${m.direction === "IN" ? "+" : "−"}` : m.type === "WRITE_OFF" ? "Write-off −" : "Reversal "}${m.quantity} at ${location.name} (${code})${m.reason ? ` – ${m.reason}` : ""}`,
      },
      tx,
    );
  }
  return { ...txn, quantity: qty(txn.quantity), balanceAfter: qty(txn.balanceAfter) };
}

/**
 * Reverses a posted movement with an opposite entry at the same location (never edits it).
 * A movement can be reversed once (unique reversal_of_id).
 */
export async function reverseMovementTx(tx: Tx, organizationId: string, actorId: string, txnId: string, reason: string, today: Date, extra: { idempotencyKey?: string } = {}) {
  const original = await tx.stockTransaction.findFirst({ where: { id: txnId, organizationId } });
  if (!original) throw new NotFoundError("Stock entry");
  if (original.type === "REVERSAL") throw new ValidationError("A reversal entry cannot itself be reversed. Post a new movement instead.");
  const already = await tx.stockTransaction.findUnique({ where: { reversalOfId: original.id }, select: { code: true } });
  if (already) throw new ValidationError(`This entry was already reversed by ${already.code}.`);
  return postMovementTx(tx, {
    organizationId,
    actorId,
    itemBrandId: original.itemBrandId,
    locationId: original.locationId,
    projectId: original.projectId,
    type: "REVERSAL",
    direction: original.direction === "IN" ? "OUT" : "IN",
    quantity: qty(original.quantity),
    txnDate: today,
    today,
    reference: original.code,
    reason,
    unitCost: original.unitCost?.toFixed() ?? null,
    idempotencyKey: extra.idempotencyKey ?? `reversal:${original.id}`,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    reversalOfId: original.id,
  });
}
