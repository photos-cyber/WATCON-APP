/**
 * Decimal-safe commercial arithmetic (client- and server-safe, no floats).
 *
 * Values cross every boundary as decimal STRINGS. Internally they are BigInt fixed-point:
 *   money    2 dp (paise)        quantities 3 dp
 *   rates    4 dp                percentages 2 dp (GST %, discount %, retention %)
 * Rounding is half-up (away from zero), applied per line, which is how Indian GST
 * invoices are normally computed (tax per line, document total = sum of lines).
 */

const TEN = BigInt(10);
const ZERO = BigInt(0);
const pow = (n: number) => TEN ** BigInt(n);

export const SCALE = { money: 2, qty: 3, rate: 4, pct: 2 } as const;

/** Parses "12.5" / "-3" / 7 into a BigInt at the given scale. Throws on bad input; extra decimals are rounded half-up. */
export function toUnits(value: string | number | bigint | null | undefined, scale: number): bigint {
  if (value === null || value === undefined || value === "") return ZERO;
  if (typeof value === "bigint") return value * pow(scale);
  const s = String(value).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Invalid number: ${s}`);
  const frac = m[3] ?? "";
  // Any number of decimals is accepted; extra digits are rounded half-up to `scale`.
  let units = BigInt(m[2] || "0") * pow(scale) + BigInt((frac.slice(0, scale) || "").padEnd(scale, "0") || "0");
  if (frac.length > scale && /^[5-9]/.test(frac.slice(scale))) units += BigInt(1);
  return m[1] === "-" ? -units : units;
}

/** BigInt at `scale` → canonical decimal string (trailing zeros kept for money so "12.50"). */
export function fromUnits(units: bigint, scale: number, opts: { trim?: boolean } = {}): string {
  const neg = units < ZERO;
  const abs = neg ? -units : units;
  const p = pow(scale);
  const whole = (abs / p).toString();
  let frac = scale ? (abs % p).toString().padStart(scale, "0") : "";
  if (opts.trim) frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Divides with half-up rounding (away from zero). */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === ZERO) throw new Error("Division by zero");
  const neg = n < ZERO !== d < ZERO;
  const an = n < ZERO ? -n : n;
  const ad = d < ZERO ? -d : d;
  const q = (an + ad / BigInt(2)) / ad;
  return neg ? -q : q;
}

/** Re-scales a value (rounding half-up when reducing precision). */
export function rescale(units: bigint, from: number, to: number): bigint {
  if (to >= from) return units * pow(to - from);
  return divRound(units, pow(from - to));
}

// ───────────── Convenience string API ─────────────

export const money = (v: string | number | null | undefined) => toUnits(v, SCALE.money);
export const qtyUnits = (v: string | number | null | undefined) => toUnits(v, SCALE.qty);
export const fmtMoney = (u: bigint) => fromUnits(u, SCALE.money);
export const fmtQty = (u: bigint) => fromUnits(u, SCALE.qty, { trim: true });

/** Normalises a money string to 2 dp ("12.5" → "12.50"). */
export const normMoney = (v: string | number | null | undefined) => fmtMoney(money(v));
/** Normalises a quantity string ("12.500" → "12.5"). */
export const normQty = (v: string | number | null | undefined) => fmtQty(qtyUnits(v));

export function addMoney(...values: (string | null | undefined)[]): string {
  return fmtMoney(values.reduce((a, v) => a + money(v), ZERO));
}
export function subMoney(a: string | null | undefined, b: string | null | undefined): string {
  return fmtMoney(money(a) - money(b));
}
export function addQty(...values: (string | null | undefined)[]): string {
  return fmtQty(values.reduce((a, v) => a + qtyUnits(v), ZERO));
}
export function subQty(a: string | null | undefined, b: string | null | undefined): string {
  return fmtQty(qtyUnits(a) - qtyUnits(b));
}
/** -1 / 0 / 1 */
export function cmpMoney(a: string | null | undefined, b: string | null | undefined): number {
  const d = money(a) - money(b);
  return d === ZERO ? 0 : d < ZERO ? -1 : 1;
}
export function cmpQty(a: string | null | undefined, b: string | null | undefined): number {
  const d = qtyUnits(a) - qtyUnits(b);
  return d === ZERO ? 0 : d < ZERO ? -1 : 1;
}
export const maxQty = (a: string, b: string) => (cmpQty(a, b) >= 0 ? normQty(a) : normQty(b));
export const minQty = (a: string, b: string) => (cmpQty(a, b) <= 0 ? normQty(a) : normQty(b));
export const isZero = (v: string | null | undefined) => money(v) === ZERO && qtyUnits(v ?? "0") === ZERO;

/** `pct` % of an amount, rounded to paise. */
export function pctOf(amount: string | null | undefined, pct: string | number | null | undefined): string {
  return fmtMoney(divRound(money(amount) * toUnits(pct, SCALE.pct), pow(2 + SCALE.pct)));
}

/** quantity × rate → money (rounded to paise). */
export function qtyTimesRate(qty: string | number, rate: string | number): string {
  return fmtMoney(rescale(toUnits(qty, SCALE.qty) * toUnits(rate, SCALE.rate), SCALE.qty + SCALE.rate, SCALE.money));
}

/** amount / qty → unit rate at 4 dp (e.g. landed cost per unit). Zero quantity → "0". */
export function unitRate(amount: string, qty: string): string {
  const q = qtyUnits(qty);
  if (q === ZERO) return "0";
  // amount(2dp) / qty(3dp) → rate(4dp): amount × 10^(3+4−2) / qty
  return fromUnits(divRound(money(amount) * pow(SCALE.qty + SCALE.rate - SCALE.money), q), SCALE.rate, { trim: true });
}

/** Percentage a/b × 100 with 2 dp ("0" when b is zero). */
export function percent(a: string, b: string): string {
  const den = money(b);
  if (den === ZERO) return "0";
  return fromUnits(divRound(money(a) * pow(2 + SCALE.pct), den), SCALE.pct, { trim: true });
}

// ───────────── GST line maths ─────────────

/** INTRA = supplier and place of supply in the same state (CGST + SGST); INTER = IGST. */
export type TaxMode = "INTRA" | "INTER";

export type LineInput = { qty: string | number; rate: string | number; discountPct?: string | number | null; gstRate?: string | number | null };
export type LineAmounts = { gross: string; discount: string; taxable: string; cgst: string; sgst: string; igst: string; tax: string; total: string };

/**
 * One document line: gross = qty × rate; discount = gross × d%; taxable = gross − discount;
 * GST on taxable (INTRA: CGST and SGST are each half the rate, rounded separately).
 */
export function lineAmounts(line: LineInput, mode: TaxMode): LineAmounts {
  const gross = money(qtyTimesRate(line.qty, line.rate));
  const discount = divRound(gross * toUnits(line.discountPct ?? 0, SCALE.pct), pow(2 + SCALE.pct));
  const taxable = gross - discount;
  const rate = toUnits(line.gstRate ?? 0, SCALE.pct);
  let cgst = ZERO;
  let sgst = ZERO;
  let igst = ZERO;
  if (mode === "INTRA") {
    cgst = divRound(taxable * rate, BigInt(2) * pow(2 + SCALE.pct));
    sgst = cgst;
  } else {
    igst = divRound(taxable * rate, pow(2 + SCALE.pct));
  }
  const tax = cgst + sgst + igst;
  return { gross: fmtMoney(gross), discount: fmtMoney(discount), taxable: fmtMoney(taxable), cgst: fmtMoney(cgst), sgst: fmtMoney(sgst), igst: fmtMoney(igst), tax: fmtMoney(tax), total: fmtMoney(taxable + tax) };
}

export type DocTotals = { gross: string; discount: string; taxable: string; cgst: string; sgst: string; igst: string; tax: string; charges: string; chargesTax: string; roundOff: string; total: string };

/**
 * Document totals = Σ lines + extra charges (freight etc., taxed at `chargesGstRate`) and an
 * optional round-off to the nearest rupee.
 */
export function documentTotals(lines: LineAmounts[], opts: { mode: TaxMode; charges?: string | null; chargesGstRate?: string | number | null; roundToRupee?: boolean } = { mode: "INTRA" }): DocTotals {
  const sum = (k: keyof LineAmounts) => lines.reduce((a, l) => a + money(l[k]), ZERO);
  const charges = money(opts.charges ?? "0");
  const chargeLine = charges === ZERO ? null : lineAmounts({ qty: "1", rate: fmtMoney(charges), gstRate: opts.chargesGstRate ?? 0 }, opts.mode);
  const chargesTax = chargeLine ? money(chargeLine.tax) : ZERO;
  const cgst = sum("cgst") + (chargeLine ? money(chargeLine.cgst) : ZERO);
  const sgst = sum("sgst") + (chargeLine ? money(chargeLine.sgst) : ZERO);
  const igst = sum("igst") + (chargeLine ? money(chargeLine.igst) : ZERO);
  const taxable = sum("taxable");
  const exact = taxable + charges + cgst + sgst + igst;
  const rounded = opts.roundToRupee ? divRound(exact, pow(SCALE.money)) * pow(SCALE.money) : exact;
  return {
    gross: fmtMoney(sum("gross")),
    discount: fmtMoney(sum("discount")),
    taxable: fmtMoney(taxable),
    cgst: fmtMoney(cgst),
    sgst: fmtMoney(sgst),
    igst: fmtMoney(igst),
    tax: fmtMoney(cgst + sgst + igst),
    charges: fmtMoney(charges),
    chargesTax: fmtMoney(chargesTax),
    roundOff: fmtMoney(rounded - exact),
    total: fmtMoney(rounded),
  };
}

/** CGST+SGST when both state codes are known and equal; IGST when they differ; INTRA by default. */
export function taxModeFor(companyStateCode: string | null | undefined, placeOfSupplyStateCode: string | null | undefined): TaxMode {
  if (companyStateCode && placeOfSupplyStateCode && companyStateCode !== placeOfSupplyStateCode) return "INTER";
  return "INTRA";
}

// ───────────── Display ─────────────

/** ₹ with Indian digit grouping: 1234567.5 → "₹12,34,567.50". */
export function formatINR(value: string | null | undefined, opts: { symbol?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  let units: bigint;
  try {
    units = money(value);
  } catch {
    return String(value);
  }
  const neg = units < ZERO;
  const s = fromUnits(neg ? -units : units, 2);
  const [whole, frac] = s.split(".") as [string, string];
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}${opts.symbol === false ? "" : "₹"}${grouped}.${frac}`;
}

/** Compact ₹ for cards: ₹1.25 Cr, ₹4.50 L, ₹12,500. */
export function formatINRCompact(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const units = money(value);
  const neg = units < ZERO;
  const abs = neg ? -units : units;
  const crore = BigInt(10_000_000) * pow(2);
  const lakh = BigInt(100_000) * pow(2);
  const sign = neg ? "-" : "";
  if (abs >= crore) return `${sign}₹${fromUnits(divRound(abs * pow(2), crore), 2)} Cr`;
  if (abs >= lakh) return `${sign}₹${fromUnits(divRound(abs * pow(2), lakh), 2)} L`;
  return `${sign}${formatINR(fromUnits(rescale(abs, 2, 0) * pow(2), 2)).replace(/\.00$/, "")}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`);
  return parts.join(" ");
}

/** Indian numbering in words for invoices: "Rupees Twelve Lakh Thirty Four Thousand … and Fifty Paise Only". */
export function amountInWords(value: string): string {
  const units = money(value);
  const neg = units < ZERO;
  const abs = neg ? -units : units;
  let rupees = abs / BigInt(100);
  const paise = Number(abs % BigInt(100));
  const parts: string[] = [];
  const crore = rupees / BigInt(10_000_000);
  rupees %= BigInt(10_000_000);
  if (crore > ZERO) parts.push(`${crore > BigInt(999) ? crore.toString() : below1000(Number(crore))} Crore`);
  const lakh = Number(rupees / BigInt(100_000));
  rupees %= BigInt(100_000);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  const thousand = Number(rupees / BigInt(1000));
  rupees %= BigInt(1000);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (rupees > ZERO) parts.push(below1000(Number(rupees)));
  const words = parts.length ? parts.join(" ") : "Zero";
  return `${neg ? "Minus " : ""}Rupees ${words}${paise ? ` and ${below1000(paise)} Paise` : ""} Only`;
}
