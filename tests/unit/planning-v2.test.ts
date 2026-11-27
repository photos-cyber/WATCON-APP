import { describe, expect, it } from "vitest";
import { computeGeneral, computeMrp, type MrpInput } from "@/modules/planning/mrp";
import { computeMilestones, DEFAULT_CLIENT_MILESTONES, validateSchedule } from "@/modules/commercial/payment-terms";

const base: MrpInput = {
  required: "100",
  siteStock: "0",
  inTransit: "0",
  consumed: "0",
  projectReserved: "0",
  incoming: "0",
  poPipeline: "0",
  openPr: "0",
  freeStock: "0",
  receivedAtSite: "0",
  damagedRejected: "0",
  expectedDate: null,
  requiredBy: null,
  usableCompany: "0",
  reorderLevel: null,
  today: new Date("2026-11-26T00:00:00Z"),
};

describe("project planning maths (workflow v2)", () => {
  it("issued, reserved, incoming and requests all reduce what needs ordering", () => {
    const r = computeMrp({ ...base, siteStock: "10", consumed: "5", projectReserved: "5", incoming: "20", poPipeline: "10", openPr: "10", openRfq: "10", freeStock: "5" });
    expect(r.fulfilled).toBe("15");
    expect(r.shortage).toBe("60"); // 100 − 15 − 5 − 20
    expect(r.orderable).toBe("30"); // 60 − 10 − 10 − 10
    expect(r.toOrder).toBe("25"); // 30 − 5 free warehouse stock
    expect(r.canReserveNow).toBe("5");
  });

  it("open rate enquiries count as already requested (no duplicate ordering)", () => {
    expect(computeMrp({ ...base, openRfq: "100" })).toMatchObject({ toOrder: "0", orderable: "0", status: "ALREADY_ORDERED" });
    expect(computeMrp({ ...base, openRfq: "40" }).toOrder).toBe("60");
  });

  it("openRfq is optional for existing callers", () => {
    expect(computeMrp(base)).toMatchObject({ toOrder: "100", orderable: "100", status: "SHORTAGE" });
  });
});

describe("general inventory maths", () => {
  const g = { onHand: "0", reserved: "0", incoming: "0", pipeline: "0", minStock: null, targetStock: null, manualQty: "0", manualAllocated: "0" };

  it("suggests ordering up to the target when at or below the minimum", () => {
    expect(computeGeneral({ ...g, onHand: "8", minStock: "10", targetStock: "50" })).toMatchObject({ available: "8", suggested: "42", toOrder: "42", belowMinimum: true, status: "LOW_STOCK" });
    // exactly at minimum still reorders
    expect(computeGeneral({ ...g, onHand: "10", minStock: "10", targetStock: "50" }).suggested).toBe("40");
    // above minimum: no suggestion
    expect(computeGeneral({ ...g, onHand: "11", minStock: "10", targetStock: "50" })).toMatchObject({ suggested: "0", toOrder: "0", status: "AVAILABLE" });
  });

  it("without a target orders back up to the minimum", () => {
    expect(computeGeneral({ ...g, onHand: "3", minStock: "10" }).suggested).toBe("7");
  });

  it("reserved stock is not available; incoming and on-order stock prevent re-ordering", () => {
    expect(computeGeneral({ ...g, onHand: "20", reserved: "15", minStock: "10", targetStock: "40" })).toMatchObject({ available: "5", suggested: "35" });
    expect(computeGeneral({ ...g, onHand: "0", incoming: "30", pipeline: "20", minStock: "10", targetStock: "50" })).toMatchObject({ suggested: "0", toOrder: "0", status: "AWAITING_DELIVERY" });
    expect(computeGeneral({ ...g, pipeline: "5", minStock: "10", targetStock: "50" }).suggested).toBe("45");
  });

  it("manual purchase quantity is net of what is already allocated, and never added to the suggestion", () => {
    expect(computeGeneral({ ...g, manualQty: "25", manualAllocated: "10" })).toMatchObject({ manualLeft: "15", toOrder: "15", status: "SHORTAGE" });
    expect(computeGeneral({ ...g, manualQty: "25", manualAllocated: "25" }).toOrder).toBe("0");
    // larger of the two, not the sum
    expect(computeGeneral({ ...g, onHand: "0", minStock: "10", targetStock: "40", manualQty: "15" }).toOrder).toBe("40");
  });
});

describe("default sales-order payment schedule", () => {
  it("is 50% advance / 40% delivery / 10% installation and adds up exactly", () => {
    expect(DEFAULT_CLIENT_MILESTONES.map((m) => [m.value, m.trigger])).toEqual([
      ["50", "ADVANCE"],
      ["40", "ON_DELIVERY"],
      ["10", "ON_INSTALLATION"],
    ]);
    const { rows, amountSum } = computeMilestones("11800.01", DEFAULT_CLIENT_MILESTONES);
    expect(amountSum).toBe("11800.01");
    expect(rows.map((r) => r.amount)).toEqual(["5900.01", "4720.00", "1180.00"]);
    expect(validateSchedule("11800.01", DEFAULT_CLIENT_MILESTONES)).toEqual([]);
  });
});
