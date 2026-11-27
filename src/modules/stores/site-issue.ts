import "server-only";
import { z } from "zod";
import { db, type Tx } from "@/lib/db";
import { ValidationError, isUniqueViolation } from "@/lib/errors";
import { fmtQty, qtyUnits } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { optionalText, uuid } from "@/lib/validations/common";
import { assertProjectUsable, assertProjectVisible, parseInput, requirePermission } from "@/modules/commercial/core";
import { qtyField } from "@/modules/commercial/pricing";
import { ensureSiteLocation, ensureSystemLocations } from "@/modules/inventory/engine";
import { getMrp } from "@/modules/planning/service";
import { startOfToday } from "@/modules/tasks/rules";
import { challanSchema, createChallanTx, dispatchChallanTx } from "./challan";

/**
 * "Issue material to site" from inside a project (workflow v2 · Phase 5). Lists the project's
 * sales-order material requirements with what was already issued, what remains and what the chosen
 * warehouse can give (its stock minus reservations of other projects), then creates an
 * ISSUE_TO_SITE challan: saved as a draft (no stock moves) or issued at once
 * (warehouse → in transit, in the same transaction). The site then receives it with proof.
 */

export type SiteIssueRow = {
  requirementId: string;
  itemBrandId: string;
  item: { id: string; code: string; name: string; unit: string; image: string | null };
  brand: string;
  salesOrder: { id: string; number: string } | null;
  /** Confirmed orders of the project carrying this material — a choice is offered when there are several. */
  orders: { soLineId: string; number: string; quantity: string }[];
  required: string;
  issued: string;
  inTransit: string;
  remaining: string;
  atWarehouse: string;
  reservedForProject: string;
  available: string;
  suggested: string;
};

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max0 = (a: bigint) => (a < BigInt(0) ? BigInt(0) : a);

export async function siteIssueData(actor: Actor, projectId: string, fromLocationId?: string | null) {
  requirePermission(actor, "stock.transfer");
  const project = await assertProjectVisible(actor, projectId);
  const warehouses = await db.stockLocation.findMany({ where: { organizationId: actor.organizationId, type: "WAREHOUSE", status: "ACTIVE" }, orderBy: [{ isSystem: "desc" }, { name: "asc" }], select: { id: true, name: true, code: true } });
  const from = warehouses.find((w) => w.id === fromLocationId) ?? warehouses.find((w) => w.code === "WH-MAIN") ?? warehouses[0] ?? null;
  const plan = await getMrp(actor, { projectId, view: "open" });
  const ibIds = plan.rows.map((r) => r.itemBrandId);
  const [balances, reservations] = from && ibIds.length
    ? await Promise.all([
        db.stockBalance.findMany({ where: { locationId: from.id, itemBrandId: { in: ibIds } }, select: { itemBrandId: true, onHand: true } }),
        db.stockReservation.findMany({ where: { locationId: from.id, itemBrandId: { in: ibIds }, status: "ACTIVE" }, select: { itemBrandId: true, projectId: true, quantity: true, issuedQty: true } }),
      ])
    : [[], []];
  const orderLines = await projectOrderLines(db, projectId, ibIds);
  const onHand = new Map(balances.map((b) => [b.itemBrandId, qtyUnits(b.onHand.toString())]));
  const resOwn = new Map<string, bigint>();
  const resOther = new Map<string, bigint>();
  for (const r of reservations) {
    const left = qtyUnits(r.quantity.toString()) - qtyUnits(r.issuedQty.toString());
    const m = r.projectId === projectId ? resOwn : resOther;
    m.set(r.itemBrandId, (m.get(r.itemBrandId) ?? BigInt(0)) + left);
  }
  const rows: SiteIssueRow[] = plan.rows.map((r) => {
    const remaining = max0(qtyUnits(r.requiredQty) - qtyUnits(r.issuedQty));
    const here = onHand.get(r.itemBrandId) ?? BigInt(0);
    const available = max0(here - (resOther.get(r.itemBrandId) ?? BigInt(0)));
    return {
      requirementId: r.requirementId!,
      itemBrandId: r.itemBrandId,
      item: r.item,
      brand: r.brand.name,
      salesOrder: r.salesOrder,
      orders: orderLines.filter((o) => o.itemBrandId === r.itemBrandId).map((o) => ({ soLineId: o.id, number: o.so.number, quantity: fmtQty(qtyUnits(o.quantity.toString())) })),
      required: r.requiredQty,
      issued: r.issuedQty,
      inTransit: r.inTransit,
      remaining: fmtQty(remaining),
      atWarehouse: fmtQty(here),
      reservedForProject: fmtQty(resOwn.get(r.itemBrandId) ?? BigInt(0)),
      available: fmtQty(available),
      suggested: fmtQty(min(remaining, available)),
    };
  });
  return { project, warehouses, fromLocationId: from?.id ?? null, rows };
}

export const siteIssueSchema = z.object({
  projectId: uuid,
  fromLocationId: uuid,
  clientKey: z.string().uuid(),
  /** true = issue now (stock leaves the warehouse into transit); false = save a draft challan. */
  issueNow: z.boolean().default(true),
  vehicleNo: optionalText("Vehicle no.", 30),
  driverName: optionalText("Driver", 120),
  driverPhone: optionalText("Driver phone", 20),
  remarks: optionalText("Remarks", 1000),
  /**
   * soLineId (optional): the sales-order line this material is issued for, so billing never mixes orders.
   * Omitted: linked automatically when only one confirmed order of the project carries the material;
   * otherwise left unlinked and shared oldest-order-first when billing.
   */
  lines: z.array(z.object({ itemBrandId: uuid, requirementId: uuid.optional().nullable(), soLineId: uuid.optional().nullable(), quantity: qtyField })).min(1, "Select at least one item to issue.").max(200),
});

const CONFIRMED_SO = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED"] as const;

/** Confirmed sales-order material lines of a project, per item–brand (oldest order first). */
async function projectOrderLines(client: Tx | typeof db, projectId: string, itemBrandIds: string[]) {
  if (!itemBrandIds.length) return [];
  return client.soLine.findMany({ where: { kind: "MATERIAL", itemBrandId: { in: itemBrandIds }, so: { projectId, status: { in: [...CONFIRMED_SO] } } }, orderBy: [{ so: { createdAt: "asc" } }, { lineNo: "asc" }], select: { id: true, itemBrandId: true, quantity: true, so: { select: { id: true, number: true } } } });
}

/** Sales-order line of each issued line: the chosen one (validated), else the project's only order line for that material. */
async function resolveSoLines(tx: Tx, projectId: string, lines: z.output<typeof siteIssueSchema>["lines"]) {
  const candidates = await projectOrderLines(tx, projectId, lines.map((l) => l.itemBrandId));
  return lines.map((l, i) => {
    const own = candidates.filter((c) => c.itemBrandId === l.itemBrandId);
    if (l.soLineId) {
      if (!own.some((c) => c.id === l.soLineId)) throw new ValidationError("The chosen sales order does not carry this material in this project.", { [`lines.${i}.soLineId`]: "Mismatch." });
      return l.soLineId;
    }
    return own.length === 1 ? own[0]!.id : null;
  });
}

/** Creates (and optionally issues) a site challan. Repeating the same clientKey returns the same challan. */
export async function issueMaterialToSite(actor: Actor, input: unknown) {
  requirePermission(actor, "stock.transfer");
  const data = parseInput(siteIssueSchema, input);
  await assertProjectUsable(actor, data.projectId);
  const seen = new Set<string>();
  data.lines.forEach((l, i) => {
    const key = l.requirementId ?? l.itemBrandId;
    if (seen.has(key)) throw new ValidationError("The same item is selected twice. Combine the quantities on one line.", { [`lines.${i}.itemBrandId`]: "Duplicate." });
    seen.add(key);
  });
  const existing = await db.challan.findUnique({ where: { organizationId_clientKey: { organizationId: actor.organizationId, clientKey: data.clientKey } }, select: { id: true, number: true, status: true } });
  if (existing) return { ...existing, duplicate: true };
  try {
    return await db.$transaction(
      async (tx) => {
        await ensureSystemLocations(tx, actor.organizationId);
        const toLocationId = await ensureSiteLocation(tx, actor.organizationId, data.projectId);
        const d = parseInput(challanSchema, { type: "ISSUE_TO_SITE", projectId: data.projectId, fromLocationId: data.fromLocationId, toLocationId, dispatchDate: startOfToday().toISOString().slice(0, 10), vehicleNo: data.vehicleNo, driverName: data.driverName, driverPhone: data.driverPhone, remarks: data.remarks, lines: data.lines.map((l) => ({ itemBrandId: l.itemBrandId, quantity: l.quantity })) });
        const soLineIds = await resolveSoLines(tx, data.projectId, data.lines);
        d.lines.forEach((l, i) => (l.soLineId = soLineIds[i]));
        const c = await createChallanTx(tx, actor, d, { clientKey: data.clientKey });
        if (data.issueNow) {
          const full = await tx.challan.findUniqueOrThrow({ where: { id: c.id }, include: { lines: true } });
          await dispatchChallanTx(tx, actor, full, full.version);
        }
        const after = await tx.challan.findUniqueOrThrow({ where: { id: c.id }, select: { id: true, number: true, status: true } });
        return { ...after, duplicate: false };
      },
      { timeout: 20000 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await db.challan.findUnique({ where: { organizationId_clientKey: { organizationId: actor.organizationId, clientKey: data.clientKey } }, select: { id: true, number: true, status: true } });
      if (again) return { ...again, duplicate: true };
    }
    throw e;
  }
}
