import { z } from "zod";
import { addMoney, cmpMoney, divRound, fmtMoney, money, subMoney, toUnits } from "@/lib/money";

/**
 * Payment milestones / payment terms — pure, decimal-safe and shared by the browser (live preview in
 * the milestone builder) and the server (validation, saved amounts). Client quotations and sales
 * orders use percentage or fixed-amount milestones; supplier quotations use the same shape.
 *
 * Amounts: percentage milestones are rounded to the paisa; the LAST percentage milestone absorbs
 * the rounding remainder so a 100% schedule always adds up to the document total exactly.
 */

export const TRIGGERS = {
  ADVANCE: "Advance (with order)",
  ON_ORDER: "On order confirmation",
  ON_DELIVERY: "On delivery",
  ON_INSTALLATION: "On installation",
  ON_COMPLETION: "On completion / handover",
  ON_DATE: "On a fixed date",
  NET_DAYS: "Net days after invoice",
  CUSTOM: "Custom event",
} as const;
export type Trigger = keyof typeof TRIGGERS;
export const TRIGGER_KEYS = Object.keys(TRIGGERS) as Trigger[];

export type MilestoneInput = {
  label: string;
  basis: "PERCENT" | "AMOUNT";
  /** Percent (e.g. "50") for PERCENT, rupees for AMOUNT. */
  value: string;
  trigger: Trigger;
  dueDate?: string | null;
  days?: number | null;
  note?: string | null;
};

export type ComputedMilestone = MilestoneInput & { percent: string | null; amount: string };

const dec = (re: RegExp, msg: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(re, msg));

export const milestoneSchema = z.object({
  label: z.string().trim().min(1, "Describe the milestone.").max(200),
  basis: z.enum(["PERCENT", "AMOUNT"]),
  value: dec(/^\d{1,14}(\.\d{1,4})?$/, "Enter a number."),
  trigger: z.enum(TRIGGER_KEYS as [Trigger, ...Trigger[]]),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  days: z.union([z.number(), z.string(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v))).pipe(z.union([z.null(), z.number().int().min(0).max(365)])),
  note: z.string().trim().max(300).optional().nullable().transform((v) => (v ? v : null)),
});
export const milestonesSchema = z
  .array(milestoneSchema)
  .max(20)
  .superRefine((items, ctx) =>
    items.forEach((m, i) => {
      if (m.basis === "AMOUNT" && !/^\d{1,14}(\.\d{1,2})?$/.test(m.value)) ctx.addIssue({ code: "custom", path: [i, "value"], message: "Amounts have at most 2 decimals." });
    }),
  );

/** Built-in payment templates (editable after applying; organisations can save their own). */
export const BUILT_IN_TEMPLATES: { key: string; name: string; milestones: MilestoneInput[] }[] = [
  {
    key: "50-40-10",
    name: "50% advance / 40% delivery / 10% installation",
    milestones: [
      { label: "Advance with order", basis: "PERCENT", value: "50", trigger: "ADVANCE" },
      { label: "On delivery", basis: "PERCENT", value: "40", trigger: "ON_DELIVERY" },
      { label: "On installation", basis: "PERCENT", value: "10", trigger: "ON_INSTALLATION" },
    ],
  },
  { key: "100-advance", name: "100% advance", milestones: [{ label: "Full advance with order", basis: "PERCENT", value: "100", trigger: "ADVANCE" }] },
  {
    key: "50-50",
    name: "50% advance / 50% delivery",
    milestones: [
      { label: "Advance with order", basis: "PERCENT", value: "50", trigger: "ADVANCE" },
      { label: "On delivery", basis: "PERCENT", value: "50", trigger: "ON_DELIVERY" },
    ],
  },
  {
    key: "30-70",
    name: "30% advance / 70% completion",
    milestones: [
      { label: "Advance with order", basis: "PERCENT", value: "30", trigger: "ADVANCE" },
      { label: "On completion", basis: "PERCENT", value: "70", trigger: "ON_COMPLETION" },
    ],
  },
  { key: "net-15", name: "Net 15 days", milestones: [{ label: "Payment within 15 days of invoice", basis: "PERCENT", value: "100", trigger: "NET_DAYS", days: 15 }] },
  { key: "net-30", name: "Net 30 days", milestones: [{ label: "Payment within 30 days of invoice", basis: "PERCENT", value: "100", trigger: "NET_DAYS", days: 30 }] },
];

/** Default schedule for new client quotations (editable — not mandatory). */
export const DEFAULT_CLIENT_MILESTONES: MilestoneInput[] = BUILT_IN_TEMPLATES[0]!.milestones;

const PCT_SCALE = 4;

/**
 * Amounts for each milestone against `total` (paise-exact). Fixed amounts are taken as entered;
 * percentage milestones split the total, and the last percentage milestone takes the remainder
 * when the percentages add up to exactly 100%.
 */
export function computeMilestones(total: string, items: MilestoneInput[]): { rows: ComputedMilestone[]; percentSum: string; amountSum: string } {
  const T = money(total);
  const pctUnits = items.map((m) => (m.basis === "PERCENT" ? toUnits(m.value || "0", PCT_SCALE) : BigInt(0)));
  const pctTotal = pctUnits.reduce((a, b) => a + b, BigInt(0));
  const hundred = toUnits("100", PCT_SCALE);
  const lastPct = items.map((m) => m.basis).lastIndexOf("PERCENT");
  const fixedSum = items.reduce((a, m) => (m.basis === "AMOUNT" ? a + money(m.value || "0") : a), BigInt(0));

  let allocatedPct = BigInt(0);
  const rows: ComputedMilestone[] = items.map((m, i) => {
    if (m.basis === "AMOUNT") {
      const amt = money(m.value || "0");
      const pct = T > BigInt(0) ? fmtPct(divRound(amt * hundred, T)) : null;
      return { ...m, percent: pct, amount: fmtMoney(amt) };
    }
    let amt = divRound(T * pctUnits[i]!, hundred);
    // A full 100% percentage schedule (no fixed parts) must add up exactly — remainder to the last one.
    if (i === lastPct && pctTotal === hundred && fixedSum === BigInt(0)) amt = T - allocatedPct;
    allocatedPct += amt;
    return { ...m, percent: fmtPct(pctUnits[i]!), amount: fmtMoney(amt) };
  });
  return { rows, percentSum: fmtPct(pctTotal), amountSum: addMoney(...rows.map((r) => r.amount)) };
}

function fmtPct(units: bigint): string {
  const s = (Number(units) / 10 ** PCT_SCALE).toFixed(PCT_SCALE);
  return s.replace(/\.?0+$/, "");
}

/**
 * Validation for a schedule meant to cover the whole document: every milestone has a positive
 * value and the schedule adds up to exactly the total (100%, or fixed amounts summing to it).
 * Returns human messages; empty = valid.
 */
export function validateSchedule(total: string, items: MilestoneInput[], opts: { requireFull?: boolean } = { requireFull: true }): string[] {
  const errors: string[] = [];
  items.forEach((m, i) => {
    if (!m.label.trim()) errors.push(`Milestone ${i + 1}: add a description.`);
    const units = m.basis === "PERCENT" ? toUnits(m.value || "0", PCT_SCALE) : money(m.value || "0");
    if (units <= BigInt(0)) errors.push(`Milestone ${i + 1}: enter a ${m.basis === "PERCENT" ? "percentage" : "amount"} above zero.`);
    if (m.basis === "PERCENT" && toUnits(m.value || "0", PCT_SCALE) > toUnits("100", PCT_SCALE)) errors.push(`Milestone ${i + 1}: a percentage cannot exceed 100%.`);
    if (m.trigger === "ON_DATE" && !m.dueDate) errors.push(`Milestone ${i + 1}: choose the due date.`);
    if (m.trigger === "NET_DAYS" && (m.days === null || m.days === undefined)) errors.push(`Milestone ${i + 1}: enter the number of days.`);
  });
  if (!items.length) return opts.requireFull ? ["Add at least one payment milestone."] : errors;
  const { amountSum } = computeMilestones(total, items);
  const diff = subMoney(total, amountSum);
  if (opts.requireFull && cmpMoney(diff, "0") !== 0) {
    errors.push(cmpMoney(diff, "0") > 0 ? `The schedule covers ${amountSum} of ${fmtMoney(money(total))}; ${diff} is not allocated to any milestone.` : `The schedule adds up to ${amountSum}, more than the total ${fmtMoney(money(total))}.`);
  } else if (cmpMoney(diff, "0") < 0) {
    errors.push(`The schedule adds up to ${amountSum}, more than the total ${fmtMoney(money(total))}.`);
  }
  return errors;
}

/** One-line summary for documents, e.g. "50% advance with order · 40% on delivery · 10% on installation". */
export function scheduleSummary(rows: { label: string; percent: string | null; basis: string; amount: string }[]) {
  return rows.map((r) => `${r.basis === "PERCENT" && r.percent ? `${r.percent}%` : `₹${r.amount}`} ${r.label.toLowerCase()}`).join(" · ");
}

/** Row → milestone input (for editing saved milestones). */
export function toInput(r: { label: string; basis: string; percent: string | null; amount: string; trigger: string; dueDate?: string | null; days?: number | null; note?: string | null }): MilestoneInput {
  return { label: r.label, basis: r.basis === "AMOUNT" ? "AMOUNT" : "PERCENT", value: r.basis === "AMOUNT" ? r.amount : (r.percent ?? "0"), trigger: (TRIGGER_KEYS.includes(r.trigger as Trigger) ? r.trigger : "CUSTOM") as Trigger, dueDate: r.dueDate ?? null, days: r.days ?? null, note: r.note ?? null };
}
