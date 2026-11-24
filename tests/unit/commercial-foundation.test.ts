import { describe, expect, it } from "vitest";
import { fiscalYearOf, formatDocNumber } from "@/lib/doc-numbering";
import { gstinChecksumValid } from "@/lib/gst";
import { addMoney, cmpMoney, divRound, documentTotals, formatINR, formatINRCompact, lineAmounts, normMoney, pctOf, percent, qtyTimesRate, subQty, taxModeFor, toUnits, unitRate } from "@/lib/money";
import { safeFileName, sniffMime } from "@/lib/storage/sniff";
import { defaultPermissionsFor, can, ROLE_KEYS, PERMISSIONS, isSuperAdminOnly } from "@/lib/permissions/definitions";
import { partyInputSchema } from "@/modules/parties/validation";

describe("money (decimal-safe)", () => {
  it("never suffers float error", () => {
    expect(addMoney("0.1", "0.2")).toBe("0.30");
    expect(qtyTimesRate("3", "0.1")).toBe("0.30");
    expect(qtyTimesRate("1.005", "1000")).toBe("1005.00");
  });
  it("rounds half-up away from zero", () => {
    expect(divRound(BigInt(5), BigInt(2))).toBe(BigInt(3));
    expect(divRound(BigInt(-5), BigInt(2))).toBe(BigInt(-3));
    expect(qtyTimesRate("2.5", "0.333")).toBe("0.83"); // 0.8325 → 0.83
    expect(qtyTimesRate("1", "0.125")).toBe("0.13");
  });
  it("rejects malformed numbers and rounds excess precision", () => {
    expect(toUnits("1.234", 2)).toBe(BigInt(123));
    expect(toUnits("1.235", 2)).toBe(BigInt(124));
    expect(toUnits("-1.235", 2)).toBe(BigInt(-124));
    expect(() => toUnits("abc", 2)).toThrow();
    expect(toUnits("1.230", 2)).toBe(BigInt(123));
  });
  it("computes intra-state GST per line (CGST = SGST = half, each rounded)", () => {
    const l = lineAmounts({ qty: "10", rate: "99.99", discountPct: "5", gstRate: "18" }, "INTRA");
    expect(l).toEqual({ gross: "999.90", discount: "50.00", taxable: "949.90", cgst: "85.49", sgst: "85.49", igst: "0.00", tax: "170.98", total: "1120.88" });
  });
  it("computes inter-state IGST", () => {
    const l = lineAmounts({ qty: "10", rate: "99.99", discountPct: "5", gstRate: "18" }, "INTER");
    expect(l.igst).toBe("170.98");
    expect(l.cgst).toBe("0.00");
    expect(l.total).toBe("1120.88");
  });
  it("document totals include taxed charges and round-off", () => {
    const lines = [lineAmounts({ qty: "1", rate: "100.40", gstRate: "18" }, "INTRA"), lineAmounts({ qty: "2", rate: "50", gstRate: "5" }, "INTRA")];
    const t = documentTotals(lines, { mode: "INTRA", charges: "100", chargesGstRate: "18", roundToRupee: true });
    expect(t.taxable).toBe("200.40");
    expect(t.charges).toBe("100.00");
    // 200.40 + 100 + tax(18.07 lines… see components) → rounded to rupee
    expect(Number(t.total) % 1).toBe(0);
    expect(addMoney(t.taxable, t.charges, t.tax, t.roundOff)).toBe(t.total);
  });
  it("tax mode from state codes", () => {
    expect(taxModeFor("27", "27")).toBe("INTRA");
    expect(taxModeFor("27", "29")).toBe("INTER");
    expect(taxModeFor(null, "29")).toBe("INTRA");
  });
  it("helpers", () => {
    expect(pctOf("1000", "5")).toBe("50.00");
    expect(pctOf("333.33", "2.5")).toBe("8.33");
    expect(percent("25", "200")).toBe("12.5");
    expect(unitRate("1000", "3")).toBe("333.3333");
    expect(subQty("10", "2.5")).toBe("7.5");
    expect(cmpMoney("10.00", "9.99")).toBe(1);
    expect(normMoney("5")).toBe("5.00");
  });
  it("formats Indian rupees", () => {
    expect(formatINR("1234567.5")).toBe("₹12,34,567.50");
    expect(formatINR("-999")).toBe("-₹999.00");
    expect(formatINRCompact("12500000")).toBe("₹1.25 Cr");
    expect(formatINRCompact("450000")).toBe("₹4.50 L");
  });
});

describe("document numbering", () => {
  it("uses the Indian financial year", () => {
    expect(fiscalYearOf(new Date("2026-03-31T00:00:00Z"))).toBe("2025-26");
    expect(fiscalYearOf(new Date("2026-04-01T00:00:00Z"))).toBe("2026-27");
    expect(fiscalYearOf(new Date("2099-12-31T00:00:00Z"))).toBe("2099-00");
    expect(formatDocNumber("PO", "2026-27", 7, 4)).toBe("PO/2026-27/0007");
    expect(formatDocNumber("GRN", null, 12345, 4)).toBe("GRN/12345");
  });
});

describe("GST validation", () => {
  it("validates the GSTIN check digit", () => {
    expect(gstinChecksumValid("27AAPFU0939F1ZV")).toBe(true);
    expect(gstinChecksumValid("27AAPFU0939F1ZW")).toBe(false);
    expect(gstinChecksumValid("27AAPFU0939F1Z")).toBe(false);
  });
  it("party schema derives state and PAN from GSTIN and cross-checks them", () => {
    const ok = partyInputSchema.safeParse({ name: "Ultra Traders", isSupplier: true, gstin: "27aapfu0939f1zv" });
    expect(ok.success && ok.data.stateCode).toBe("27");
    expect(ok.success && ok.data.pan).toBe("AAPFU0939F");
    const bad = partyInputSchema.safeParse({ name: "X Co", isSupplier: true, gstin: "27AAPFU0939F1ZV", stateCode: "29" });
    expect(bad.success).toBe(false);
    const none = partyInputSchema.safeParse({ name: "X Co" });
    expect(none.success).toBe(false);
    const tds = partyInputSchema.safeParse({ name: "X Co", isSupplier: true, tdsSection: "194C" });
    expect(tds.success).toBe(false);
  });
});

describe("upload content sniffing", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  it("detects allowed types from magic bytes, not names", () => {
    expect(sniffMime(bytes(0x25, 0x50, 0x44, 0x46, 0x2d), "x.exe")).toBe("application/pdf");
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0), "photo.pdf")).toBe("image/jpeg");
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMime(bytes(0x4d, 0x5a, 0x90, 0x00), "invoice.pdf")).toBeNull(); // Windows executable
    expect(sniffMime(bytes(0x50, 0x4b, 0x03, 0x04), "archive.zip")).toBeNull();
    expect(sniffMime(new TextEncoder().encode("<script>alert(1)</script>"), "x.html")).toBeNull();
  });
  it("sanitises file names", () => {
    expect(safeFileName("../../etc/passwd", "application/pdf")).toBe("passwd.pdf");
    expect(safeFileName("Bill <1>.PDF", "application/pdf")).toBe("Bill _1_.PDF");
  });
});

describe("roles & permissions", () => {
  it("every role exists in the catalogue defaults and no super-admin-only grant leaks", () => {
    for (const r of ROLE_KEYS) expect(Array.isArray(defaultPermissionsFor(r))).toBe(true);
    for (const p of PERMISSIONS) if (isSuperAdminOnly(p.key)) expect(p.defaults).toEqual([]);
  });
  it("role defaults follow job functions", () => {
    const as = (role: (typeof ROLE_KEYS)[number]) => ({ role, permissions: defaultPermissionsFor(role) });
    expect(can(as("SITE_ENGINEER"), "grn.create")).toBe(true);
    expect(can(as("SITE_ENGINEER"), "grn.post")).toBe(false);
    expect(can(as("SITE_ENGINEER"), "po.approve")).toBe(false);
    expect(can(as("PURCHASE"), "po.create")).toBe(true);
    expect(can(as("PURCHASE"), "po.approve")).toBe(false);
    expect(can(as("ACCOUNTS"), "bills.approve")).toBe(false);
    expect(can(as("ACCOUNTS"), "payments.manage")).toBe(true);
    expect(can(as("VIEWER"), "po.create")).toBe(false);
    expect(can(as("VIEWER"), "accounts.view")).toBe(true);
    expect(can(as("USER"), "po.view")).toBe(false);
  });
});
