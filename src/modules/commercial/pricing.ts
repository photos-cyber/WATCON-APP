import { z } from "zod";
import { documentTotals, lineAmounts, type TaxMode } from "@/lib/money";

/**
 * Shared priced-line validation + server-side totals. Clients may preview totals with the same
 * functions, but the server always recomputes and stores its own figures.
 */

const decimal = (re: RegExp, msg: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().regex(re, msg));

/** Every procurement document belongs to exactly one project. */
export const projectIdField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => v ?? "")
  .pipe(z.string().min(1, "Select the project this is for.").uuid("Select the project this is for."));

/**
 * Procurement documents (requisition, rate enquiry, purchase order) may be raised for general
 * inventory — no project, delivered to a warehouse. Empty / null → null.
 */
export const optionalProjectIdField = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .pipe(z.union([z.null(), z.string().uuid("Select the project this is for.")]));

export const qtyField =decimal(/^\d{1,11}(\.\d{1,3})?$/, "Quantity: up to 3 decimals.").refine((v) => Number(v) > 0, "Must be greater than zero.");
export const qtyOrZero = decimal(/^\d{1,11}(\.\d{1,3})?$/, "Quantity: up to 3 decimals.");
export const rateField = decimal(/^\d{1,13}(\.\d{1,4})?$/, "Rate: up to 4 decimals.");
export const moneyField = decimal(/^\d{1,14}(\.\d{1,2})?$/, "Amount: up to 2 decimals.");
export const pctField = decimal(/^\d{1,3}(\.\d{1,2})?$/, "Percent: up to 2 decimals.").refine((v) => Number(v) <= 100, "Must be 100 or less.");
export const gstRateField = pctField.refine((v) => ["0", "0.1", "0.25", "1", "1.5", "3", "5", "6", "7.5", "12", "18", "28"].includes(String(Number(v))), "Use a valid GST rate (0, 0.25, 3, 5, 12, 18, 28 …).");
export const optMoney = z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? "0" : String(v).trim())).pipe(z.string().regex(/^\d{1,14}(\.\d{1,2})?$/, "Amount: up to 2 decimals."));
export const optPct = z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === null || v === undefined || String(v).trim() === "" ? "0" : String(v).trim())).pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Percent: up to 2 decimals.").refine((v) => Number(v) <= 100, "Must be 100 or less."));

export type PricedLine = { quantity: string; rate: string; discountPct: string; gstRate: string };

/** Per-line amounts + document totals (line-wise rounding, optional rupee round-off). */
export function priceDocument<T extends PricedLine>(lines: T[], mode: TaxMode, opts: { charges?: string; chargesGstRate?: string; roundToRupee?: boolean } = {}) {
  const priced = lines.map((l) => ({ ...l, amounts: lineAmounts({ qty: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate }, mode) }));
  const totals = documentTotals(
    priced.map((p) => p.amounts),
    { mode, charges: opts.charges ?? "0", chargesGstRate: opts.chargesGstRate ?? "0", roundToRupee: opts.roundToRupee ?? false },
  );
  return { lines: priced, totals };
}
