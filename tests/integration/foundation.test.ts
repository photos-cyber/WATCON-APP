import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { assertCanApprove } from "@/modules/commercial/core";
import { deleteAttachment, listAttachments, readAttachment, uploadAttachment, verifyAttachment } from "@/modules/documents/attachments";
import { ensureSiteLocation, postMovementTx } from "@/modules/inventory/engine";
import { listLocationBalances, recordConsumption, releaseReservation, reserveStock, reverseStockEntry } from "@/modules/inventory/locations";
import { ledgerBalance } from "@/modules/inventory/repository";
import { postStockMovement } from "@/modules/inventory/service";
import { createParty, updateParty } from "@/modules/parties/service";
import { startOfToday } from "@/modules/tasks/rules";
import { nextDocNumber } from "@/lib/doc-numbering";
import { commercialFixture, day, errorOf, key, type CFx, PDF } from "./commercial-helpers";

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

async function moveToSite(qty: string, itemBrandId = fx.ibUltra.id, projectId = fx.p1.id) {
  return db.$transaction(async (tx) => {
    const site = await ensureSiteLocation(tx, fx.org.id, projectId);
    const today = startOfToday();
    await postMovementTx(tx, { organizationId: fx.org.id, actorId: fx.users.admin.id, itemBrandId, locationId: fx.warehouse.id, projectId, type: "TRANSFER_OUT", direction: "OUT", quantity: qty, txnDate: today, today, idempotencyKey: key() });
    await postMovementTx(tx, { organizationId: fx.org.id, actorId: fx.users.admin.id, itemBrandId, locationId: site, projectId, type: "TRANSFER_IN", direction: "IN", quantity: qty, txnDate: today, today, idempotencyKey: key() });
    return site;
  });
}

describe("location-aware stock engine", () => {
  it("keeps per-location balances and the company total consistent", async () => {
    const site = await moveToSite("30");
    const bal = await db.stockBalance.findMany({ where: { itemBrandId: fx.ibUltra.id } });
    expect(Object.fromEntries(bal.map((b) => [b.locationId, b.onHand.toFixed(0)]))).toEqual({ [fx.warehouse.id]: "70", [site]: "30" });
    const ib = await db.itemBrand.findUniqueOrThrow({ where: { id: fx.ibUltra.id } });
    expect(ib.currentQty.toFixed(0)).toBe("100");
    expect(await ledgerBalance(fx.ibUltra.id)).toEqual({ ledger: "100", current: "100" });
  });

  it("refuses to take more than a location holds even if the company total is enough", async () => {
    const site = await moveToSite("10");
    const today = startOfToday();
    const e = await errorOf(db.$transaction((tx) => postMovementTx(tx, { organizationId: fx.org.id, actorId: fx.users.admin.id, itemBrandId: fx.ibUltra.id, locationId: site, type: "CONSUMPTION", direction: "OUT", quantity: "11", txnDate: today, today, idempotencyKey: key() })));
    expect(e.message).toMatch(/Insufficient stock/);
  });

  it("manual Phase 2 movements still default to the Central Warehouse", async () => {
    const { txn } = await postStockMovement(fx.actors.superAdmin, { itemBrandId: fx.ibAcc.id, type: "OUTWARD", quantity: "5", txnDate: day(), reason: "Count correction", idempotencyKey: key() }, { fileName: "sheet.pdf", bytes: PDF });
    expect(txn.locationId).toBe(fx.warehouse.id);
    expect(txn.balanceAfter).toBe("35");
  });

  it("site consumption is idempotent and attributed to the project", async () => {
    await moveToSite("20");
    const k = key();
    const a = await recordConsumption(fx.roles.se.actor, { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id, quantity: "4", txnDate: day(), idempotencyKey: k });
    const b = await recordConsumption(fx.roles.se.actor, { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id, quantity: "4", txnDate: day(), idempotencyKey: k });
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
    const t = await db.stockTransaction.findUniqueOrThrow({ where: { id: a.id } });
    expect([t.type, t.projectId, t.balanceAfter.toFixed(0)]).toEqual(["CONSUMPTION", fx.p1.id, "16"]);
  });

  it("an engineer outside the project cannot record consumption there", async () => {
    const e = await errorOf(recordConsumption(fx.roles.outsider.actor, { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id, quantity: "1", txnDate: day(), idempotencyKey: key() }));
    expect(e.message).toMatch(/not found/i);
  });

  it("reversals post an opposite entry once and never edit history", async () => {
    const { txn } = await postStockMovement(fx.actors.superAdmin, { itemBrandId: fx.ibAcc.id, type: "INWARD", quantity: "10", txnDate: day(), reason: "Count correction", idempotencyKey: key() }, { fileName: "sheet.pdf", bytes: PDF });
    const rev = await reverseStockEntry(fx.actors.superAdmin, txn.id, { reason: "Entered twice by mistake" });
    expect([rev.type, rev.direction, rev.balanceAfter]).toEqual(["REVERSAL", "OUT", "40"]);
    expect((await errorOf(reverseStockEntry(fx.actors.superAdmin, txn.id, { reason: "Again please" }))).message).toMatch(/already reversed/);
    expect((await errorOf(reverseStockEntry(fx.actors.admin, txn.id, { reason: "No permission" }))).message).toMatch(/permission/);
    const original = await db.stockTransaction.findUniqueOrThrow({ where: { id: txn.id } });
    expect(original.quantity.toFixed(0)).toBe("10");
  });
});

describe("reservations", () => {
  it("protects reserved stock from other projects and is consumed by the owning project", async () => {
    await reserveStock(fx.roles.pm.actor, { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id, locationId: fx.warehouse.id, quantity: "80" });
    const today = startOfToday();
    const forP2 = (q: string) => db.$transaction((tx) => postMovementTx(tx, { organizationId: fx.org.id, actorId: fx.users.admin.id, itemBrandId: fx.ibUltra.id, locationId: fx.warehouse.id, projectId: fx.p2.id, type: "TRANSFER_OUT", direction: "OUT", quantity: q, txnDate: today, today, idempotencyKey: key() }));
    expect((await errorOf(forP2("21"))).message).toMatch(/reserved for other projects/);
    await forP2("20");
    // P1 issue consumes its own reservation
    await db.$transaction((tx) => postMovementTx(tx, { organizationId: fx.org.id, actorId: fx.users.admin.id, itemBrandId: fx.ibUltra.id, locationId: fx.warehouse.id, projectId: fx.p1.id, type: "TRANSFER_OUT", direction: "OUT", quantity: "30", txnDate: today, today, idempotencyKey: key() }));
    const r = await db.stockReservation.findFirstOrThrow({ where: { projectId: fx.p1.id } });
    expect([r.issuedQty.toFixed(0), r.status]).toEqual(["30", "ACTIVE"]);
    const view = await listLocationBalances(fx.actors.admin, { locationId: fx.warehouse.id });
    const row = view.rows.find((x) => x.itemBrandId === fx.ibUltra.id)!;
    expect([row.onHand, row.reserved, row.available]).toEqual(["50", "50", "0"]);
  });

  it("cannot over-promise, even with two concurrent reservations", async () => {
    const r = await Promise.allSettled([
      reserveStock(fx.roles.pm.actor, { projectId: fx.p1.id, itemBrandId: fx.ibAcc.id, locationId: fx.warehouse.id, quantity: "30" }),
      reserveStock(fx.roles.pm.actor, { projectId: fx.p2.id, itemBrandId: fx.ibAcc.id, locationId: fx.warehouse.id, quantity: "30" }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const total = await db.stockReservation.aggregate({ where: { itemBrandId: fx.ibAcc.id, status: "ACTIVE" }, _sum: { quantity: true } });
    expect(total._sum.quantity?.toFixed(0)).toBe("30");
  });

  it("released reservations free the stock", async () => {
    const res = await reserveStock(fx.roles.pm.actor, { projectId: fx.p1.id, itemBrandId: fx.ibAcc.id, locationId: fx.warehouse.id, quantity: "40" });
    await releaseReservation(fx.roles.pm.actor, res.id);
    expect((await errorOf(releaseReservation(fx.roles.pm.actor, res.id))).message).toMatch(/no longer active/);
    await reserveStock(fx.roles.pm.actor, { projectId: fx.p2.id, itemBrandId: fx.ibAcc.id, locationId: fx.warehouse.id, quantity: "40" });
  });
});

describe("attachments", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3]);
  const upload = (actor: CFx["actors"]["admin"], extra: Record<string, unknown> = {}) =>
    uploadAttachment(actor, { entityType: "project", entityId: fx.p1.id, category: "SIGNED_DOCUMENT", fileName: "agreement.pdf", bytes: pdf, ...extra } as never);

  it("stores, lists and serves files with integrity metadata", async () => {
    const a = await upload(fx.roles.se.actor);
    const list = await listAttachments(fx.roles.pm.actor, "project", fx.p1.id);
    expect(list.items.map((i) => i.fileName)).toEqual(["agreement.pdf"]);
    const file = await readAttachment(fx.roles.pm.actor, a.id);
    expect(file.mimeType).toBe("application/pdf");
    expect(Buffer.compare(file.bytes, Buffer.from(pdf))).toBe(0);
  });

  it("denies people who cannot see the project (404, not 403)", async () => {
    const a = await upload(fx.roles.se.actor);
    expect((await errorOf(readAttachment(fx.roles.outsider.actor, a.id))).message).toMatch(/not found/i);
    expect((await errorOf(listAttachments(fx.roles.outsider.actor, "project", fx.p1.id))).message).toMatch(/not found/i);
    expect((await errorOf(upload(fx.roles.outsider.actor))).message).toMatch(/not found/i);
  });

  it("rejects disguised executables and oversized files", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    expect((await errorOf(upload(fx.roles.se.actor, { bytes: exe, fileName: "invoice.pdf" }))).message).toMatch(/Unsupported/);
    const big = new Uint8Array(5 * 1024 * 1024);
    big.set(pdf);
    expect((await errorOf(upload(fx.roles.se.actor, { bytes: big }))).message).toMatch(/MB or smaller/);
  });

  it("keeps versions, enforces separation of duties on verification, retains verified evidence", async () => {
    const v1 = await upload(fx.roles.se.actor);
    const v2 = await upload(fx.roles.se.actor, { replacesId: v1.id, fileName: "agreement-signed.pdf" });
    expect(v2.version).toBe(2);
    expect((await errorOf(upload(fx.roles.se.actor, { replacesId: v1.id }))).message).toMatch(/newer version/);
    const list = await listAttachments(fx.roles.pm.actor, "project", fx.p1.id);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.history.map((h) => h.version)).toEqual([1]);
    // uploader cannot verify own evidence
    const pmUpload = await upload(fx.roles.pm.actor);
    expect((await errorOf(verifyAttachment(fx.roles.pm.actor, pmUpload.id, { status: "VERIFIED" }))).message).toMatch(/Separation of duties/);
    await verifyAttachment(fx.roles.pm.actor, v2.id, { status: "VERIFIED" });
    expect((await errorOf(deleteAttachment(fx.roles.se.actor, v2.id, { reason: "wrong file" }))).message).toMatch(/Verified evidence/);
    await deleteAttachment(fx.roles.se.actor, pmUpload.id, { reason: "duplicate" });
    expect((await listAttachments(fx.roles.pm.actor, "project", fx.p1.id)).items).toHaveLength(1);
  });
});

describe("parties, numbering and approvals", () => {
  it("prevents case-insensitive duplicate names and duplicate GSTINs", async () => {
    expect((await errorOf(createParty(fx.actors.admin, { name: "shree cement TRADERS", isSupplier: true }))).message).toMatch(/already exists/);
    expect((await errorOf(createParty(fx.actors.admin, { name: "Another Co", isSupplier: true, gstin: "27AAPFU0939F1ZV" }))).message).toMatch(/GSTIN already registered/);
    await updateParty(fx.actors.admin, fx.supplier.id, { name: "Shree Cement Traders", isSupplier: true, isClient: true, gstin: "27AAPFU0939F1ZV" });
    expect((await errorOf(createParty(fx.roles.se.actor, { name: "Nope", isSupplier: true }))).message).toMatch(/permission/);
  });

  it("allocates unique FY numbers under concurrency", async () => {
    const date = new Date("2026-11-20T00:00:00Z");
    const nums = await Promise.all(Array.from({ length: 10 }, () => db.$transaction((tx) => nextDocNumber(tx, fx.org.id, "PO", date))));
    expect(new Set(nums).size).toBe(10);
    expect(nums.sort()[0]).toBe("PO/2026-27/0001");
    expect(await db.$transaction((tx) => nextDocNumber(tx, fx.org.id, "PO", new Date("2027-04-02T00:00:00Z")))).toBe("PO/2027-28/0001");
  });

  it("separation of duties and approval limits", async () => {
    const opts = { permission: "po.approve" as const, docType: "PO", amount: "500000.00", createdById: fx.users.admin.id, submittedById: fx.users.admin.id, what: "purchase order" };
    expect((await errorOf(assertCanApprove(fx.actors.admin, opts))).message).toMatch(/Separation of duties/);
    await assertCanApprove(fx.actors.otherAdmin, opts);
    await db.approvalLimit.create({ data: { organizationId: fx.org.id, roleKey: "ADMIN", docType: "PO", maxAmount: "100000" } });
    expect((await errorOf(assertCanApprove(fx.actors.otherAdmin, opts))).message).toMatch(/exceeds your approval limit/);
    await assertCanApprove(fx.actors.superAdmin, opts);
    expect((await errorOf(assertCanApprove(fx.roles.pu.actor, { ...opts, createdById: null, submittedById: null }))).message).toMatch(/permission/);
  });
});
