import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { syncRbac } from "@/modules/auth/rbac-sync";
import { ledgerBalance } from "@/modules/inventory/repository";
import {
  createBrand,
  createItem,
  getItem,
  getLedger,
  getStockSummary,
  linkBrand,
  listBrands,
  listItems,
  postStockMovement,
  setBrandStatus,
  setItemStatus,
  unlinkBrand,
  updateBrand,
  updateItem,
} from "@/modules/inventory/service";
import { startOfToday } from "@/modules/tasks/rules";
import { actorFor, createOrg, createUser, standardFixture } from "./helpers";

let fx: Awaited<ReturnType<typeof standardFixture>>;

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error("Expected rejection");
}

const day = (offset = 0) => {
  const d = startOfToday();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  fx = await standardFixture();
});

/** Item with two brands; superAdmin posts opening stock (needs stock.adjust). */
async function cementWithTwoBrands(openingA = "100", openingB = "40") {
  const item = await createItem(fx.actors.admin, { name: "OPC Cement 53 Grade", category: "Cement", unit: "Bag" });
  const a = await createBrand(fx.actors.admin, { name: "UltraTech" });
  const b = await createBrand(fx.actors.admin, { name: "ACC" });
  const linkA = await linkBrand(fx.actors.superAdmin, { itemId: item.id, brandId: a.id, openingQty: openingA, openingDate: day(-5) });
  const linkB = await linkBrand(fx.actors.superAdmin, { itemId: item.id, brandId: b.id, openingQty: openingB, openingDate: day(-5) });
  return { item, a, b, linkA, linkB };
}

const move = (itemBrandId: string, type: "INWARD" | "OUTWARD" | "ADJUSTMENT", quantity: string, extra: Record<string, unknown> = {}) => ({
  itemBrandId,
  type,
  quantity,
  txnDate: day(),
  reference: "REF-1",
  reason: "Stock correction",
  idempotencyKey: randomUUID(),
  ...extra,
});

/** Manual stock changes are owner (Super Admin) only and need evidence (workflow v2 · Phase 5). */
const EVIDENCE = { fileName: "count-sheet.pdf", bytes: new TextEncoder().encode("%PDF-1.4 count sheet") };
const manual = (input: ReturnType<typeof move>, actor: Parameters<typeof postStockMovement>[0] = fx.actors.superAdmin) => postStockMovement(actor, input, EVIDENCE);

describe("items master", () => {
  it("creates items with generated or manual codes and rejects duplicate codes", async () => {
    const auto = await createItem(fx.actors.admin, { name: "TMT Bar 12mm", category: "Steel", unit: "Kg" });
    expect(auto.code).toBe("ITM-0001");
    const manual = await createItem(fx.actors.admin, { code: "pipe-25", name: "PVC Pipe 25mm", unit: "Mtr" });
    expect(manual.code).toBe("PIPE-25");

    const dup = await errorOf(createItem(fx.actors.admin, { code: "PIPE-25", name: "Another", unit: "Mtr" }));
    expect(dup.code).toBe("CONFLICT");
    expect(dup.fieldErrors?.code).toBeTruthy();
    // A manual code that collides with the next generated number is skipped, not duplicated.
    await createItem(fx.actors.admin, { code: "ITM-0002", name: "Manual collides", unit: "Nos" });
    expect((await createItem(fx.actors.admin, { name: "Next auto", unit: "Nos" })).code).toBe("ITM-0003");
  });

  it("edits, deactivates, searches and filters items", async () => {
    const item = await createItem(fx.actors.admin, { name: "TMT Bar 12mm", category: "Steel", unit: "Kg" });
    await createItem(fx.actors.admin, { name: "Wall Putty", category: "Finishes", unit: "Bag" });
    const updated = await updateItem(fx.actors.admin, item.id, { code: item.code, name: "TMT Bar 12 mm Fe500", category: "Steel", unit: "Kg", status: "ACTIVE" });
    expect(updated.name).toBe("TMT Bar 12 mm Fe500");
    expect((await errorOf(updateItem(fx.actors.admin, item.id, { name: "", unit: "Kg" }))).code).toBe("VALIDATION");

    expect((await listItems(fx.actors.admin, { q: "fe500" })).rows.map((r) => r.id)).toEqual([item.id]);
    expect((await listItems(fx.actors.admin, { category: "finishes" })).total).toBe(1);
    await setItemStatus(fx.actors.admin, item.id, "INACTIVE");
    expect((await listItems(fx.actors.admin, { status: "INACTIVE" })).rows.map((r) => r.id)).toEqual([item.id]);
    expect(await db.auditLog.count({ where: { entityId: item.id, action: "item.deactivated" } })).toBe(1);
  });
});

describe("brands master", () => {
  it("creates brands with unique (case-insensitive) names and edits them", async () => {
    const b = await createBrand(fx.actors.admin, { name: "Havells" });
    expect(b.code).toBe("BRD-001");
    expect((await errorOf(createBrand(fx.actors.admin, { name: "havells" }))).code).toBe("CONFLICT");
    const other = await createBrand(fx.actors.admin, { name: "Polycab" });
    expect((await errorOf(updateBrand(fx.actors.admin, other.id, { name: "HAVELLS" }))).code).toBe("CONFLICT");
    await updateBrand(fx.actors.admin, other.id, { name: "Polycab India", description: "Cables" });
    expect((await listBrands(fx.actors.admin, { q: "india" })).rows[0]?.name).toBe("Polycab India");
  });

  it("associates multiple brands with an item and blocks duplicate links", async () => {
    const { item, a } = await cementWithTwoBrands();
    const detail = await getItem(fx.actors.admin, item.id);
    expect(detail.positions.map((p) => p.brand.name).sort()).toEqual(["ACC", "UltraTech"]);
    expect((await errorOf(linkBrand(fx.actors.admin, { itemId: item.id, brandId: a.id }))).code).toBe("CONFLICT");
  });
});

describe("brand-wise stock", () => {
  it("keeps each item–brand balance independent", async () => {
    const { item, linkA, linkB } = await cementWithTwoBrands("100", "40");
    await manual(move(linkA.id, "INWARD", "25.5"));
    const detail = await getItem(fx.actors.admin, item.id);
    const byBrand = Object.fromEntries(detail.positions.map((p) => [p.brand.name, p.currentQty]));
    expect(byBrand).toEqual({ UltraTech: "125.5", ACC: "40" });
    expect((await ledgerBalance(linkB.id)).current).toBe("40");
  });

  it("calculates opening, inward, outward and closing (all-time and by period)", async () => {
    const { linkA } = await cementWithTwoBrands("100", "0");
    await manual(move(linkA.id, "INWARD", "50", { txnDate: day(-3) }));
    await manual(move(linkA.id, "OUTWARD", "30", { txnDate: day(-1) }));
    await manual(move(linkA.id, "OUTWARD", "0.250", { txnDate: day() }));

    const all = (await getStockSummary(fx.actors.admin, {})).rows.find((r) => r.id === linkA.id)!;
    expect([all.opening, all.inward, all.outward, all.closing, all.currentQty]).toEqual(["100", "50", "30.25", "119.75", "119.75"]);

    // Period starting after the inward: opening includes everything before it.
    const period = (await getStockSummary(fx.actors.admin, { from: day(-2), to: day(-1) })).rows.find((r) => r.id === linkA.id)!;
    expect([period.opening, period.inward, period.outward, period.closing]).toEqual(["150", "0", "30", "120"]);

    const ledger = await getLedger(fx.actors.admin, {});
    const balances = ledger.rows.filter((r) => r.brand.name === "UltraTech").map((r) => r.balanceAfter);
    expect(balances).toEqual(["119.75", "120", "150", "100"]);
    expect(await ledgerBalance(linkA.id)).toEqual({ ledger: "119.75", current: "119.75" });
  });

  it("prevents negative stock for outward and adjustments", async () => {
    const { linkA } = await cementWithTwoBrands("10", "0");
    const e = await errorOf(manual(move(linkA.id, "OUTWARD", "10.001")));
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("Insufficient stock");
    const adj = await errorOf(manual(move(linkA.id, "ADJUSTMENT", "11", { direction: "OUT", reason: "Damaged" })));
    expect(adj.code).toBe("VALIDATION");
    expect(await ledgerBalance(linkA.id)).toEqual({ ledger: "10", current: "10" });
    expect(await db.stockTransaction.count({ where: { itemBrandId: linkA.id } })).toBe(1);
    // Exactly to zero is allowed.
    await manual(move(linkA.id, "OUTWARD", "10"));
    expect((await ledgerBalance(linkA.id)).current).toBe("0");
  });

  it("requires a reason for adjustments and records them in the audit log", async () => {
    const { linkA } = await cementWithTwoBrands("10", "0");
    const noReason = await errorOf(manual(move(linkA.id, "ADJUSTMENT", "2", { direction: "OUT", reason: "" })));
    expect(noReason.code).toBe("VALIDATION");
    expect(noReason.fieldErrors?.reason).toBeTruthy();
    const { txn } = await manual(move(linkA.id, "ADJUSTMENT", "2", { direction: "OUT", reason: "Bags torn in storage" }));
    expect(txn.balanceAfter).toBe("8");
    expect(await db.auditLog.count({ where: { entityId: txn.id, action: "stock.adjusted" } })).toBe(1);
  });

  it("rejects future dates and back-dating before the latest movement", async () => {
    const { linkA } = await cementWithTwoBrands("10", "0");
    expect((await errorOf(manual(move(linkA.id, "INWARD", "1", { txnDate: day(1) })))).fieldErrors?.txnDate).toBeTruthy();
    await manual(move(linkA.id, "INWARD", "1", { txnDate: day(-1) }));
    expect((await errorOf(manual(move(linkA.id, "INWARD", "1", { txnDate: day(-2) })))).fieldErrors?.txnDate).toBeTruthy();
    expect((await ledgerBalance(linkA.id)).current).toBe("11");
  });

  it("blocks posting and linking for inactive items or brands", async () => {
    const { item, a, b, linkA, linkB } = await cementWithTwoBrands("10", "10");
    await setBrandStatus(fx.actors.admin, b.id, "INACTIVE");
    expect((await errorOf(manual(move(linkB.id, "INWARD", "1")))).code).toBe("VALIDATION");
    await setItemStatus(fx.actors.admin, item.id, "INACTIVE");
    expect((await errorOf(manual(move(linkA.id, "INWARD", "1")))).code).toBe("VALIDATION");
    const c = await createBrand(fx.actors.admin, { name: "Ambuja" });
    expect((await errorOf(linkBrand(fx.actors.admin, { itemId: item.id, brandId: c.id }))).code).toBe("VALIDATION");
    expect(a.id).toBeTruthy();
  });

  it("only removes brand links that have no stock history", async () => {
    const { linkA } = await cementWithTwoBrands("10", "0");
    expect((await errorOf(unlinkBrand(fx.actors.admin, linkA.id))).code).toBe("CONFLICT");
    const item = await createItem(fx.actors.admin, { name: "Sand", unit: "Cum" });
    const brand = await createBrand(fx.actors.admin, { name: "Local" });
    const link = await linkBrand(fx.actors.admin, { itemId: item.id, brandId: brand.id });
    await unlinkBrand(fx.actors.admin, link.id);
    expect(await db.itemBrand.count({ where: { id: link.id } })).toBe(0);
  });
});

describe("duplicate posting & concurrency", () => {
  it("posts a retried submission only once", async () => {
    const { linkA } = await cementWithTwoBrands("10", "0");
    const input = move(linkA.id, "INWARD", "5");
    const first = await manual(input);
    const again = await manual(input);
    expect(again.duplicate).toBe(true);
    expect(again.txn.id).toBe(first.txn.id);
    expect((await ledgerBalance(linkA.id)).current).toBe("15");
    // Reusing the key for a different entry is refused.
    expect((await errorOf(manual({ ...input, quantity: "6" }))).code).toBe("CONFLICT");
  });

  it("posts concurrent identical submissions only once", async () => {
    const { linkA } = await cementWithTwoBrands("10", "0");
    const input = move(linkA.id, "OUTWARD", "4");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => manual(input)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await db.stockTransaction.count({ where: { itemBrandId: linkA.id, type: "OUTWARD" } })).toBe(1);
    expect(await ledgerBalance(linkA.id)).toEqual({ ledger: "6", current: "6" });
  });

  it("never oversells under concurrent outward postings", async () => {
    const { linkA, linkB } = await cementWithTwoBrands("10", "10");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => manual(move(linkA.id, "OUTWARD", "3"))));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(3);
    for (const r of results) if (r.status === "rejected") expect((r.reason as AppError).code).toBe("VALIDATION");
    expect(await ledgerBalance(linkA.id)).toEqual({ ledger: "1", current: "1" });
    const balances = (await db.stockTransaction.findMany({ where: { itemBrandId: linkA.id }, orderBy: { createdAt: "asc" }, select: { balanceAfter: true } })).map((t) => t.balanceAfter.toFixed());
    expect(balances).toEqual(["10", "7", "4", "1"]);
    expect((await ledgerBalance(linkB.id)).current).toBe("10");
  });

  it("serialises concurrent inward and outward on one position", async () => {
    const { linkA } = await cementWithTwoBrands("5", "0");
    await Promise.allSettled([
      ...Array.from({ length: 5 }, () => manual(move(linkA.id, "INWARD", "2"))),
      ...Array.from({ length: 5 }, () => manual(move(linkA.id, "OUTWARD", "1"))),
    ]);
    const { ledger, current } = await ledgerBalance(linkA.id);
    expect(ledger).toBe(current);
    expect(Number(current)).toBeGreaterThanOrEqual(0);
  });
});

describe("permissions", () => {
  it("lets ADMIN manage items but not change stock manually (owner only); USER has no inventory access", async () => {
    const { item, a } = await cementWithTwoBrands("10", "0");
    const link = (await getItem(fx.actors.admin, item.id)).positions.find((p) => p.brand.id === a.id)!;
    expect((await errorOf(manual(move(link.id, "ADJUSTMENT", "1", { direction: "IN", reason: "Count" }), fx.actors.admin))).code).toBe("FORBIDDEN");
    expect((await errorOf(manual(move(link.id, "INWARD", "1"), fx.actors.admin))).code).toBe("FORBIDDEN");
    const c = await createBrand(fx.actors.admin, { name: "JK" });
    expect((await errorOf(linkBrand(fx.actors.admin, { itemId: item.id, brandId: c.id, openingQty: "5" }))).code).toBe("FORBIDDEN");

    const user = fx.actors.amit;
    expect((await errorOf(listItems(user, {}))).code).toBe("FORBIDDEN");
    expect((await errorOf(getStockSummary(user, {}))).code).toBe("FORBIDDEN");
    expect((await errorOf(createItem(user, { name: "Hack", unit: "Nos" }))).code).toBe("FORBIDDEN");
    expect((await errorOf(createBrand(user, { name: "Hack" }))).code).toBe("FORBIDDEN");
    expect((await errorOf(manual(move(link.id, "INWARD", "1"), user))).code).toBe("FORBIDDEN");
    expect((await ledgerBalance(link.id)).current).toBe("10");
  });

  it("isolates organizations", async () => {
    const { item, linkA } = await cementWithTwoBrands("10", "0");
    const other = await createOrg("Other Co");
    const outsider = await actorFor((await createUser(other.id, "SUPER_ADMIN")).id);
    expect((await errorOf(getItem(outsider, item.id))).code).toBe("NOT_FOUND");
    expect((await errorOf(manual(move(linkA.id, "INWARD", "1"), outsider))).code).toBe("NOT_FOUND");
    expect((await getStockSummary(outsider, {})).total).toBe(0);
  });

  it("grants new permissions' defaults to existing roles without undoing customisations", async () => {
    const admin = await db.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    const inventory = await db.permission.findMany({ where: { key: { in: ["items.view", "items.manage", "stock.post", "stock.adjust"] } } });
    // Simulate a database from before Phase 2, where a Super Admin also revoked tasks.create from ADMIN.
    await db.rolePermission.deleteMany({ where: { permissionId: { in: inventory.map((p) => p.id) } } });
    await db.permission.deleteMany({ where: { id: { in: inventory.map((p) => p.id) } } });
    const tasksCreate = await db.permission.findUniqueOrThrow({ where: { key: "tasks.create" } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: admin.id, permissionId: tasksCreate.id } } });

    await syncRbac(db as never);
    const keys = (await db.rolePermission.findMany({ where: { roleId: admin.id }, include: { permission: true } })).map((r) => r.permission.key);
    expect(keys).toEqual(expect.arrayContaining(["items.view", "items.manage", "stock.post"]));
    expect(keys).not.toContain("stock.adjust");
    expect(keys).not.toContain("tasks.create");
  });
});
