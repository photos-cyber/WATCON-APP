import { beforeEach, expect, it } from "vitest";
import { createPo } from "@/modules/procurement/po";
import { listProjectDocuments, uploadAttachment } from "@/modules/documents/attachments";
import { listOrgDocuments } from "@/modules/insights/documents";
import { commercialFixture, day, type CFx } from "./commercial-helpers";

let fx: CFx;
beforeEach(async () => { fx = await commercialFixture(); });

it("hides restricted commercial filenames and totals in both document browsers", async () => {
  const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, orderDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "2", rate: "10", gstRate: "18" }] });
  const bytes = new TextEncoder().encode("%PDF-1.4\n audit fixture");
  await uploadAttachment(fx.roles.pu.actor, { entityType: "purchase_order", entityId: po.id, category: "OTHER", fileName: "confidential-prices.pdf", bytes });
  await uploadAttachment(fx.roles.se.actor, { entityType: "project", entityId: fx.p1.id, category: "OTHER", fileName: "site-plan.pdf", bytes });
  const restricted = { ...fx.roles.se.actor, permissions: fx.roles.se.actor.permissions.filter((p) => p !== "po.view") };
  for (const result of [await listOrgDocuments(restricted, {}), await listProjectDocuments(restricted, fx.p1.id, {})]) {
    expect(result.total).toBe(1);
    expect(result.rows.map((r) => r.fileName)).toEqual(["site-plan.pdf"]);
  }
  expect((await listOrgDocuments(restricted, { q: "confidential" })).total).toBe(0);
  expect((await listProjectDocuments(fx.actors.superAdmin, fx.p1.id, {})).total).toBe(2);
});
