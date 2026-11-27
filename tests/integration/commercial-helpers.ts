import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/permissions/definitions";
import { createBrand, createItem, linkBrand } from "@/modules/inventory/service";
import { createParty } from "@/modules/parties/service";
import { startOfToday } from "@/modules/tasks/rules";
import { actorFor, createUser, standardFixture } from "./helpers";

export const day = (offset = 0) => {
  const d = startOfToday();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

export async function errorOf(p: Promise<unknown>): Promise<Error & { code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string };
  }
  throw new Error("Expected rejection");
}

let n = 0;
export async function makeProject(organizationId: string, managerId: string, memberIds: string[] = []) {
  n++;
  return db.project.create({
    data: {
      organizationId,
      code: `PRJ-${String(9000 + n)}`,
      name: `Site ${n}`,
      siteAddress: `Plot ${n}`,
      description: "Test project",
      managerId,
      createdById: managerId,
      status: "ACTIVE",
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });
}

/**
 * Commercial fixture on top of the standard one: role-based users, two projects, a cement item
 * with two brands (opening stock in the warehouse), a supplier and a client.
 */
export async function commercialFixture() {
  const fx = await standardFixture();
  const org = fx.org;
  const mk = async (role: Parameters<typeof createUser>[1], name: string) => {
    const u = await createUser(org.id, role, { fullName: name });
    return { user: u, actor: await actorFor(u.id) };
  };
  const pm = await mk("PROJECT_MANAGER", "Priya PM");
  const se = await mk("SITE_ENGINEER", "Sunil Site");
  const pu = await mk("PURCHASE", "Pooja Purchase");
  const sk = await mk("STOREKEEPER", "Kiran Store");
  const ac = await mk("ACCOUNTS", "Anil Accounts");
  const vw = await mk("VIEWER", "Vikram Viewer");
  const outsider = await mk("SITE_ENGINEER", "Olga Outsider");

  const p1 = await makeProject(org.id, pm.user.id, [se.user.id, pu.user.id, sk.user.id, fx.users.admin.id]);
  const p2 = await makeProject(org.id, pm.user.id, [fx.users.admin.id]);

  const admin = fx.actors.admin;
  const item = await createItem(admin, { name: "OPC Cement 53", category: "Cement", unit: "Bag" });
  const ultra = await createBrand(admin, { name: "UltraTech" });
  const acc = await createBrand(admin, { name: "ACC" });
  const ibUltra = await linkBrand(fx.actors.superAdmin, { itemId: item.id, brandId: ultra.id, openingQty: "100", openingDate: day(-10) });
  const ibAcc = await linkBrand(fx.actors.superAdmin, { itemId: item.id, brandId: acc.id, openingQty: "40", openingDate: day(-10) });
  const supplier = await createParty(admin, { name: "Shree Cement Traders", isSupplier: true, gstin: "27AAPFU0939F1ZV", paymentTermsDays: 30 });
  const supplier2 = await createParty(admin, { name: "Balaji Building Supplies", isSupplier: true, stateCode: "29" });
  const client = await createParty(admin, { name: "Acme Developers", isClient: true, stateCode: "27", paymentTermsDays: 45 });
  const warehouse = await db.stockLocation.findFirstOrThrow({ where: { organizationId: org.id, code: "WH-MAIN" } });
  const transit = await db.stockLocation.findFirstOrThrow({ where: { organizationId: org.id, code: "TRANSIT" } });
  await db.orgSettings.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, stateCode: "27", gstin: "27AAPFU0939F1ZV" }, update: {} });

  return { ...fx, roles: { pm, se, pu, sk, ac, vw, outsider }, p1, p2, item, ultra, acc, ibUltra, ibAcc, supplier, supplier2, client, warehouse, transit };
}

export const key = () => randomUUID();
export type CFx = Awaited<ReturnType<typeof commercialFixture>>;
export type A = Actor;

// ─────────────── Receiving proof (workflow v2 · Phase 4) ───────────────

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
export const PDF = new TextEncoder().encode("%PDF-1.4\n delivery challan fixture");

/** Uploads the mandatory receipt proof: material photo + (signed / supplier) challan (+ damage photo). */
export async function addReceiptProof(actor: Actor, grnId: string, opts: { damage?: boolean; photo?: boolean; challan?: boolean } = {}) {
  const { uploadAttachment } = await import("@/modules/documents/attachments");
  if (opts.photo !== false) await uploadAttachment(actor, { entityType: "grn", entityId: grnId, category: "MATERIAL_PHOTO", fileName: "material.png", bytes: PNG });
  if (opts.challan !== false) await uploadAttachment(actor, { entityType: "grn", entityId: grnId, category: "DELIVERY_CHALLAN", fileName: "challan.pdf", bytes: PDF });
  if (opts.damage) await uploadAttachment(actor, { entityType: "grn", entityId: grnId, category: "DAMAGE_PHOTO", fileName: "damage.png", bytes: PNG });
}

/** Records a receipt (supplier PO or site challan) the v2 way: draft → proof → submit. Returns { id, number }. */
export async function receiveWithProof(actor: Actor, input: { clientKey: string; poId?: string; challanId?: string; receiptDate: string; lines: { poLineId?: string; challanLineId?: string; receivedQty: string; damagedQty?: string; rejectedQty?: string }[]; [k: string]: unknown }) {
  const { createGrn, grnAction } = await import("@/modules/stores/grn");
  const g = await createGrn(actor, { ...input, submit: false });
  const damage = input.lines.some((l) => Number(l.damagedQty ?? 0) > 0 || Number(l.rejectedQty ?? 0) > 0);
  await addReceiptProof(actor, g.id, { damage });
  const { version } = await db.grn.findUniqueOrThrow({ where: { id: g.id }, select: { version: true } });
  await grnAction(actor, g.id, "submit", { version });
  return g;
}
