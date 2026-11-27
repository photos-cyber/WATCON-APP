import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { requestChange } from "@/modules/commercial/change-request";
import { createPo, poAction } from "@/modules/procurement/po";
import { uploadAttachment } from "@/modules/documents/attachments";
import { createSalesOrder, getSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { challanAction, createChallan, getChallan } from "@/modules/stores/challan";
import { PDF, commercialFixture, day, errorOf, type CFx } from "./commercial-helpers";

/**
 * Simplified workflow (2026-11-27): daily documents are finalized in one step by their own users;
 * only changes to finalized documents are reserved for the Super Admin ("Request change" for others).
 */
let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

const ver = async (model: "salesOrder" | "purchaseOrder", id: string) => ((await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version);

describe("one-step finalize", () => {
  it("the project manager confirms their own sales order at once and planning starts from it", async () => {
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "25", rate: "450", gstRate: "28" }] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await ver("salesOrder", so.id) });
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: so.id } });
    expect([row.status, row.approvedById, row.submittedById]).toEqual(["APPROVED", fx.roles.pm.user.id, fx.roles.pm.user.id]);
    const req = await db.materialRequirement.findFirstOrThrow({ where: { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id } });
    expect(req.requiredQty.toFixed(0)).toBe("25");
    // Locked: only the Super Admin closes / cancels; the PM raises an amendment request instead.
    const view = await getSalesOrder(fx.roles.pm.actor, so.id);
    expect(view.can).toMatchObject({ edit: false, requestAmendment: true, close: false, cancel: false });
    expect((await errorOf(salesOrderAction(fx.roles.pm.actor, so.id, "close", { version: row.version, note: "done" }))).message).toMatch(/Only the Super Admin/);
  });
});

describe("client delivery needs proof", () => {
  it("a client-delivery challan is confirmed only after the signed challan / POD is uploaded", async () => {
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "6", rate: "450", gstRate: "28" }] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await ver("salesOrder", so.id) });
    const line = await db.soLine.findFirstOrThrow({ where: { soId: so.id } });
    const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: fx.client.id, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "6", soLineId: line.id }] });
    const cv = async () => (await db.challan.findUniqueOrThrow({ where: { id: c.id } })).version;
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: await cv() });
    expect((await getChallan(fx.roles.sk.actor, c.id)).can.deliver).toBe(false);
    expect((await errorOf(challanAction(fx.roles.sk.actor, c.id, "deliver", { version: await cv(), receiverName: "Site in-charge" }))).message).toMatch(/proof of delivery/);
    await uploadAttachment(fx.roles.sk.actor, { entityType: "challan", entityId: c.id, category: "SIGNED_CHALLAN", fileName: "pod.pdf", bytes: PDF });
    expect((await getChallan(fx.roles.sk.actor, c.id)).can.deliver).toBe(true);
    await challanAction(fx.roles.sk.actor, c.id, "deliver", { version: await cv(), receiverName: "Site in-charge" });
    expect((await db.challan.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("DELIVERED");
  });
});

describe("Request change on a finalized document", () => {
  it("notifies every active Super Admin and is audited on the document; nothing about the document changes", async () => {
    const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "5", rate: "400", gstRate: "28" }] });
    await poAction(fx.roles.pu.actor, po.id, "finalize", { version: await ver("purchaseOrder", po.id) });
    const before = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });

    expect((await errorOf(requestChange(fx.roles.pu.actor, { kind: "purchase_order", id: po.id, reason: "no" }))).message).toMatch(/correct/i);
    const res = await requestChange(fx.roles.pu.actor, { kind: "purchase_order", id: po.id, change: "CANCEL", reason: "Supplier cannot deliver this brand" });
    const admins = await db.user.count({ where: { organizationId: fx.org.id, role: { key: "SUPER_ADMIN" }, status: "ACTIVE" } });
    expect(res.notified).toBe(admins);
    const notes = await db.notification.findMany({ where: { type: "change_request", link: `/purchase-orders/${po.id}` } });
    expect(notes).toHaveLength(admins);
    expect(notes[0]!.title).toMatch(/Cancel requested: Purchase order/);
    expect(await db.auditLog.count({ where: { entityType: "purchase_order", entityId: po.id, action: "change.requested" } })).toBe(1);
    const after = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect([after.status, after.version]).toEqual([before.status, before.version]);

    // Outsiders cannot even see the document; the Super Admin makes changes directly instead.
    expect((await errorOf(requestChange(fx.roles.outsider.actor, { kind: "purchase_order", id: po.id, reason: "Please cancel it" }))).message).toMatch(/not found|permission/i);
    expect((await errorOf(requestChange(fx.actors.superAdmin, { kind: "purchase_order", id: po.id, reason: "Please cancel it" }))).message).toMatch(/directly/);
  });
});
