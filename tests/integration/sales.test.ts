import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createParty } from "@/modules/parties/service";
import { taskCountsByProject } from "@/modules/projects/service";
import { clientPoAction, createClientPo, getClientPo, updateClientPo } from "@/modules/sales/client-po";
import { clientInvoiceAction, createClientInvoice, getClientInvoice } from "@/modules/sales/invoice";
import { certifyRaBill, createRaBill, getRaBill, raBillAction } from "@/modules/sales/ra-bill";
import { createSalesOrder, decideSoAmendment, getSalesOrder, requestSoAmendment, salesOrderAction, updateSalesOrder, withdrawSoAmendment } from "@/modules/sales/sales-order";
import { challanAction, createChallan } from "@/modules/stores/challan";
import { commercialFixture, day, errorOf, type CFx } from "./commercial-helpers";

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

type M = "clientPo" | "salesOrder" | "raBill" | "clientInvoice";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

async function activeCpo(extra: Record<string, unknown> = {}, partyId = fx.client.id) {
  const cpo = await createClientPo(fx.roles.pm.actor, {
    projectId: fx.p1.id,
    partyId,
    clientPoNumber: `ACME/PO/${Math.random().toString(36).slice(2, 7)}`,
    poDate: day(-30),
    retentionPct: "5",
    advanceAmount: "10000",
    advanceRecoveryPct: "10",
    lines: [
      { description: "RCC M25 slab", unit: "Cum", quantity: "100", rate: "6000", gstRate: "18" },
      { description: "Brick masonry", unit: "Sqm", quantity: "50", rate: "1000", discountPct: "10", gstRate: "18" },
    ],
    milestones: [{ name: "Mobilisation", percent: "10" }],
    ...extra,
  });
  await clientPoAction(fx.roles.pm.actor, cpo.id, "submit", { version: await v("clientPo", cpo.id) });
  await clientPoAction(fx.actors.admin, cpo.id, "approve", { version: await v("clientPo", cpo.id) });
  return db.clientPo.findUniqueOrThrow({ where: { id: cpo.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

async function approvedSo(lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), deliveryDate: day(10), lines, ...extra });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
  await salesOrderAction(fx.actors.admin, so.id, "approve", { version: await v("salesOrder", so.id) });
  return db.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

const cementLine = (qty = "30") => ({ itemBrandId: fx.ibUltra.id, quantity: qty, rate: "450", gstRate: "28" });

describe("client POs", () => {
  it("approves with separation of duties and keeps the original value; amendments snapshot a revision", async () => {
    const cpo = await createClientPo(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: "ACME-1", poDate: day(), lines: [{ description: "Work", unit: "LS", quantity: "1", rate: "100000", gstRate: "18" }] });
    expect(cpo.number).toMatch(/^CPO\//);
    await clientPoAction(fx.roles.pm.actor, cpo.id, "submit", { version: await v("clientPo", cpo.id) });
    // PM has no approve permission; admin cannot approve something they submitted? (admin did not) → approve ok
    expect((await errorOf(clientPoAction(fx.roles.pm.actor, cpo.id, "approve", { version: await v("clientPo", cpo.id) }))).message).toMatch(/permission/);
    await clientPoAction(fx.actors.admin, cpo.id, "approve", { version: await v("clientPo", cpo.id) });
    let row = await db.clientPo.findUniqueOrThrow({ where: { id: cpo.id } });
    expect(row.status).toBe("ACTIVE");
    expect(row.originalTotal?.toFixed(2)).toBe("118000.00");

    await clientPoAction(fx.roles.pm.actor, cpo.id, "variation", { version: row.version, note: "Extra scope" });
    const rev = await db.clientPoRevision.findFirstOrThrow({ where: { clientPoId: cpo.id } });
    expect(rev.revision).toBe(0);
    expect(rev.isVariation).toBe(true);
    const lines = await db.clientPoLine.findMany({ where: { clientPoId: cpo.id } });
    await updateClientPo(fx.roles.pm.actor, cpo.id, await v("clientPo", cpo.id), { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: "ACME-1", poDate: day(), lines: [{ id: lines[0]!.id, description: "Work", unit: "LS", quantity: "1.5", rate: "100000", gstRate: "18" }] });
    await clientPoAction(fx.roles.pm.actor, cpo.id, "submit", { version: await v("clientPo", cpo.id) });
    await clientPoAction(fx.actors.admin, cpo.id, "approve", { version: await v("clientPo", cpo.id) });
    row = await db.clientPo.findUniqueOrThrow({ where: { id: cpo.id } });
    expect(row.revision).toBe(1);
    expect(row.total.toFixed(2)).toBe("177000.00");
    expect(row.originalTotal?.toFixed(2)).toBe("118000.00");
    const view = await getClientPo(fx.actors.admin, cpo.id);
    expect(view.summary.variation).toBe("59000.00");
  });

  it("enforces separation of duties for an approver who submitted", async () => {
    const cpo = await createClientPo(fx.actors.admin, { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: "ACME-2", poDate: day(), lines: [{ description: "Work", unit: "LS", quantity: "1", rate: "1000", gstRate: "18" }] });
    await clientPoAction(fx.actors.admin, cpo.id, "submit", { version: await v("clientPo", cpo.id) });
    expect((await errorOf(clientPoAction(fx.actors.admin, cpo.id, "approve", { version: await v("clientPo", cpo.id) }))).message).toMatch(/Separation of duties/);
  });

  it("sales orders cannot exceed what is left on the client PO", async () => {
    const cpo = await activeCpo();
    const l1 = cpo.lines[0]!;
    await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoId: cpo.id, orderDate: day(), lines: [{ clientPoLineId: l1.id, quantity: "70", rate: "6000", gstRate: "18" }] });
    const err = await errorOf(createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoId: cpo.id, orderDate: day(), lines: [{ clientPoLineId: l1.id, quantity: "31", rate: "6000", gstRate: "18" }] }));
    expect(err.message).toMatch(/only 30 Cum is left/);
  });
});

describe("running bills", () => {
  it("prevents over-billing, including two bills raced at once", async () => {
    const cpo = await activeCpo();
    const l1 = cpo.lines[0]!;
    const mk = (qty: string) => createRaBill(fx.roles.pm.actor, { clientPoId: cpo.id, billDate: day(), periodFrom: day(-30), periodTo: day(), lines: [{ clientPoLineId: l1.id, claimedQty: qty }] });
    expect((await errorOf(mk("101"))).message).toMatch(/exceeds what is left/);
    const results = await Promise.allSettled([mk("60"), mk("60")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const bills = await db.raBill.findMany({ where: { clientPoId: cpo.id } });
    expect(bills.map((b) => b.raNumber)).toEqual([1]);
    const second = await mk("40");
    expect((await db.raBill.findUniqueOrThrow({ where: { id: second.id } })).raNumber).toBe(2);
  });

  it("certification ≤ claimed, retention and capped advance recovery, then one invoice only", async () => {
    const cpo = await activeCpo();
    const [l1, l2] = cpo.lines;
    const ra = await createRaBill(fx.roles.se.actor, { clientPoId: cpo.id, billDate: day(), periodFrom: day(-30), periodTo: day(), lines: [{ clientPoLineId: l1!.id, claimedQty: "20" }, { clientPoLineId: l2!.id, claimedQty: "10" }] });
    // 20 × 6000 + 10 × 900 (10% discount) = 129000
    let row = await db.raBill.findUniqueOrThrow({ where: { id: ra.id } });
    expect(row.claimedAmount.toFixed(2)).toBe("129000.00");
    await raBillAction(fx.roles.se.actor, ra.id, "submit_review", { version: row.version });
    expect((await errorOf(raBillAction(fx.roles.se.actor, ra.id, "approve", { version: await v("raBill", ra.id) }))).message).toMatch(/permission/);
    await raBillAction(fx.roles.pm.actor, ra.id, "approve", { version: await v("raBill", ra.id) });
    const lines = await db.raBillLine.findMany({ where: { raBillId: ra.id }, orderBy: { claimedQty: "desc" } });
    const over = await errorOf(certifyRaBill(fx.roles.ac.actor, ra.id, await v("raBill", ra.id), { clientCertRef: "C-1", clientCertDate: day(), lines: [{ lineId: lines[0]!.id, certifiedQty: "21" }, { lineId: lines[1]!.id, certifiedQty: "10" }] }));
    expect(over.message).toMatch(/cannot exceed the claimed/);
    await certifyRaBill(fx.roles.ac.actor, ra.id, await v("raBill", ra.id), { clientCertRef: "C-1", clientCertDate: day(), otherDeductions: "500", lines: [{ lineId: lines[0]!.id, certifiedQty: "18" }, { lineId: lines[1]!.id, certifiedQty: "10" }] });
    row = await db.raBill.findUniqueOrThrow({ where: { id: ra.id } });
    // certified = 108000 + 9000 = 117000; gst 18% = 21060; retention 5% = 5850; advance 10% = 11700 capped at 10000
    expect(row.certifiedAmount.toFixed(2)).toBe("117000.00");
    expect(row.gstAmount.toFixed(2)).toBe("21060.00");
    expect(row.retentionAmount.toFixed(2)).toBe("5850.00");
    expect(row.advanceRecovery.toFixed(2)).toBe("10000.00");
    expect(row.netPayable.toFixed(2)).toBe("121710.00");
    expect(row.status).toBe("CLIENT_CERTIFIED");

    // Second bill: advance fully recovered already → 0.
    const ra2 = await createRaBill(fx.roles.se.actor, { clientPoId: cpo.id, billDate: day(), periodFrom: day(1), periodTo: day(2), lines: [{ clientPoLineId: l1!.id, claimedQty: "10" }] });
    expect((await db.raBill.findUniqueOrThrow({ where: { id: ra2.id } })).advanceRecovery.toFixed(2)).toBe("0.00");
    // Released quantity: 20 claimed, 18 certified → 100 − 18 − 10 = 72 left.
    expect((await errorOf(createRaBill(fx.roles.se.actor, { clientPoId: cpo.id, billDate: day(), periodFrom: day(3), periodTo: day(4), lines: [{ clientPoLineId: l1!.id, claimedQty: "73" }] }))).message).toMatch(/72/);

    const inv = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: ra.id, invoiceDate: day() });
    expect((await db.raBill.findUniqueOrThrow({ where: { id: ra.id } })).status).toBe("INVOICED");
    expect((await errorOf(createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: ra.id, invoiceDate: day() }))).message).toMatch(/already invoiced/);
    const view = await getClientInvoice(fx.roles.ac.actor, inv.id);
    expect(view.invoice.number).toMatch(/^DRAFT\//);
    expect(view.invoice.taxable).toBe("117000.00");
    expect(view.invoice.cgst).toBe("10530.00");
    expect(view.invoice.total).toBe("138060.00");
    expect(view.invoice.netReceivable).toBe("121710.00");
    const res = await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
    expect(res?.number).toMatch(/^INV\//);
    await clientInvoiceAction(fx.actors.admin, inv.id, "cancel", { version: await v("clientInvoice", inv.id), note: "Wrong date" });
    expect((await db.raBill.findUniqueOrThrow({ where: { id: ra.id } })).status).toBe("CLIENT_CERTIFIED");
    const again = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: ra.id, invoiceDate: day() });
    expect(again.raBillId).toBe(ra.id);
    expect((await getRaBill(fx.roles.ac.actor, ra.id)).bill.invoice?.id).toBe(again.id);
  });
});

describe("sales orders drive the project", () => {
  it("is locked once approved; amendment requests need another Super Admin; approval applies, syncs requirements", async () => {
    const so = await approvedSo([cementLine("30"), { description: "Installation labour", unit: "Day", quantity: "5", rate: "1200", gstRate: "18" }]);
    expect(so.status).toBe("APPROVED");
    let req = await db.materialRequirement.findUniqueOrThrow({ where: { projectId_itemBrandId: { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id } } });
    expect(req.requiredQty.toFixed(3)).toBe("30.000");
    expect(req.salesOrderLineId).toBe(so.lines[0]!.id);

    // Locked: nobody edits directly, not even a Super Admin.
    const body = { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(), lines: [cementLine("40")] };
    expect((await errorOf(updateSalesOrder(fx.actors.superAdmin, so.id, so.version, body))).message).toMatch(/locked/);

    const proposal = { reason: "Client asked for 10 more bags", lines: [{ id: so.lines[0]!.id, ...cementLine("40") }, { id: so.lines[1]!.id, description: "Installation labour", unit: "Day", quantity: "5", rate: "1200", gstRate: "18" }] };
    const r = await requestSoAmendment(fx.actors.admin, so.id, proposal);
    expect((await errorOf(requestSoAmendment(fx.roles.pm.actor, so.id, proposal))).message).toMatch(/already a pending amendment/);
    expect((await errorOf(decideSoAmendment(fx.actors.admin, r.id, "approve"))).message).toMatch(/Only a Super Admin/);
    // A Super Admin may approve their own request (Super Admins are exempt from separation of duties).
    await withdrawSoAmendment(fx.actors.admin, r.id);
    const own = await requestSoAmendment(fx.actors.superAdmin, so.id, proposal);
    const res = await decideSoAmendment(fx.actors.superAdmin, own.id, "approve");
    expect(res).toEqual({ applied: true, revision: 1 });
    const after = await db.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    expect(after.revision).toBe(1);
    expect(after.lines[0]!.quantity.toFixed(3)).toBe("40.000");
    expect(after.lines[0]!.id).toBe(so.lines[0]!.id);
    expect((await db.soAmendmentRequest.findUniqueOrThrow({ where: { id: own.id } })).appliedRevision).toBe(1);
    req = await db.materialRequirement.findUniqueOrThrow({ where: { id: req.id } });
    expect(req.requiredQty.toFixed(3)).toBe("40.000");
    expect(await db.notification.count({ where: { userId: fx.users.superAdmin.id, type: "so_amendment" } })).toBeGreaterThan(0);
  });

  it("rejection leaves the order unchanged; reducing below delivered is refused at approval", async () => {
    const so = await approvedSo([cementLine("30")]);
    const lineId = so.lines[0]!.id;
    const r1 = await requestSoAmendment(fx.roles.pm.actor, so.id, { reason: "Reduce quantity", lines: [{ id: lineId, ...cementLine("20") }] });
    expect((await errorOf(decideSoAmendment(fx.actors.superAdmin, r1.id, "reject"))).message).toMatch(/reason/);
    await decideSoAmendment(fx.actors.superAdmin, r1.id, "reject", "Not agreed with client");
    const same = await db.salesOrder.findUniqueOrThrow({ where: { id: so.id }, include: { lines: true } });
    expect(same.revision).toBe(0);
    expect(same.lines[0]!.quantity.toFixed(3)).toBe("30.000");

    // Deliver 25 to the client, then a pending request to reduce to 20 must fail at approval.
    const r2 = await requestSoAmendment(fx.roles.pm.actor, so.id, { reason: "Reduce again", lines: [{ id: lineId, ...cementLine("20") }] });
    const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: so.partyId, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "25", soLineId: lineId }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: (await db.challan.findUniqueOrThrow({ where: { id: c.id } })).version });
    expect((await db.soLine.findUniqueOrThrow({ where: { id: lineId } })).deliveredQty.toFixed(3)).toBe("25.000");
    expect((await errorOf(decideSoAmendment(fx.actors.superAdmin, r2.id, "approve"))).message).toMatch(/below what was already delivered/);
    expect((await db.soAmendmentRequest.findUniqueOrThrow({ where: { id: r2.id } })).status).toBe("PENDING");
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: so.id } })).status).toBe("PARTIALLY_FULFILLED");

    // Supply invoice from delivered quantity; cancel reverses the counter.
    const inv = await createClientInvoice(fx.roles.ac.actor, { source: "SO", soId: so.id, invoiceDate: day(), lines: [{ sourceLineId: lineId, quantity: "25" }] });
    expect((await db.soLine.findUniqueOrThrow({ where: { id: lineId } })).invoicedQty.toFixed(3)).toBe("25.000");
    expect((await errorOf(createClientInvoice(fx.roles.ac.actor, { source: "SO", soId: so.id, invoiceDate: day(), lines: [{ sourceLineId: lineId, quantity: "1" }] }))).message).toMatch(/only 0 delivered/);
    await clientInvoiceAction(fx.actors.admin, inv.id, "cancel", { version: await v("clientInvoice", inv.id), note: "Re-issue" });
    expect((await db.soLine.findUniqueOrThrow({ where: { id: lineId } })).invoicedQty.toFixed(3)).toBe("0.000");
    const view = await getSalesOrder(fx.actors.admin, so.id);
    expect(view.fulfilment[0]!.delivered).toBe("25");
  });

  it("project progress follows sales-order delivery and status moves Planning → Active → Completed", async () => {
    await db.project.update({ where: { id: fx.p1.id }, data: { status: "PLANNING" } });
    const so = await approvedSo([cementLine("40")]);
    const lineId = so.lines[0]!.id;
    expect((await db.project.findUniqueOrThrow({ where: { id: fx.p1.id } })).status).toBe("ACTIVE");
    let counts = (await taskCountsByProject(fx.actors.admin, [fx.p1.id])).get(fx.p1.id)!;
    expect([counts.progressBasis, counts.progress]).toEqual(["delivery", 0]);

    const deliver = async (qty: string) => {
      const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: so.partyId, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: qty, soLineId: lineId }] });
      await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: (await db.challan.findUniqueOrThrow({ where: { id: c.id } })).version });
    };
    await deliver("10");
    counts = (await taskCountsByProject(fx.actors.admin, [fx.p1.id])).get(fx.p1.id)!;
    expect(counts.progress).toBe(25);
    expect((await db.project.findUniqueOrThrow({ where: { id: fx.p1.id } })).status).toBe("ACTIVE");

    await deliver("30");
    counts = (await taskCountsByProject(fx.actors.admin, [fx.p1.id])).get(fx.p1.id)!;
    expect(counts.progress).toBe(100);
    expect((await db.project.findUniqueOrThrow({ where: { id: fx.p1.id } })).status).toBe("COMPLETED");
  });

  it("manual On hold is never overridden by automation", async () => {
    await db.project.update({ where: { id: fx.p1.id }, data: { status: "ON_HOLD" } });
    await approvedSo([cementLine("5")]);
    expect((await db.project.findUniqueOrThrow({ where: { id: fx.p1.id } })).status).toBe("ON_HOLD");
  });

  it("uses IGST for an inter-state client", async () => {
    const outOfState = await createParty(fx.actors.admin, { name: "Karnataka Infra", isClient: true, stateCode: "29" });
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: outOfState.id, orderDate: day(), lines: [cementLine("10")] });
    expect(so.taxMode).toBe("INTER");
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    await salesOrderAction(fx.actors.admin, so.id, "approve", { version: await v("salesOrder", so.id) });
    const line = await db.soLine.findFirstOrThrow({ where: { soId: so.id } });
    const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: so.partyId, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "10", soLineId: line.id }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: (await db.challan.findUniqueOrThrow({ where: { id: c.id } })).version });
    const inv = await createClientInvoice(fx.roles.ac.actor, { source: "SO", soId: so.id, invoiceDate: day(), lines: [{ sourceLineId: line.id, quantity: "10" }] });
    const row = await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.taxMode).toBe("INTER");
    expect(row.igst.toFixed(2)).toBe("1260.00");
    expect(row.cgst.toFixed(2)).toBe("0.00");
  });

  it("refuses to invoice a client with no state (place of supply)", async () => {
    const noState = await createParty(fx.actors.admin, { name: "Stateless Builders", isClient: true });
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: noState.id, orderDate: day(), lines: [cementLine("5")] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });
    await salesOrderAction(fx.actors.admin, so.id, "approve", { version: await v("salesOrder", so.id) });
    const line = await db.soLine.findFirstOrThrow({ where: { soId: so.id } });
    const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: so.partyId, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "5", soLineId: line.id }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: (await db.challan.findUniqueOrThrow({ where: { id: c.id } })).version });
    const err = await errorOf(createClientInvoice(fx.roles.ac.actor, { source: "SO", soId: so.id, invoiceDate: day(), lines: [{ sourceLineId: line.id, quantity: "5" }] }));
    expect(err.message).toMatch(/place of supply/);
  });

  it("the person who drafted an invoice cannot issue it; another approver can", async () => {
    const so = await approvedSo([cementLine("8")]);
    const line = so.lines[0]!;
    const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: so.partyId, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "8", soLineId: line.id }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: (await db.challan.findUniqueOrThrow({ where: { id: c.id } })).version });
    const inv = await createClientInvoice(fx.actors.admin, { source: "SO", soId: so.id, invoiceDate: day(), lines: [{ sourceLineId: line.id, quantity: "8" }] });
    const view = await getClientInvoice(fx.actors.admin, inv.id);
    expect(view.can.issue).toBe(false);
    expect(view.can.issueBlocked).toMatch(/another approver/);
    expect((await errorOf(clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) }))).message).toMatch(/Separation of duties/);
    const res = await clientInvoiceAction(fx.actors.superAdmin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
    expect(res?.number).toMatch(/^INV\//);
  });

  it("cancelling an approved order cancels its requirement (never deletes it)", async () => {
    const so = await approvedSo([cementLine("12")]);
    await salesOrderAction(fx.actors.admin, so.id, "cancel", { version: so.version, note: "Client dropped" });
    const req = await db.materialRequirement.findUniqueOrThrow({ where: { projectId_itemBrandId: { projectId: fx.p1.id, itemBrandId: fx.ibUltra.id } } });
    expect(req.status).toBe("CANCELLED");
  });
});
