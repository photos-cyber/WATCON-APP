import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Prisma, type Tx } from "@/lib/db";
import { nextDocNumber } from "@/lib/doc-numbering";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { cmpQty } from "@/lib/money";
import { can, type Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, toDbDate, uuid } from "@/lib/validations/common";
import { assertProjectUsable, dec3, parseInput, projectScoped, requireAnyPermission, requirePermission, transition } from "@/modules/commercial/core";
import { projectIdField, qtyField } from "@/modules/commercial/pricing";
import type { EntityAccess } from "@/modules/documents/access";
import { ensureSiteLocation, ensureSystemLocations } from "@/modules/inventory/engine";
import { assertAllocations } from "@/modules/planning/allocation";
import { getMrp } from "@/modules/planning/service";
import { startOfToday } from "@/modules/tasks/rules";

/** Purchase requisitions: Draft → Submitted → Approved / Rejected → (Partially) Ordered → Closed. */

const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

const prLineSchema = z.object({ itemBrandId: uuid, quantity: qtyField, requiredBy: optDate, requirementId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)), notes: optionalText("Notes", 300) });
export const prSchema = z.object({
  projectId: projectIdField,
  deliveryLocationId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  requiredBy: optDate,
  purpose: optionalText("Purpose", 1000),
  lines: z.array(prLineSchema).min(1, "Add at least one line.").max(200),
});

const include = {
  project: { select: { id: true, code: true, name: true } },
  deliveryLocation: { select: { id: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
  submittedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  lines: { orderBy: { lineNo: "asc" as const }, include: { itemBrand: { select: { id: true, item: { select: { id: true, code: true, name: true, unit: true } }, brand: { select: { id: true, name: true } } } } } },
  rfqs: { select: { id: true, number: true, status: true } },
  purchaseOrders: { select: { id: true, number: true, status: true, total: true } },
} satisfies Prisma.PurchaseRequisitionInclude;

async function validateLines(tx: Tx, organizationId: string, lines: z.output<typeof prLineSchema>[]) {
  const ids = [...new Set(lines.map((l) => l.itemBrandId))];
  const found = await tx.itemBrand.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, itemId: true, item: { select: { status: true, name: true } }, brand: { select: { status: true } } } });
  const map = new Map(found.map((f) => [f.id, f]));
  lines.forEach((l, i) => {
    const f = map.get(l.itemBrandId);
    if (!f) throw new ValidationError("An item–brand was not found.", { [`lines.${i}.itemBrandId`]: "Not found." });
    if (f.item.status !== "ACTIVE" || f.brand.status !== "ACTIVE") throw new ValidationError(`${f.item.name} is inactive.`, { [`lines.${i}.itemBrandId`]: "Inactive item or brand." });
  });
  return map;
}

async function resolveLocation(tx: Tx, actor: Actor, projectId: string | null, locationId: string | null) {
  if (locationId) {
    const l = await tx.stockLocation.findFirst({ where: { id: locationId, organizationId: actor.organizationId, status: "ACTIVE", type: { in: ["WAREHOUSE", "SITE"] } } });
    if (!l) throw new ValidationError("Choose an active delivery location.", { deliveryLocationId: "Invalid location." });
    return l.id;
  }
  if (projectId) return ensureSiteLocation(tx, actor.organizationId, projectId);
  return (await ensureSystemLocations(tx, actor.organizationId)).WAREHOUSE;
}

export async function createPr(actor: Actor, input: unknown) {
  requirePermission(actor, "pr.create");
  const data = parseInput(prSchema, input);
  const project = data.projectId ? await assertProjectUsable(actor, data.projectId) : null;
  return db.$transaction(async (tx) => {
    const map = await validateLines(tx, actor.organizationId, data.lines);
    const locationId = await resolveLocation(tx, actor, data.projectId, data.deliveryLocationId);
    await assertAllocations(tx, actor.organizationId, { projectId: data.projectId, label: "This requisition" }, data.lines);
    const number = await nextDocNumber(tx, actor.organizationId, "PR", startOfToday());
    const pr = await tx.purchaseRequisition.create({
      data: {
        organizationId: actor.organizationId,
        number,
        projectId: data.projectId,
        deliveryLocationId: locationId,
        requiredBy: toDbDate(data.requiredBy),
        purpose: data.purpose,
        createdById: actor.id,
        lines: { create: data.lines.map((l, i) => ({ lineNo: i + 1, itemBrandId: l.itemBrandId, itemId: map.get(l.itemBrandId)!.itemId, quantity: l.quantity, requiredBy: toDbDate(l.requiredBy), requirementId: l.requirementId, notes: l.notes })) },
      },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "pr.created", entityType: "purchase_requisition", entityId: pr.id, projectId: data.projectId, summary: `Created requisition ${number}${project ? ` for ${project.code}` : ""} (${data.lines.length} lines)` }, tx);
    return pr;
  });
}

export async function updatePr(actor: Actor, id: string, version: number, input: unknown) {
  requirePermission(actor, "pr.create");
  const data = parseInput(prSchema, input);
  const pr = await loadOwnScoped(actor, id);
  if (pr.status !== "DRAFT" && pr.status !== "REJECTED") throw new ValidationError("Only draft or rejected requisitions can be edited.");
  if (data.projectId) await assertProjectUsable(actor, data.projectId);
  return db.$transaction(async (tx) => {
    const map = await validateLines(tx, actor.organizationId, data.lines);
    const locationId = await resolveLocation(tx, actor, data.projectId, data.deliveryLocationId);
    await assertAllocations(tx, actor.organizationId, { projectId: data.projectId, label: "This requisition" }, data.lines, { prId: id });
    await transition(tx.purchaseRequisition, { id, organizationId: actor.organizationId, version }, ["DRAFT", "REJECTED"], { projectId: data.projectId, deliveryLocationId: locationId, requiredBy: toDbDate(data.requiredBy), purpose: data.purpose, status: "DRAFT", statusNote: null }, "requisition");
    await tx.prLine.deleteMany({ where: { prId: id } });
    await tx.prLine.createMany({ data: data.lines.map((l, i) => ({ prId: id, lineNo: i + 1, itemBrandId: l.itemBrandId, itemId: map.get(l.itemBrandId)!.itemId, quantity: l.quantity, requiredBy: toDbDate(l.requiredBy), requirementId: l.requirementId, notes: l.notes })) });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "pr.updated", entityType: "purchase_requisition", entityId: id, projectId: data.projectId, summary: `Edited requisition ${pr.number}` }, tx);
  });
}

async function loadOwnScoped(actor: Actor, id: string) {
  const pr = await db.purchaseRequisition.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput] } });
  if (!pr) throw new NotFoundError("Requisition");
  return pr;
}

export type PrAction = "submit" | "approve" | "reject" | "cancel" | "close";

export async function prAction(actor: Actor, id: string, action: PrAction, opts: { version: number; note?: string | null }) {
  const pr = await loadOwnScoped(actor, id);
  const audit = (tx: Tx, verb: string) => writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `pr.${action}`, entityType: "purchase_requisition", entityId: id, projectId: pr.projectId, summary: `${verb} requisition ${pr.number}${opts.note ? ` – ${opts.note}` : ""}` }, tx);
  const w = { id, organizationId: actor.organizationId, version: opts.version };
  if (action === "submit") {
    // Simplified workflow: a finalized requisition is approved straight away (requisitions are optional).
    requireAnyPermission(actor, ["pr.create", "pr.approve"]);
    return db.$transaction(async (tx) => {
      const now = new Date();
      await transition(tx.purchaseRequisition, w, ["DRAFT", "REJECTED"], { status: "APPROVED", submittedById: actor.id, submittedAt: now, approvedById: actor.id, approvedAt: now, statusNote: null }, "requisition");
      await audit(tx, "Finalized");
    });
  }
  if (action === "approve" || action === "reject") {
    requireAnyPermission(actor, ["pr.create", "pr.approve"]);
    if (action === "reject" && !opts.note) throw new ValidationError("Give a reason for rejecting.", { note: "Reason is required." });
    return db.$transaction(async (tx) => {
      await transition(tx.purchaseRequisition, w, ["SUBMITTED"], action === "approve" ? { status: "APPROVED", approvedById: actor.id, approvedAt: new Date() } : { status: "REJECTED", statusNote: opts.note }, "requisition");
      await audit(tx, action === "approve" ? "Approved" : "Rejected");
    });
  }
  if (action === "cancel") {
    if (!can(actor, "pr.approve") && !(can(actor, "pr.create") && pr.createdById === actor.id)) throw new ForbiddenError();
    if (!opts.note) throw new ValidationError("Give a reason for cancelling.", { note: "Reason is required." });
    const ordered = await db.prLine.count({ where: { prId: id, orderedQty: { gt: 0 } } });
    if (ordered) throw new ValidationError("Purchase orders were already raised from this requisition. Close it instead.");
    return db.$transaction(async (tx) => {
      await transition(tx.purchaseRequisition, w, ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"], { status: "CANCELLED", statusNote: opts.note }, "requisition");
      await audit(tx, "Cancelled");
    });
  }
  requirePermission(actor, "pr.approve");
  return db.$transaction(async (tx) => {
    await transition(tx.purchaseRequisition, w, ["APPROVED", "PARTIALLY_ORDERED"], { status: "CLOSED", statusNote: opts.note ?? "Closed" }, "requisition");
    await audit(tx, "Closed");
  });
}

/** Recomputes PR status from line ordered quantities (called when POs referencing it change). */
export async function refreshPrOrderStatus(tx: Tx, prId: string) {
  const pr = await tx.purchaseRequisition.findUnique({ where: { id: prId }, include: { lines: true } });
  if (!pr || !["APPROVED", "PARTIALLY_ORDERED", "ORDERED"].includes(pr.status)) return;
  const any = pr.lines.some((l) => cmpQty(dec3(l.orderedQty), "0") > 0);
  const all = pr.lines.every((l) => cmpQty(dec3(l.orderedQty), dec3(l.quantity)) >= 0);
  const status = all ? "ORDERED" : any ? "PARTIALLY_ORDERED" : "APPROVED";
  if (status !== pr.status) await tx.purchaseRequisition.update({ where: { id: prId }, data: { status, version: { increment: 1 } } });
}

/**
 * Bulk "Create purchase requisition" from MRP. Quantities are RE-COMPUTED on the server
 * (to-order = shortage not covered by stock, open POs or open requisitions), so a stale
 * screen or a double click cannot order twice.
 */
export async function createPrFromMrp(actor: Actor, input: unknown) {
  requirePermission(actor, "pr.create");
  const data = parseInput(z.object({ projectId: uuid, requirementIds: z.array(uuid).min(1).max(200), purpose: optionalText("Purpose", 500) }), input);
  const mrp = await getMrp(actor, { projectId: data.projectId, view: "open" });
  const chosen = mrp.rows.filter((r) => !!r.requirementId && data.requirementIds.includes(r.requirementId) && cmpQty(r.toOrder, "0") > 0);
  if (!chosen.length) throw new ValidationError("Nothing to order: the selected lines are already covered by stock, open orders or open requisitions.");
  return createPr(actor, {
    projectId: data.projectId,
    purpose: data.purpose ?? "Shortage from material planning",
    lines: chosen.map((r) => ({ itemBrandId: r.itemBrandId, quantity: r.toOrder, requiredBy: r.requiredBy ? r.requiredBy.slice(0, 10) : null, requirementId: r.requirementId })),
  });
}

export async function getPr(actor: Actor, id: string) {
  requirePermission(actor, "pr.view");
  const pr = await db.purchaseRequisition.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput] }, include });
  if (!pr) throw new NotFoundError("Requisition");
  return {
    pr: { ...pr, lines: pr.lines.map((l) => ({ ...l, quantity: dec3(l.quantity), orderedQty: dec3(l.orderedQty) })) },
    can: {
      edit: can(actor, "pr.create") && (pr.status === "DRAFT" || pr.status === "REJECTED"),
      submit: can(actor, "pr.create") && (pr.status === "DRAFT" || pr.status === "REJECTED"),
      approve: pr.status === "SUBMITTED" && (can(actor, "pr.create") || can(actor, "pr.approve")),
      approveBlockedReason: null as string | null,
      cancel: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"].includes(pr.status) && (can(actor, "pr.approve") || pr.createdById === actor.id),
      close: ["APPROVED", "PARTIALLY_ORDERED"].includes(pr.status) && can(actor, "pr.approve"),
      rfq: ["APPROVED", "PARTIALLY_ORDERED"].includes(pr.status) && can(actor, "rfq.manage"),
      po: ["APPROVED", "PARTIALLY_ORDERED"].includes(pr.status) && can(actor, "po.create"),
    },
  };
}

export const prListQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.string().max(30).optional().catch(undefined),
  projectId: uuid.optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).catch(20).default(20),
});

export async function listPrs(actor: Actor, raw: unknown) {
  requirePermission(actor, "pr.view");
  const q = prListQuerySchema.parse(raw ?? {});
  const where: Prisma.PurchaseRequisitionWhereInput = {
    AND: [
      projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput,
      q.status ? { status: q.status as Prisma.EnumPrStatusFilter["equals"] } : {},
      q.projectId ? { projectId: q.projectId } : {},
      q.q ? { OR: [{ number: { contains: q.q, mode: "insensitive" } }, { purpose: { contains: q.q, mode: "insensitive" } }, { lines: { some: { itemBrand: { item: { name: { contains: q.q, mode: "insensitive" } } } } } }] } : {},
    ],
  };
  const [total, rows, byStatus] = await Promise.all([
    db.purchaseRequisition.count({ where }),
    db.purchaseRequisition.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { project: { select: { id: true, code: true } }, createdBy: { select: { fullName: true } }, _count: { select: { lines: true } } } }),
    db.purchaseRequisition.groupBy({ by: ["status"], where: { AND: [projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput, q.projectId ? { projectId: q.projectId } : {}] }, _count: true }),
  ]);
  return { total, page: q.page, pageSize: q.pageSize, query: q, rows, byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])) as Record<string, number> };
}

export async function prAccess(actor: Actor, id: string): Promise<EntityAccess | null> {
  if (!can(actor, "pr.view")) return null;
  const pr = await db.purchaseRequisition.findFirst({ where: { AND: [{ id }, projectScoped(actor) as Prisma.PurchaseRequisitionWhereInput] }, select: { number: true, projectId: true, status: true } });
  if (!pr) return null;
  return { projectId: pr.projectId, label: pr.number, canView: true, canUpload: can(actor, "pr.create") || can(actor, "pr.approve"), locked: !["DRAFT", "REJECTED"].includes(pr.status) };
}
