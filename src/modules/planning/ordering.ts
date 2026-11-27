import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Tx } from "@/lib/db";
import { ConflictError, ValidationError, isUniqueViolation } from "@/lib/errors";
import { addQty, cmpQty, maxQty } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { dateString, optionalText, uuid } from "@/lib/validations/common";
import { assertProjectUsable, parseInput, requirePermission } from "@/modules/commercial/core";
import { qtyField, rateField } from "@/modules/commercial/pricing";
import { createPo } from "@/modules/procurement/po";
import { createRfq } from "@/modules/procurement/rfq";
import { startOfToday } from "@/modules/tasks/rules";
import { allocatedByRequirement } from "./allocation";
import { getMrp, type MrpRow } from "./service";

/**
 * Direct ordering from material planning: one purchase order or rate enquiry for any mix of
 * project requirements and general-inventory lines. Each document line keeps its own requirement
 * link (line-level allocation). Quantities are re-checked on the server against the current plan —
 * a project line can never exceed what still needs ordering, and `assertAllocations` (inside
 * createPo / createRfq, rows locked) is the final guard against double ordering.
 *
 * Document project: the single project when every line is for that project; otherwise none
 * (a combined / general-stock document delivered to the main warehouse).
 */

const optId = uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null));
const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));

const planLine = z.object({
  /** Requirement id, or empty for a general-stock line that has no requirement yet. */
  requirementId: optId,
  itemBrandId: uuid,
  quantity: qtyField,
  rate: z.union([rateField, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null)),
});

export const planPoSchema = z.object({
  partyId: uuid,
  expectedDate: optDate,
  lines: z.array(planLine).min(1, "Select at least one line.").max(200),
});

export const planRfqSchema = z.object({
  supplierIds: z.array(uuid).min(1, "Invite at least one supplier."),
  title: optionalText("Title", 200),
  responseDue: optDate,
  lines: z.array(planLine).min(1, "Select at least one line.").max(200),
});

type PlanLine = z.output<typeof planLine>;
type Prepared = { line: PlanLine; row: MrpRow };

/** Matches each requested line to the current plan the actor can see, and checks quantities. */
async function prepare(actor: Actor, lines: PlanLine[]): Promise<{ items: Prepared[]; projectId: string | null; label: string }> {
  const plan = await getMrp(actor, { scope: "all", view: "open" });
  const byReq = new Map(plan.rows.filter((r) => r.requirementId).map((r) => [r.requirementId!, r]));
  const generalByIb = new Map(plan.rows.filter((r) => r.scope === "GENERAL").map((r) => [r.itemBrandId, r]));
  const seen = new Set<string>();
  const items = lines.map((line, i) => {
    const row = line.requirementId ? byReq.get(line.requirementId) : generalByIb.get(line.itemBrandId);
    if (!row || row.itemBrandId !== line.itemBrandId) throw new ValidationError(`Line ${i + 1} is no longer in material planning (or not visible to you). Reload the page.`, { [`lines.${i}.requirementId`]: "Not found." });
    if (seen.has(row.rowKey)) throw new ValidationError(`${row.item.name} is selected twice. Combine the quantities on one line.`, { [`lines.${i}.quantity`]: "Duplicate line." });
    seen.add(row.rowKey);
    if (row.scope === "PROJECT" && row.maxOrderQty !== null && cmpQty(line.quantity, row.maxOrderQty) > 0) {
      throw new ValidationError(`${row.item.name} (${row.project!.code}): only ${row.maxOrderQty} ${row.item.unit} still needs ordering — the rest is in stock reserved, on orders, requisitions or enquiries.`, { [`lines.${i}.quantity`]: `Maximum ${row.maxOrderQty}.` });
    }
    return { line, row };
  });
  const projects = [...new Set(items.map((x) => x.row.project?.id ?? null))];
  for (const p of projects) if (p) await assertProjectUsable(actor, p);
  const single = projects.length === 1 && projects[0] !== null ? projects[0] : null;
  const codes = [...new Set(items.map((x) => x.row.project?.code ?? "General stock"))];
  return { items, projectId: single, label: codes.join(", ") };
}

/**
 * General-stock lines are allocated to the item–brand's OPEN general requirement (created when
 * missing). Its quantity is raised to cover what is being ordered now, so manual quantities and
 * reorder suggestions are recorded and never ordered twice.
 */
async function ensureGeneralRequirements(tx: Tx, actor: Actor, items: Prepared[]) {
  for (const it of items) {
    if (it.row.scope !== "GENERAL") continue;
    const [existing] = await tx.$queryRaw<{ id: string; required_qty: string }[]>`
      SELECT id::text, required_qty::text FROM material_requirements
      WHERE organization_id = ${actor.organizationId}::uuid AND item_brand_id = ${it.row.itemBrandId}::uuid AND project_id IS NULL AND status = 'OPEN'
      FOR UPDATE`;
    if (existing) {
      const used = (await allocatedByRequirement(tx, [existing.id])).get(existing.id) ?? "0";
      const need = maxQty(existing.required_qty, addQty(used, it.line.quantity));
      if (cmpQty(need, existing.required_qty) !== 0) await tx.materialRequirement.update({ where: { id: existing.id }, data: { requiredQty: need, version: { increment: 1 } } });
      it.line.requirementId = existing.id;
    } else {
      const ib = await tx.itemBrand.findUniqueOrThrow({ where: { id: it.row.itemBrandId }, select: { itemId: true } });
      const req = await tx.materialRequirement.create({ data: { organizationId: actor.organizationId, projectId: null, itemBrandId: it.row.itemBrandId, itemId: ib.itemId, requiredQty: it.line.quantity, notes: "General stock (from material planning)", createdById: actor.id } });
      await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "requirement.created", entityType: "material_requirement", entityId: req.id, projectId: null, summary: `General-stock requirement ${it.line.quantity} ${it.row.item.unit} ${it.row.item.name} (${it.row.brand.name}) from planning` }, tx);
      it.line.requirementId = req.id;
    }
  }
}

const earliest = (items: Prepared[]) => items.map((x) => x.row.requiredBy).filter(Boolean).sort()[0]?.slice(0, 10) ?? null;
/** Carried onto the RFQ / PO line so suppliers and stores see what each line is for. */
const lineNote = (row: MrpRow) => [...new Set([row.project ? `For ${row.project.code}` : "General stock", row.salesOrder ? `SO ${row.salesOrder.number}` : null, row.notes && row.scope === "GENERAL" ? row.notes.trim() : null].filter(Boolean))].join(" · ").slice(0, 300);

export async function createPoFromPlanning(actor: Actor, input: unknown) {
  requirePermission(actor, "po.create");
  const data = parseInput(planPoSchema, input);
  const { items, projectId, label } = await prepare(actor, data.lines);
  items.forEach(({ line, row }, i) => {
    if (!line.rate && !row.lastPurchaseRate) throw new ValidationError(`Enter the rate for ${row.item.name}.`, { [`lines.${i}.rate`]: "Rate needed." });
  });
  try {
    return await db.$transaction(
      async (tx) => {
        await ensureGeneralRequirements(tx, actor, items);
        const po = await createPo(
          actor,
          {
            projectId,
            partyId: data.partyId,
            orderDate: startOfToday().toISOString().slice(0, 10),
            expectedDate: data.expectedDate ?? earliest(items),
            internalRemarks: `From material planning: ${label}`,
            lines: items.map(({ line, row }) => ({ itemBrandId: row.itemBrandId, quantity: line.quantity, rate: line.rate ?? row.lastPurchaseRate!, discountPct: "0", gstRate: row.gstRate ?? "18", requirementId: line.requirementId, description: projectId ? null : lineNote(row) })),
          },
          tx,
        );
        return { id: po.id, number: po.number };
      },
      { timeout: 20000 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Someone else just ordered the same general-stock item. Reload and try again.");
    throw e;
  }
}

export async function createRfqFromPlanning(actor: Actor, input: unknown) {
  requirePermission(actor, "rfq.manage");
  const data = parseInput(planRfqSchema, input);
  const { items, projectId, label } = await prepare(actor, data.lines);
  const siteAddress = projectId ? ((await assertProjectUsable(actor, projectId)).siteAddress ?? null) : null;
  try {
    return await db.$transaction(
      async (tx) => {
        await ensureGeneralRequirements(tx, actor, items);
        const rfq = await createRfq(
          actor,
          {
            projectId,
            title: data.title ?? `Materials for ${label}`.slice(0, 200),
            requiredBy: earliest(items),
            responseDue: data.responseDue,
            supplierIds: data.supplierIds,
            lines: items.map(({ line, row }) => ({ itemId: row.item.id, itemBrandId: row.itemBrandId, quantity: line.quantity, specifications: lineNote(row), requirementId: line.requirementId })),
            deliveryAddress: siteAddress,
          },
          tx,
        );
        return { id: rfq.id, number: rfq.number };
      },
      { timeout: 20000 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Someone else just requested the same general-stock item. Reload and try again.");
    throw e;
  }
}
