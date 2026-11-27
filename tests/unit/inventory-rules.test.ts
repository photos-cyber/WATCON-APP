import { describe, expect, it } from "vitest";
import { applyMovement, directionFor, fromMilli, movementDateError, summarize, toMilli, type LedgerEntry } from "@/modules/inventory/rules";
import { itemInputSchema, linkBrandSchema, movementSchema } from "@/modules/inventory/validation";
import { formatCode } from "@/lib/codes";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("quantity arithmetic", () => {
  it("is exact to three decimals", () => {
    expect(toMilli("0.1") + toMilli("0.2")).toBe(toMilli("0.3"));
    expect(fromMilli(toMilli("12.500"))).toBe("12.5");
    expect(fromMilli(toMilli("7"))).toBe("7");
    expect(fromMilli(-toMilli("1.05"))).toBe("-1.05");
    expect(() => toMilli("1.2345")).toThrow();
  });

  it("never lets a balance go negative", () => {
    expect(applyMovement("10", "OUT", "10")).toBe("0");
    expect(applyMovement("10", "OUT", "10.001")).toBeNull();
    expect(applyMovement("0", "IN", "2.5")).toBe("2.5");
  });

  it("derives direction from the movement type", () => {
    expect(directionFor("OPENING")).toBe("IN");
    expect(directionFor("INWARD")).toBe("IN");
    expect(directionFor("OUTWARD")).toBe("OUT");
    expect(directionFor("ADJUSTMENT", "OUT")).toBe("OUT");
    expect(() => directionFor("ADJUSTMENT")).toThrow();
  });
});

describe("movement dates", () => {
  it("rejects future dates and back-dating before the latest movement", () => {
    expect(movementDateError(d("2026-11-19"), d("2026-11-18"), null)).toMatch(/future/);
    expect(movementDateError(d("2026-11-10"), d("2026-11-18"), d("2026-11-12"))).toMatch(/later movement/);
    expect(movementDateError(d("2026-11-12"), d("2026-11-18"), d("2026-11-12"))).toBeNull();
  });
});

describe("period summary", () => {
  const ledger: LedgerEntry[] = [
    { type: "OPENING", direction: "IN", quantity: "100", txnDate: d("2026-11-01") },
    { type: "INWARD", direction: "IN", quantity: "50", txnDate: d("2026-11-05") },
    { type: "OUTWARD", direction: "OUT", quantity: "30", txnDate: d("2026-11-10") },
    { type: "ADJUSTMENT", direction: "OUT", quantity: "2", txnDate: d("2026-11-15") },
  ];

  it("summarises all time", () => {
    expect(summarize(ledger, null, null)).toEqual({ opening: "100", inward: "50", outward: "32", closing: "118" });
  });

  it("carries earlier movements into the opening balance", () => {
    expect(summarize(ledger, d("2026-11-06"), d("2026-11-12"))).toEqual({ opening: "150", inward: "0", outward: "30", closing: "120" });
  });
});

describe("inventory validation", () => {
  it("normalises item codes and requires name and unit", () => {
    expect(itemInputSchema.parse({ code: " pipe-25 ", name: "PVC Pipe", unit: "Mtr" }).code).toBe("PIPE-25");
    expect(itemInputSchema.parse({ code: "", name: "PVC Pipe", unit: "Mtr" }).code).toBeNull();
    expect(itemInputSchema.safeParse({ code: "bad code!", name: "PVC Pipe", unit: "Mtr" }).success).toBe(false);
    expect(itemInputSchema.safeParse({ name: "P", unit: "" }).success).toBe(false);
  });

  it("validates movements (positive quantity, mandatory reason for every manual change)", () => {
    const base = { itemBrandId: crypto.randomUUID(), type: "INWARD", quantity: "5", txnDate: "2026-11-18", reason: "Count correction", idempotencyKey: crypto.randomUUID() };
    expect(movementSchema.safeParse(base).success).toBe(true);
    // Workflow v2: inward / outward without a reason are refused too.
    expect(movementSchema.safeParse({ ...base, reason: "" }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, quantity: "0" }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, quantity: "-1" }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, quantity: "1.2345" }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, type: "ADJUSTMENT", direction: "IN", reason: "" }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, type: "ADJUSTMENT" }).success).toBe(false);
    expect(movementSchema.safeParse({ ...base, type: "ADJUSTMENT", direction: "IN", reason: "Physical count" }).success).toBe(true);
  });

  it("treats a blank or zero opening quantity as none", () => {
    const ids = { itemId: crypto.randomUUID(), brandId: crypto.randomUUID() };
    expect(linkBrandSchema.parse({ ...ids, openingQty: "" }).openingQty).toBeNull();
    expect(linkBrandSchema.parse({ ...ids, openingQty: "0" }).openingQty).toBeNull();
    expect(linkBrandSchema.parse({ ...ids, openingQty: 12.5 }).openingQty).toBe("12.5");
  });

  it("formats inventory business codes", () => {
    expect(formatCode("ITEM", 7)).toBe("ITM-0007");
    expect(formatCode("BRAND", 7)).toBe("BRD-007");
    expect(formatCode("STOCK_TXN", 7)).toBe("STX-000007");
  });
});
