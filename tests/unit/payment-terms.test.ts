import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATES, computeMilestones, DEFAULT_CLIENT_MILESTONES, validateSchedule, type MilestoneInput } from "@/modules/commercial/payment-terms";

const pct = (label: string, value: string, trigger: MilestoneInput["trigger"] = "CUSTOM"): MilestoneInput => ({ label, basis: "PERCENT", value, trigger });

describe("payment milestones", () => {
  it("default 50/40/10 on ₹10,00,000", () => {
    const r = computeMilestones("1000000", DEFAULT_CLIENT_MILESTONES);
    expect(r.rows.map((x) => x.amount)).toEqual(["500000.00", "400000.00", "100000.00"]);
    expect(r.percentSum).toBe("100");
    expect(validateSchedule("1000000", DEFAULT_CLIENT_MILESTONES)).toEqual([]);
  });

  it("puts the paisa remainder on the last percentage milestone so the schedule adds up exactly", () => {
    const r = computeMilestones("100.01", [pct("A", "33.3333"), pct("B", "33.3333"), pct("C", "33.3334")]);
    expect(r.amountSum).toBe("100.01");
    expect(validateSchedule("100.01", [pct("A", "33.3333"), pct("B", "33.3333"), pct("C", "33.3334")])).toEqual([]);
  });

  it("supports fixed-amount milestones and mixed schedules", () => {
    const items: MilestoneInput[] = [{ label: "Mobilisation", basis: "AMOUNT", value: "250000", trigger: "ADVANCE" }, pct("Balance on delivery", "75", "ON_DELIVERY")];
    const r = computeMilestones("1000000", items);
    expect(r.rows.map((x) => [x.amount, x.percent])).toEqual([["250000.00", "25"], ["750000.00", "75"]]);
    expect(validateSchedule("1000000", items)).toEqual([]);
  });

  it("rejects schedules that do not cover the total, or exceed it", () => {
    expect(validateSchedule("1000", [pct("A", "50"), pct("B", "40")])[0]).toMatch(/not allocated/);
    expect(validateSchedule("1000", [pct("A", "60"), pct("B", "50")])[0]).toMatch(/more than the total/);
    expect(validateSchedule("1000", [pct("A", "0")]).join()).toMatch(/above zero/);
    expect(validateSchedule("1000", [{ label: "Net", basis: "PERCENT", value: "100", trigger: "NET_DAYS" }]).join()).toMatch(/days/);
  });

  it("allows partial schedules when full coverage is not required", () => {
    expect(validateSchedule("1000", [pct("Advance", "30", "ADVANCE")], { requireFull: false })).toEqual([]);
  });

  it("every built-in template is a valid full schedule", () => {
    for (const t of BUILT_IN_TEMPLATES) expect(validateSchedule("123456.78", t.milestones), t.name).toEqual([]);
  });
});
