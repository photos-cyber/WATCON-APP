import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { deleteAttachment, uploadAttachment } from "@/modules/documents/attachments";
import { inventoryIntegrityReport } from "@/modules/inventory/integrity";
import { billAction, billPrefillFromPo, createBill } from "@/modules/payables/bills";
import { createPoFromPlanning } from "@/modules/planning/ordering";
import { getMrp } from "@/modules/planning/service";
import { createPo, getPo, poAction } from "@/modules/procurement/po";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { createGrn, getGrn, grnAction, postGrn, updateGrn } from "@/modules/stores/grn";
import { PDF, PNG, addReceiptProof, commercialFixture, day, errorOf, key, receiveWithProof, type CFx } from "./commercial-helpers";

/** Workflow v2 · Phase 4 — material receiving with mandatory proof. */

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "purchaseOrder" | "grn" | "supplierBill" | "salesOrder";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

async function approvedPo(qty = "100", projectId: string | null = fx.p1.id) {
  const po = await createPo(fx.roles.pu.actor, { projectId, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "400", gstRate: "28" }] });
  await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true, deliveryLocation: true } });
}
const draft = (poId: string, poLineId: string, receivedQty: string, extra: Record<string, string> = {}) => createGrn(fx.roles.se.actor, { clientKey: key(), poId, receiptDate: day(), receivedByName: "Ramesh", supplierChallanNo: "DC-77", lines: [{ poLineId, receivedQty, ...extra }] });
const balanceAt = async (locationId: string) => (await db.stockBalance.findFirst({ where: { itemBrandId: fx.ibUltra.id, locationId } }))?.onHand.toString() ?? "0";
const moves = (grnId: string) => db.stockTransaction.count({ where: { sourceType: "grn", sourceId: grnId } });

describe("mandatory proof", () => {
  it("a draft can be saved without proof, but cannot be submitted until photo and delivery challan are uploaded", async () => {
    const po = await approvedPo();
    // Submitting straight away is refused (files can only be added to a saved draft).
    expect((await errorOf(createGrn(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), submit: true, lines: [{ poLineId: po.lines[0]!.id, receivedQty: "10" }] }))).message).toMatch(/mandatory proof.*Material photos.*Supplier delivery challan/);
    const g = await draft(po.id, po.lines[0]!.id, "10");
    expect((await db.grn.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("DRAFT");
    expect((await errorOf(grnAction(fx.roles.se.actor, g.id, "submit", { version: await v("grn", g.id) }))).message).toMatch(/Material photos; Supplier delivery challan/);
    // A PDF filed as a "material photo" does not count as a photo.
    await uploadAttachment(fx.roles.se.actor, { entityType: "grn", entityId: g.id, category: "MATERIAL_PHOTO", fileName: "photo.pdf", bytes: PDF });
    await uploadAttachment(fx.roles.se.actor, { entityType: "grn", entityId: g.id, category: "DELIVERY_CHALLAN", fileName: "dc.pdf", bytes: PDF });
    let view = await getGrn(fx.roles.se.actor, g.id);
    expect(view.proof.missing).toEqual(["Material photos"]);
    expect((await errorOf(grnAction(fx.roles.se.actor, g.id, "submit", { version: await v("grn", g.id) }))).message).toMatch(/Material photos/);
    await uploadAttachment(fx.roles.se.actor, { entityType: "grn", entityId: g.id, category: "MATERIAL_PHOTO", fileName: "photo.png", bytes: PNG });
    view = await getGrn(fx.roles.se.actor, g.id);
    expect(view.proof.complete).toBe(true);
    // Confirming with complete proof posts straight to stock (no separate verification).
    await grnAction(fx.roles.se.actor, g.id, "submit", { version: await v("grn", g.id) });
    expect((await db.grn.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("POSTED");
    expect(await moves(g.id)).toBe(1);
  });

  it("damaged or rejected material needs damage photos; editing to submit re-checks", async () => {
    const po = await approvedPo();
    const g = await draft(po.id, po.lines[0]!.id, "10", { damagedQty: "2" });
    await addReceiptProof(fx.roles.se.actor, g.id);
    expect((await errorOf(grnAction(fx.roles.se.actor, g.id, "submit", { version: await v("grn", g.id) }))).message).toMatch(/Damaged \/ rejected material/);
    // Editing the draft to remove the damage and submit in one go is allowed (no damage photo needed any more).
    await updateGrn(fx.roles.se.actor, g.id, await v("grn", g.id), { clientKey: key(), poId: po.id, receiptDate: day(), submit: true, lines: [{ poLineId: po.lines[0]!.id, receivedQty: "10" }] });
    expect((await db.grn.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("POSTED");
    expect(await moves(g.id)).toBe(1);
    // Rejected quantity also needs damage evidence when editing to submit.
    const g2 = await draft(po.id, po.lines[0]!.id, "5");
    await addReceiptProof(fx.roles.se.actor, g2.id);
    expect((await errorOf(updateGrn(fx.roles.se.actor, g2.id, await v("grn", g2.id), { clientKey: key(), poId: po.id, receiptDate: day(), submit: true, lines: [{ poLineId: po.lines[0]!.id, receivedQty: "5", rejectedQty: "1" }] }))).message).toMatch(/Damaged \/ rejected material/);
  });

  it("posting a receipt left SUBMITTED by the old flow re-checks proof (a file removed meanwhile blocks it)", async () => {
    const po = await approvedPo();
    const g = await draft(po.id, po.lines[0]!.id, "10");
    await addReceiptProof(fx.roles.se.actor, g.id);
    await db.grn.update({ where: { id: g.id }, data: { status: "SUBMITTED", submittedById: fx.roles.se.user.id, submittedAt: new Date() } });
    const photo = await db.attachment.findFirstOrThrow({ where: { entityType: "grn", entityId: g.id, category: "MATERIAL_PHOTO" } });
    await deleteAttachment(fx.roles.se.actor, photo.id, { reason: "Wrong photo" });
    expect((await errorOf(postGrn(fx.roles.sk.actor, g.id, await v("grn", g.id)))).message).toMatch(/Material photos/);
    expect(await moves(g.id)).toBe(0);
    // Once posted, the evidence is retained.
    await addReceiptProof(fx.roles.se.actor, g.id, { challan: false });
    await postGrn(fx.roles.sk.actor, g.id, await v("grn", g.id));
    const keep = await db.attachment.findFirstOrThrow({ where: { entityType: "grn", entityId: g.id, deletedAt: null, category: "MATERIAL_PHOTO" } });
    expect((await errorOf(deleteAttachment(fx.roles.se.actor, keep.id, { reason: "Wrong file" }))).message).toMatch(/retained/);
  });
});

describe("quantities, partial receipt and stock", () => {
  it("rejects invalid quantities", async () => {
    const po = await approvedPo("10");
    expect((await errorOf(draft(po.id, po.lines[0]!.id, "5", { damagedQty: "3", rejectedQty: "3" }))).message).toMatch(/cannot exceed the received/);
    expect((await errorOf(draft(po.id, po.lines[0]!.id, "0"))).message).toMatch(/at least one line/);
    const other = await approvedPo("10");
    expect((await errorOf(draft(po.id, other.lines[0]!.id, "1"))).message).toMatch(/does not belong/);
    // More than ordered is refused when the receipt is confirmed (no tolerance set).
    expect((await errorOf(receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "11" }] }))).message).toMatch(/exceed the ordered quantity/);
  });

  it("partial receipts delivered straight to the project site update stock, the PO and material planning", async () => {
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "200", rate: "450", gstRate: "28" }] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    const req = (await getMrp(fx.roles.pu.actor, { projectId: fx.p1.id })).rows[0]!;
    const created = await createPoFromPlanning(fx.roles.pu.actor, { partyId: fx.supplier.id, lines: [{ requirementId: req.requirementId, itemBrandId: fx.ibUltra.id, quantity: "100", rate: "400" }] });
    await poAction(fx.actors.admin, created.id, "finalize", { version: await v("purchaseOrder", created.id) });
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: created.id }, include: { lines: true, deliveryLocation: true } });
    expect([po.deliveryLocation.type, po.deliveryLocation.projectId]).toEqual(["SITE", fx.p1.id]);

    const g1 = await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "45", rejectedQty: "5" }] });
    expect(await balanceAt(po.deliveryLocationId)).toBe("40");
    expect(await balanceAt(fx.warehouse.id)).toBe("100"); // opening stock untouched: delivery went to site
    const tx = await db.stockTransaction.findFirstOrThrow({ where: { sourceType: "grn", sourceId: g1.id } });
    expect([tx.type, tx.direction, tx.quantity.toString(), tx.locationId, tx.projectId]).toEqual(["RECEIPT", "IN", "40", po.deliveryLocationId, fx.p1.id]);
    let view = await getPo(fx.roles.pu.actor, po.id);
    expect([view.po.status, view.po.lines[0]!.acceptedQty, view.po.lines[0]!.rejectedQty, view.po.lines[0]!.pendingQty]).toEqual(["PARTIALLY_RECEIVED", "40", "5", "60"]);
    let plan = (await getMrp(fx.roles.pu.actor, { projectId: fx.p1.id })).rows[0]!;
    expect([plan.issuedQty, plan.incoming]).toEqual(["40", "60"]);

    const g2 = await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "60" }] });
    view = await getPo(fx.roles.pu.actor, po.id);
    expect([view.po.status, view.po.lines[0]!.pendingQty]).toEqual(["FULLY_RECEIVED", "0"]);
    plan = (await getMrp(fx.roles.pu.actor, { projectId: fx.p1.id })).rows[0]!;
    expect([plan.issuedQty, plan.incoming]).toEqual(["100", "0"]);
    // Audit trail kept.
    expect(await db.auditLog.count({ where: { entityType: "grn", entityId: g2.id, action: { in: ["grn.created", "grn.posted"] } } })).toBe(2);
    expect((await inventoryIntegrityReport(fx.org.id)).errors).toBe(0);
  });

  it("general-stock POs are received into the main warehouse", async () => {
    const po = await approvedPo("10", null);
    await receiveWithProof(fx.roles.sk.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "10" }] });
    expect(await balanceAt(fx.warehouse.id)).toBe("110");
  });
});

describe("concurrency, duplicates and supplier bills", () => {
  it("two receipts racing for the same PO quantity: only one is posted", async () => {
    const po = await approvedPo("100");
    const one = () => receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "70" }] });
    const r = await Promise.allSettled([one(), one()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await db.poLine.findUniqueOrThrow({ where: { id: po.lines[0]!.id } })).acceptedQty.toString()).toBe("70");
    expect(await balanceAt(po.deliveryLocationId)).toBe("70");
  });

  it("duplicate taps: same receipt returned, confirmed once, posted once", async () => {
    const po = await approvedPo("20");
    const input = { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "20" }] };
    const [x, y] = await Promise.all([createGrn(fx.roles.se.actor, input), createGrn(fx.roles.se.actor, input)]);
    expect(x.id).toBe(y.id);
    await addReceiptProof(fx.roles.se.actor, x.id);
    const ver = await v("grn", x.id);
    const subs = await Promise.allSettled([grnAction(fx.roles.se.actor, x.id, "submit", { version: ver }), grnAction(fx.roles.se.actor, x.id, "submit", { version: ver })]);
    expect(subs.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect((await errorOf(postGrn(fx.roles.sk.actor, x.id, await v("grn", x.id)))).message).toMatch(/already posted/);
    expect(await moves(x.id)).toBe(1);
    expect(await balanceAt(po.deliveryLocationId)).toBe("20");
  });

  it("a supplier bill for received material does not add the stock again", async () => {
    const po = await approvedPo("30");
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "30" }] });
    const before = { txns: await db.stockTransaction.count({ where: { organizationId: fx.org.id } }), site: await balanceAt(po.deliveryLocationId), total: (await db.itemBrand.findUniqueOrThrow({ where: { id: fx.ibUltra.id } })).currentQty.toString() };
    const pre = await billPrefillFromPo(fx.roles.ac.actor, po.id);
    const bill = await createBill(fx.roles.ac.actor, { poId: po.id, supplierInvoiceNo: `INV-${key().slice(0, 6)}`, invoiceDate: day(), lines: pre.lines });
    await billAction(fx.roles.ac.actor, bill.id, "submit", { version: await v("supplierBill", bill.id) });
    expect((await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("APPROVED");
    expect({ txns: await db.stockTransaction.count({ where: { organizationId: fx.org.id } }), site: await balanceAt(po.deliveryLocationId), total: (await db.itemBrand.findUniqueOrThrow({ where: { id: fx.ibUltra.id } })).currentQty.toString() }).toEqual(before);
    expect((await inventoryIntegrityReport(fx.org.id)).errors).toBe(0);
  });

  it("the integrity audit flags a duplicate legacy posting", async () => {
    const po = await approvedPo("10");
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), lines: [{ poLineId: po.lines[0]!.id, receivedQty: "10" }] });
    // Simulate a legacy double entry: the same delivery also typed in as a manual inward.
    const { postMovementTx } = await import("@/modules/inventory/engine");
    await db.$transaction((tx) => postMovementTx(tx, { organizationId: fx.org.id, actorId: fx.users.admin.id, itemBrandId: fx.ibUltra.id, locationId: po.deliveryLocationId, projectId: fx.p1.id, type: "INWARD", direction: "IN", quantity: "10", txnDate: new Date(day()), today: new Date(day()), reference: "typed again", idempotencyKey: key() }));
    const report = await inventoryIntegrityReport(fx.org.id);
    expect(report.errors).toBe(0);
    expect(report.issues.map((i) => i.code)).toContain("manual_after_grn");
  });
});
