import "server-only";
import { storeEvidenceTx } from "@/modules/documents/attachments";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, isUniqueViolation, zodFieldErrors } from "@/lib/errors";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { toDbDate } from "@/lib/validations/common";
import { startOfToday } from "@/modules/tasks/rules";
import * as repo from "./repository";
import { directionFor } from "./rules";
import { brandInputSchema, brandListQuerySchema, itemInputSchema, itemListQuerySchema, ledgerQuerySchema, linkBrandSchema, movementSchema, stockQuerySchema } from "./validation";

function requirePermission(actor: Actor, permission: PermissionKey) {
  if (!can(actor, permission)) throw new ForbiddenError();
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError("Please correct the highlighted fields.", zodFieldErrors(r.error.issues));
  return r.data;
}

export function inventoryCapabilities(actor: Actor) {
  // Manual stock changes are owner-only (workflow v2); inward / outward are offered only to them.
  return { canView: can(actor, "items.view"), canManage: can(actor, "items.manage"), canPost: can(actor, "stock.adjust"), canAdjust: can(actor, "stock.adjust") };
}

// ─────────────────────────────── Items ───────────────────────────────

export async function listItems(actor: Actor, rawQuery: unknown) {
  requirePermission(actor, "items.view");
  const query = itemListQuerySchema.parse(rawQuery ?? {});
  const result = await repo.findItems({ organizationId: actor.organizationId, q: query.q, status: query.status, category: query.category }, { sort: query.sort, dir: query.dir, skip: (query.page - 1) * query.pageSize, take: query.pageSize });
  return { ...result, page: query.page, pageSize: query.pageSize, query };
}

export async function listItemCategories(actor: Actor) {
  requirePermission(actor, "items.view");
  return repo.findItemCategories(actor.organizationId);
}

export async function getItem(actor: Actor, id: string, rawLedgerQuery: unknown = {}) {
  requirePermission(actor, "items.view");
  const item = await repo.findItem(actor.organizationId, id);
  if (!item) throw new NotFoundError("Item");
  const lq = ledgerQuerySchema.parse(rawLedgerQuery ?? {});
  const [positions, ledger] = await Promise.all([
    repo.findItemBrands(actor.organizationId, id),
    repo.findLedger({ organizationId: actor.organizationId, itemId: id, brandId: lq.brandId, type: lq.type, from: toDbDate(lq.from), to: toDbDate(lq.to) }, { skip: (lq.page - 1) * lq.pageSize, take: lq.pageSize }),
  ]);
  const sums = await repo.summarizePositions(positions.map((p) => p.id));
  const empty = { opening: "0", inward: "0", outward: "0", closing: "0" };
  return {
    item,
    positions: positions.map((p) => ({ ...p, ...(sums.get(p.id) ?? empty) })),
    ledger: { ...ledger, page: lq.page, pageSize: lq.pageSize },
    capabilities: inventoryCapabilities(actor),
  };
}

export async function createItem(actor: Actor, input: unknown) {
  requirePermission(actor, "items.manage");
  const data = parse(itemInputSchema, input);
  if (data.code && (await repo.itemCodeTaken(actor.organizationId, data.code))) throw new ConflictError("An item with this code already exists.", { code: "This item code is already in use." });
  try {
    return await repo.insertItem(actor.organizationId, actor.id, data);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("An item with this code already exists.", { code: "This item code is already in use." });
    throw e;
  }
}

export async function updateItem(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "items.manage");
  const data = parse(itemInputSchema, input);
  const before = await repo.findItem(actor.organizationId, id);
  if (!before) throw new NotFoundError("Item");
  const code = data.code ?? before.code;
  if (code !== before.code && (await repo.itemCodeTaken(actor.organizationId, code, id))) throw new ConflictError("An item with this code already exists.", { code: "This item code is already in use." });
  const action = before.status !== data.status ? (data.status === "ACTIVE" ? "item.activated" : "item.deactivated") : "item.updated";
  try {
    return await repo.updateItemRow(actor.organizationId, actor.id, id, { ...data, code }, action);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("An item with this code already exists.", { code: "This item code is already in use." });
    throw e;
  }
}

export async function setItemStatus(actor: Actor, id: string, status: "ACTIVE" | "INACTIVE") {
  requirePermission(actor, "items.manage");
  const before = await repo.findItem(actor.organizationId, id);
  if (!before) throw new NotFoundError("Item");
  if (before.status === status) return before;
  return repo.setItemStatusRow(actor.organizationId, actor.id, id, status);
}

// ─────────────────────────────── Brands ───────────────────────────────

export async function listBrands(actor: Actor, rawQuery: unknown) {
  requirePermission(actor, "items.view");
  const query = brandListQuerySchema.parse(rawQuery ?? {});
  const result = await repo.findBrands({ organizationId: actor.organizationId, q: query.q, status: query.status }, { sort: query.sort, dir: query.dir, skip: (query.page - 1) * query.pageSize, take: query.pageSize });
  return { ...result, page: query.page, pageSize: query.pageSize, query };
}

export async function listBrandOptions(actor: Actor) {
  requirePermission(actor, "items.view");
  return repo.findBrandOptions(actor.organizationId);
}

const brandClash = () => new ConflictError("A brand with this name already exists.", { name: "A brand with this name already exists." });

export async function createBrand(actor: Actor, input: unknown) {
  requirePermission(actor, "items.manage");
  const data = parse(brandInputSchema, input);
  if (await repo.brandNameTaken(actor.organizationId, data.name)) throw brandClash();
  try {
    return await repo.insertBrand(actor.organizationId, actor.id, data);
  } catch (e) {
    if (isUniqueViolation(e)) throw brandClash();
    throw e;
  }
}

export async function updateBrand(actor: Actor, id: string, input: unknown) {
  requirePermission(actor, "items.manage");
  const data = parse(brandInputSchema, input);
  const before = await repo.findBrand(actor.organizationId, id);
  if (!before) throw new NotFoundError("Brand");
  if (await repo.brandNameTaken(actor.organizationId, data.name, id)) throw brandClash();
  const action = before.status !== data.status ? (data.status === "ACTIVE" ? "brand.activated" : "brand.deactivated") : "brand.updated";
  try {
    return await repo.updateBrandRow(actor.organizationId, actor.id, id, data, action);
  } catch (e) {
    if (isUniqueViolation(e)) throw brandClash();
    throw e;
  }
}

export async function setBrandStatus(actor: Actor, id: string, status: "ACTIVE" | "INACTIVE") {
  requirePermission(actor, "items.manage");
  const before = await repo.findBrand(actor.organizationId, id);
  if (!before) throw new NotFoundError("Brand");
  if (before.status === status) return before;
  return repo.updateBrandRow(actor.organizationId, actor.id, id, { name: before.name, description: before.description, status }, status === "ACTIVE" ? "brand.activated" : "brand.deactivated");
}

// ───────────────────────── Item ↔ brand links ─────────────────────────

export async function linkBrand(actor: Actor, input: unknown) {
  requirePermission(actor, "items.manage");
  const data = parse(linkBrandSchema, input);
  if (data.openingQty && !can(actor, "stock.adjust")) throw new ForbiddenError("Posting opening stock requires the Stock adjustments permission.");
  const [item, brand] = await Promise.all([repo.findItem(actor.organizationId, data.itemId), repo.findBrand(actor.organizationId, data.brandId)]);
  if (!item) throw new NotFoundError("Item");
  if (!brand) throw new NotFoundError("Brand");
  if (item.status !== "ACTIVE") throw new ValidationError("Brands cannot be added to an inactive item.");
  if (brand.status !== "ACTIVE") throw new ValidationError("Inactive brands cannot be linked.", { brandId: "This brand is inactive." });
  const today = startOfToday();
  return repo.insertItemBrand(actor.organizationId, actor.id, {
    itemId: item.id,
    brandId: brand.id,
    opening: data.openingQty ? { quantity: data.openingQty, txnDate: toDbDate(data.openingDate) ?? today, today } : null,
  });
}

export async function unlinkBrand(actor: Actor, itemBrandId: string) {
  requirePermission(actor, "items.manage");
  await repo.deleteItemBrand(actor.organizationId, actor.id, itemBrandId);
}

// ─────────────────────────────── Stock ───────────────────────────────

export async function listStockPositionOptions(actor: Actor) {
  if (!can(actor, "stock.post") && !can(actor, "stock.adjust")) return [];
  return repo.findStockPositionOptions(actor.organizationId);
}

export type EvidenceFile = { fileName: string; bytes: Uint8Array };

/**
 * Manual stock change (inward, outward or adjustment) — owner / Super Admin only (`stock.adjust` is
 * super-admin-only), always with a reason and an evidence file stored in the same transaction.
 * Normal stock moves through receipts, challans and consumption. Negative stock is always rejected;
 * the idempotency key makes a repeated submit return the original entry.
 */
export async function postStockMovement(actor: Actor, input: unknown, evidence?: EvidenceFile | null) {
  const data = parse(movementSchema, input);
  requirePermission(actor, "stock.adjust");
  if (!evidence) throw new ValidationError("Attach evidence for this manual stock change (photo, count sheet or document).", { evidence: "Evidence file is required." });
  const position = await repo.findItemBrand(actor.organizationId, data.itemBrandId);
  if (!position) throw new NotFoundError("Stock item");
  if (position.item.status !== "ACTIVE") throw new ValidationError("Stock cannot be posted for an inactive item.", { itemBrandId: "This item is inactive." });
  if (position.brand.status !== "ACTIVE") throw new ValidationError("Stock cannot be posted for an inactive brand.", { itemBrandId: "This brand is inactive." });
  return repo.postMovement({
    organizationId: actor.organizationId,
    actorId: actor.id,
    itemBrandId: position.id,
    locationId: data.locationId,
    type: data.type,
    direction: directionFor(data.type, data.direction),
    quantity: data.quantity,
    txnDate: toDbDate(data.txnDate)!,
    today: startOfToday(),
    reference: data.reference,
    remarks: data.remarks,
    reason: data.reason,
    idempotencyKey: data.idempotencyKey,
    sourceType: "manual",
  }, (tx, txn) => storeEvidenceTx(tx, actor, { entityType: "stock_txn", entityId: txn.id, projectId: null, label: `stock entry ${txn.code}`, category: "OTHER", description: `Evidence: ${data.reason}`, fileName: evidence.fileName, bytes: evidence.bytes }));
}

export async function getStockSummary(actor: Actor, rawQuery: unknown) {
  requirePermission(actor, "items.view");
  const query = stockQuerySchema.parse(rawQuery ?? {});
  const result = await repo.findStockPositions(
    { organizationId: actor.organizationId, q: query.q, itemId: query.itemId, brandId: query.brandId, category: query.category },
    { from: toDbDate(query.from), to: toDbDate(query.to) },
    { skip: (query.page - 1) * query.pageSize, take: query.pageSize },
  );
  return { ...result, page: query.page, pageSize: query.pageSize, query };
}

export async function getLedger(actor: Actor, rawQuery: unknown) {
  requirePermission(actor, "items.view");
  const query = ledgerQuerySchema.parse(rawQuery ?? {});
  const result = await repo.findLedger(
    { organizationId: actor.organizationId, q: query.q, itemId: query.itemId, brandId: query.brandId, type: query.type, locationId: query.locationId, projectId: query.projectId, from: toDbDate(query.from), to: toDbDate(query.to) },
    { skip: (query.page - 1) * query.pageSize, take: query.pageSize },
  );
  return { ...result, page: query.page, pageSize: query.pageSize, query };
}
