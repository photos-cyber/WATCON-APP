/**
 * Material Requirement Planning maths — pure and unit-tested. All inputs are decimal strings
 * computed by the database; nothing here trusts client-side numbers.
 *
 * Definitions (per project × item–brand):
 *   siteStock        on hand at the project's site store
 *   inTransit        dispatched to the site on challans, not yet received
 *   consumed         consumed / installed at the site, or delivered to the client (net of reversals)
 *   fulfilled        siteStock + inTransit + consumed
 *   remainingNeed    max(0, required − fulfilled)
 *   projectReserved  open reservations for this project (in stores)
 *   incoming         open quantity on approved POs for this project (ordered − accepted)
 *   poPipeline       quantity on draft / pending-approval POs for this project
 *   openPr           requisitioned but not yet ordered for this project
 *   openRfq          on open rate enquiries raised directly from planning (no PO yet)
 *   shortage         max(0, remainingNeed − projectReserved − incoming)        (not covered by stock or approved orders)
 *   freeStock (ATP)  usable company stock not reserved for anyone (warehouses + sites, excl. transit / quarantine)
 *   orderable        max(0, shortage − poPipeline − openPr − openRfq)           (not yet on any order / request)
 *   toOrder          max(0, orderable − freeStock)                              (avoids double ordering)
 *   canReserveNow    min(freeStock, orderable)
 *
 * Pipeline figures are attributed through each line's requirement link, so a combined order without a
 * project still counts against the right project (or general stock).
 */
import { qtyUnits, fmtQty } from "@/lib/money";

export type MrpInput = {
  required: string;
  siteStock: string;
  inTransit: string;
  consumed: string;
  projectReserved: string;
  incoming: string;
  poPipeline: string;
  openPr: string;
  /** Optional for backwards compatibility (defaults to 0). */
  openRfq?: string;
  freeStock: string;
  receivedAtSite: string;
  damagedRejected: string;
  expectedDate: Date | null;
  requiredBy: Date | null;
  usableCompany: string;
  reorderLevel: string | null;
  today: Date;
};

export type MrpStatus = "FULLY_RECEIVED" | "AVAILABLE" | "AWAITING_DELIVERY" | "PARTIALLY_RECEIVED" | "DELAYED" | "ALREADY_ORDERED" | "LOW_STOCK" | "SHORTAGE";

export type MrpResult = {
  fulfilled: string;
  remainingNeed: string;
  shortage: string;
  toOrder: string;
  orderable: string;
  canReserveNow: string;
  status: MrpStatus;
  flags: ("DAMAGED" | "BELOW_REORDER" | "DUE_SOON" | "OVERDUE")[];
  urgency: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
};

const Z = BigInt(0);
const max0 = (v: bigint) => (v < Z ? Z : v);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function computeMrp(i: MrpInput): MrpResult {
  const q = qtyUnits;
  const fulfilled = q(i.siteStock) + q(i.inTransit) + q(i.consumed);
  const remaining = max0(q(i.required) - fulfilled);
  const shortage = max0(remaining - q(i.projectReserved) - q(i.incoming));
  const afterRequests = max0(shortage - q(i.poPipeline) - q(i.openPr) - q(i.openRfq ?? "0"));
  const free = max0(q(i.freeStock));
  const toOrder = max0(afterRequests - free);
  const canReserve = min(free, afterRequests);

  const overdueDelivery = !!i.expectedDate && i.expectedDate.getTime() < i.today.getTime();
  let status: MrpStatus;
  if (remaining === Z) status = "FULLY_RECEIVED";
  else if (shortage === Z) {
    if (q(i.incoming) > Z) status = overdueDelivery ? "DELAYED" : q(i.receivedAtSite) > Z ? "PARTIALLY_RECEIVED" : "AWAITING_DELIVERY";
    else status = "AVAILABLE";
  } else if (afterRequests === Z) status = "ALREADY_ORDERED";
  else if (toOrder === Z) status = "AVAILABLE";
  else if (free > Z) status = "LOW_STOCK";
  else status = "SHORTAGE";

  const flags: MrpResult["flags"] = [];
  if (q(i.damagedRejected) > Z) flags.push("DAMAGED");
  if (i.reorderLevel !== null && q(i.usableCompany) <= q(i.reorderLevel)) flags.push("BELOW_REORDER");
  const days = i.requiredBy ? Math.floor((i.requiredBy.getTime() - i.today.getTime()) / 86_400_000) : null;
  if (days !== null && remaining > Z) {
    if (days < 0) flags.push("OVERDUE");
    else if (days <= 7) flags.push("DUE_SOON");
  }

  const urgency: MrpResult["urgency"] = shortage === Z ? "LOW" : days !== null && days < 0 ? "CRITICAL" : days !== null && days <= 7 ? "HIGH" : days !== null && days <= 21 ? "MEDIUM" : toOrder > Z ? "MEDIUM" : "LOW";

  return { fulfilled: fmtQty(fulfilled), remainingNeed: fmtQty(remaining), shortage: fmtQty(shortage), toOrder: fmtQty(toOrder), orderable: fmtQty(afterRequests), canReserveNow: fmtQty(canReserve), status, flags, urgency };
}

/**
 * General inventory (warehouse stock, no project) — reorder suggestion + manual purchase quantity.
 *
 *   available    max(0, warehouse on hand − warehouse stock reserved for projects)
 *   onOrder      approved incoming + draft/pending POs + open requisitions + open enquiries (general stock)
 *   projected    available + onOrder
 *   suggested    when a minimum is set and projected ≤ minimum: (target, else minimum) − projected
 *   manualLeft   max(0, manual purchase quantity − already allocated to it)
 *   toOrder      max(suggested, manualLeft)   — both already net of what is on order, so never doubled
 */
export type GeneralInput = { onHand: string; reserved: string; incoming: string; pipeline: string; minStock: string | null; targetStock: string | null; manualQty: string; manualAllocated: string };
export type GeneralResult = { available: string; projected: string; suggested: string; manualLeft: string; toOrder: string; status: MrpStatus; belowMinimum: boolean };

export function computeGeneral(i: GeneralInput): GeneralResult {
  const q = qtyUnits;
  const available = max0(q(i.onHand) - q(i.reserved));
  const incoming = max0(q(i.incoming));
  const pipeline = max0(q(i.pipeline));
  const projected = available + incoming + pipeline;
  const minimum = i.minStock !== null ? q(i.minStock) : null;
  const target = i.targetStock !== null ? q(i.targetStock) : minimum;
  const belowMinimum = minimum !== null && available <= minimum;
  const suggested = minimum !== null && target !== null && projected <= minimum ? max0(target - projected) : Z;
  const manualLeft = max0(q(i.manualQty) - q(i.manualAllocated));
  const toOrder = suggested > manualLeft ? suggested : manualLeft;
  let status: MrpStatus;
  if (toOrder > Z) status = available > Z ? "LOW_STOCK" : "SHORTAGE";
  else if (incoming > Z) status = "AWAITING_DELIVERY";
  else if (pipeline > Z) status = "ALREADY_ORDERED";
  else status = "AVAILABLE";
  return { available: fmtQty(available), projected: fmtQty(projected), suggested: fmtQty(suggested), manualLeft: fmtQty(manualLeft), toOrder: fmtQty(toOrder), status, belowMinimum };
}
