import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addMoney, cmpMoney } from "@/lib/money";
import { createPayment } from "@/modules/payables/payments";
import { clientInvoiceAction, createClientInvoice } from "@/modules/sales/invoice";
import { createMilestoneInvoice, getSoBilling, markMilestoneAchieved, setSoMilestones } from "@/modules/sales/milestone-billing";
import { acceptViaLink, convertToSalesOrder, createQuotation, getQuotation, quotationAction, recordAcceptance, requestAcceptanceCode } from "@/modules/sales/quotation";
import { salesOrderAction } from "@/modules/sales/sales-order";
import { challanAction, createChallan } from "@/modules/stores/challan";
import { commercialFixture, day, errorOf, type CFx } from "./commercial-helpers";

let fx: CFx;
beforeEach(async () => {
  fx = await commercialFixture();
});

const ver = async (model: "clientQuotation" | "salesOrder" | "clientInvoice", id: string) => ((await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version);

const DEFAULT = [
  { label: "Advance with order", basis: "PERCENT", value: "50", trigger: "ADVANCE" },
  { label: "On delivery", basis: "PERCENT", value: "40", trigger: "ON_DELIVERY" },
  { label: "On installation", basis: "PERCENT", value: "10", trigger: "ON_INSTALLATION" },
];

const quoteInput = (milestones: Record<string, unknown>[] = DEFAULT) => ({
  projectId: fx.p1.id,
  partyId: fx.client.id,
  subject: "Filtration package",
  quoteDate: day(),
  validUntil: day(30),
  terms: "1. Prices firm for 30 days.\n2. Delivery 2 weeks from advance.",
  lines: [
    { itemBrandId: fx.ibUltra.id, description: "OPC cement 53 grade", brand: "UltraTech", unit: "Bag", quantity: "40", rate: "450", gstRate: "28" },
    { description: "Installation & commissioning", unit: "Job", quantity: "1", rate: "10000", gstRate: "18" },
  ],
  milestones,
});

async function approvedQuote() {
  const q = await createQuotation(fx.roles.pm.actor, quoteInput());
  await quotationAction(fx.roles.pm.actor, q.id, "submit", { version: await ver("clientQuotation", q.id) });
  await quotationAction(fx.roles.pm.actor, q.id, "mark_sent", { version: await ver("clientQuotation", q.id), via: "email" });
  return db.clientQuotation.findUniqueOrThrow({ where: { id: q.id }, include: { milestones: { orderBy: { sortOrder: "asc" } } } });
}

describe("client quotations", () => {
  it("prices server-side, splits the 50/40/10 schedule to the paisa and rejects incomplete schedules", async () => {
    const q = await createQuotation(fx.roles.pm.actor, quoteInput());
    const full = await db.clientQuotation.findUniqueOrThrow({ where: { id: q.id }, include: { milestones: { orderBy: { sortOrder: "asc" } } } });
    // 40 × 450 = 18000 @28% = 23040 ; 10000 @18% = 11800 → 34840
    expect(full.total.toFixed(2)).toBe("34840.00");
    expect(full.milestones.map((m) => m.amount.toFixed(2))).toEqual(["17420.00", "13936.00", "3484.00"]);
    expect(addMoney(...full.milestones.map((m) => m.amount.toFixed(2)))).toBe("34840.00");
    const e = await errorOf(createQuotation(fx.roles.pm.actor, quoteInput([{ label: "Advance", basis: "PERCENT", value: "50", trigger: "ADVANCE" }, { label: "Delivery", basis: "PERCENT", value: "40", trigger: "ON_DELIVERY" }])));
    expect(e.message).toMatch(/not allocated/);
  });

  it("client acceptance needs the emailed one-time code; email failure is reported, not faked", async () => {
    const q = await approvedQuote();
    expect((await errorOf(requestAcceptanceCode(q.accessToken))).message).toMatch(/no email address on file/);
    await db.party.update({ where: { id: fx.client.id }, data: { email: "accounts@client.example" } });
    // Test env uses the console mail transport → nothing is delivered → honest failure.
    expect((await errorOf(requestAcceptanceCode(q.accessToken))).message).toMatch(/could not send/);
    await db.clientQuotation.update({ where: { id: q.id }, data: { otpHash: createHash("sha256").update(`${q.id}:123456`).digest("hex"), otpExpiresAt: new Date(Date.now() + 600_000) } });
    expect((await errorOf(acceptViaLink(q.accessToken, { code: "000000", name: "R. Client" }, { ip: "1.2.3.4", userAgent: "t" }))).message).toMatch(/not correct/);
    await acceptViaLink(q.accessToken, { code: "123456", name: "R. Client", role: "Director" }, { ip: "1.2.3.4", userAgent: "test-agent" });
    const after = await db.clientQuotation.findUniqueOrThrow({ where: { id: q.id } });
    expect(after.status).toBe("ACCEPTED");
    expect(after.acceptanceMethod).toBe("CLIENT_LINK_OTP");
    expect(after.acceptedIp).toBe("1.2.3.4");
    expect((after.acceptedSnapshot as { total: string }).total).toBe("34840.00");
    expect(after.otpHash).toBeNull();
  });

  it("revision keeps the previous version; only approved / sent quotations can be accepted by staff", async () => {
    const q = await approvedQuote();
    await quotationAction(fx.roles.pm.actor, q.id, "revise", { version: await ver("clientQuotation", q.id), note: "Client asked for revised rate" });
    const r = await db.clientQuotation.findUniqueOrThrow({ where: { id: q.id }, include: { revisions: true } });
    expect([r.status, r.revision, r.revisions.length]).toEqual(["DRAFT", 1, 1]);
    expect((await errorOf(recordAcceptance(fx.actors.admin, q.id, r.version, { acceptedByName: "Ravi Client", note: "Signed copy" }))).message).toMatch(/changed by someone|status|cannot|only/i);
  });
});

describe("quotation → sales order → milestone billing", () => {
  it("converts idempotently and bills milestones without double billing", async () => {
    const q = await approvedQuote();
    await recordAcceptance(fx.actors.admin, q.id, await ver("clientQuotation", q.id), { acceptedByName: "R. Client", note: "Signed and stamped copy received 23 Nov" });
    const c1 = await convertToSalesOrder(fx.roles.pm.actor, q.id);
    const c2 = await convertToSalesOrder(fx.roles.pm.actor, q.id);
    expect(c1.created).toBe(true);
    expect(c2).toEqual({ soId: c1.soId, created: false });
    expect(await db.salesOrder.count({ where: { projectId: fx.p1.id } })).toBe(1);
    const so = await db.salesOrder.findUniqueOrThrow({ where: { id: c1.soId }, include: { lines: true, milestones: { orderBy: { sortOrder: "asc" } } } });
    expect(so.total.toFixed(2)).toBe("34840.00");
    expect(so.milestones.map((m) => m.amount.toFixed(2))).toEqual(["17420.00", "13936.00", "3484.00"]);
    expect((await getQuotation(fx.actors.admin, q.id)).q.status).toBe("CONVERTED");

    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await ver("salesOrder", so.id) });

    // Delivery-quantity invoicing is closed for a milestone-billed order.
    const cementLine = so.lines.find((l) => l.itemBrandId)!;
    expect((await errorOf(createClientInvoice(fx.roles.ac.actor, { source: "SO", soId: so.id, invoiceDate: day(), lines: [{ sourceLineId: cementLine.id, quantity: "1" }] }))).message).toMatch(/payment milestones/);
    // The schedule is locked once billing starts (checked below) — it can be changed before.
    await setSoMilestones(fx.roles.pm.actor, so.id, { milestones: DEFAULT });

    // 1) Advance → proforma (not a tax invoice), only up to the milestone amount.
    const ms = await db.paymentMilestone.findMany({ where: { soId: so.id }, orderBy: { sortOrder: "asc" } });
    expect((await errorOf(createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[0]!.id, amount: "17420.01", invoiceDate: day() }))).message).toMatch(/can be billed/);
    const pi = await createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[0]!.id, amount: "17420.00", invoiceDate: day() });
    expect(pi.kind).toBe("PROFORMA");
    expect((await errorOf(createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[0]!.id, amount: "1", invoiceDate: day() }))).message).toMatch(/Nothing|Only/);
    expect((await errorOf(setSoMilestones(fx.roles.pm.actor, so.id, { milestones: DEFAULT }))).message).toMatch(/already raised/);
    await clientInvoiceAction(fx.actors.admin, pi.id, "issue", { version: await ver("clientInvoice", pi.id) });
    const piRow = await db.clientInvoice.findUniqueOrThrow({ where: { id: pi.id } });
    expect(piRow.number).toMatch(/^PI\//);
    expect(cmpMoney(piRow.total.toFixed(2), "17420.00")).toBe(0);

    // 2) Delivery milestone is not billable before delivery.
    expect((await errorOf(createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[1]!.id, amount: "100", invoiceDate: day() }))).message).toMatch(/Nothing on/);

    // Client pays the advance.
    await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", amount: "17420.00", idempotencyKey: `adv-${so.id}`, allocations: [{ documentId: pi.id, amount: "17420.00" }] });
    let billing = await getSoBilling(fx.actors.admin, so.id);
    expect([billing.received, billing.advanceAvailable, billing.invoiced]).toEqual(["17420.00", "17420.00", "0.00"]);

    // Deliver all material → delivery milestone fully eligible.
    const ch = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", soId: so.id, partyId: so.partyId, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "40", soLineId: cementLine.id }] });
    await challanAction(fx.roles.sk.actor, ch.id, "dispatch", { version: (await db.challan.findUniqueOrThrow({ where: { id: ch.id } })).version });

    // 3) Delivery tax invoice: 40% + adjust the 50% advance → GST charged on 90%, net 40%.
    expect((await errorOf(createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[1]!.id, amount: "13936.00", adjustAdvance: "20000", invoiceDate: day() }))).message).toMatch(/advance received is available/);
    const t1 = await createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[1]!.id, amount: "13936.00", adjustAdvance: "17420.00", invoiceDate: day() });
    const t1Row = await db.clientInvoice.findUniqueOrThrow({ where: { id: t1.id } });
    expect(t1.kind).toBe("TAX_INVOICE");
    expect([t1Row.total.toFixed(2), t1Row.advanceRecovery.toFixed(2), t1Row.netReceivable.toFixed(2)]).toEqual(["31356.00", "17420.00", "13936.00"]);

    // 4) Installation needs confirmation first (that is not a payment).
    expect((await errorOf(createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[2]!.id, amount: "3484.00", invoiceDate: day() }))).message).toMatch(/Nothing on/);
    await markMilestoneAchieved(fx.roles.pm.actor, ms[2]!.id, "Installed and handed over");
    const t2 = await createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: ms[2]!.id, amount: "3484.00", invoiceDate: day() });
    for (const id of [t1.id, t2.id]) await clientInvoiceAction(fx.actors.admin, id, "issue", { version: await ver("clientInvoice", id) });

    billing = await getSoBilling(fx.actors.admin, so.id);
    expect(billing.contractValue).toBe("34840.00");
    expect(billing.invoiced).toBe("34840.00"); // full order tax-invoiced exactly once
    expect(billing.remainingToInvoice).toBe("0.00");
    expect(billing.received).toBe("17420.00");
    expect(billing.outstanding).toBe("17420.00"); // 13936 + 3484 still to collect
    expect(billing.advanceAvailable).toBe("0.00");
    expect(billing.milestones.map((m) => m.state)).toEqual(["PAID", "INVOICED", "INVOICED"]);
    // Nothing more can be billed anywhere on this order.
    for (const m of ms) expect((await errorOf(createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: m.id, amount: "1", invoiceDate: day() }))).message).toMatch(/Nothing|Only/);
  });
});

describe("quotation & proforma PDFs", () => {
  it("render from real records on the WATCON layout", async () => {
    const { renderToBuffer } = await import("@react-pdf/renderer");
    const { createElement } = await import("react");
    const { CommercialPdf } = await import("@/components/documents/commercial-pdf");
    const { buildPdfModel } = await import("@/modules/documents/pdf-models");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const q = await approvedQuote();
    const doc = await buildPdfModel(fx.actors.admin, "client_quotation", q.id);
    expect(doc.title).toBe("Quotation");
    expect(doc.sections?.find((s) => s.title === "Payment terms")?.items?.[0]).toMatch(/Advance with order — 50% · ₹17,420.00/);
    const buf = Buffer.from(await renderToBuffer(createElement(CommercialPdf, { doc }) as never));
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    if (process.env.PDF_SAMPLES_DIR) {
      mkdirSync(process.env.PDF_SAMPLES_DIR, { recursive: true });
      writeFileSync(`${process.env.PDF_SAMPLES_DIR}/quotation.pdf`, buf);
    }
    // Proforma advance request PDF is labelled as not a tax invoice.
    await recordAcceptance(fx.actors.admin, q.id, await ver("clientQuotation", q.id), { acceptedByName: "R. Client", note: "Signed copy received" });
    const { soId } = await convertToSalesOrder(fx.roles.pm.actor, q.id);
    await salesOrderAction(fx.roles.pm.actor, soId, "submit", { version: await ver("salesOrder", soId) });
    const m = await db.paymentMilestone.findFirstOrThrow({ where: { soId }, orderBy: { sortOrder: "asc" } });
    const pi = await createMilestoneInvoice(fx.roles.ac.actor, { milestoneId: m.id, amount: "17420.00", invoiceDate: day() });
    await clientInvoiceAction(fx.actors.admin, pi.id, "issue", { version: await ver("clientInvoice", pi.id) });
    const pdoc = await buildPdfModel(fx.actors.admin, "client_invoice", pi.id);
    expect([pdoc.title, pdoc.status?.label]).toEqual(["Proforma Invoice", "Advance request – not a tax invoice"]);
    if (process.env.PDF_SAMPLES_DIR) writeFileSync(`${process.env.PDF_SAMPLES_DIR}/proforma.pdf`, Buffer.from(await renderToBuffer(createElement(CommercialPdf, { doc: pdoc }) as never)));
  });
});
