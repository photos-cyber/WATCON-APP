import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CommercialPdf } from "@/components/documents/commercial-pdf";
import { db } from "@/lib/db";
import { buildPdfModel } from "@/modules/documents/pdf-models";
import { createPayment } from "@/modules/payables/payments";
import { createPo, poAction } from "@/modules/procurement/po";
import { clientInvoiceAction, createClientInvoice } from "@/modules/sales/invoice";
import { certifyRaBill, getRaBill, raBillAction } from "@/modules/sales/ra-bill";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { generateSoRunningBill } from "@/modules/sales/so-running-bill";
import { issueMaterialToSite } from "@/modules/stores/site-issue";
import { commercialFixture, day, key, receiveWithProof } from "./commercial-helpers";

/**
 * Workflow v2 · Phase 9 — renders the revised-workflow PDFs from real records (PO, site challan, running
 * bill, client receipt, project accounts statement). Set RENDER_PDF_DIR to keep the files for review.
 */
type M = "purchaseOrder" | "grn" | "salesOrder" | "raBill" | "clientInvoice";
const v = async (model: M, id: string) => (await (db[model] as unknown as { findUniqueOrThrow: (a: object) => Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } })).version;

describe("revised workflow PDFs", () => {
  it("render PO, challan, running bill, receipt and accounts statement", { timeout: 120_000 }, async () => {
    const fx = await commercialFixture();
    const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, orderDate: day(-3), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "300", rate: "1000", gstRate: "18" }] });
    await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await v("salesOrder", so.id) });

    // General-stock PO → warehouse, then issue to site with a challan received with proof.
    const po = await createPo(fx.roles.pu.actor, { projectId: null, partyId: fx.supplier.id, orderDate: day(-2), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "150", rate: "400", gstRate: "18" }] });
    await poAction(fx.actors.admin, po.id, "finalize", { version: await v("purchaseOrder", po.id) });
    const pl = await db.poLine.findFirstOrThrow({ where: { poId: po.id } });
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(-1), lines: [{ poLineId: pl.id, receivedQty: "150" }] });
    const ch = await issueMaterialToSite(fx.roles.sk.actor, { projectId: fx.p1.id, fromLocationId: fx.warehouse.id, clientKey: key(), lines: [{ itemBrandId: fx.ibUltra.id, quantity: "100" }] });
    const cl = await db.challanLine.findFirstOrThrow({ where: { challanId: ch.id } });
    await receiveWithProof(fx.roles.se.actor, { clientKey: key(), challanId: ch.id, receiptDate: day(), lines: [{ challanLineId: cl.id, receivedQty: "100" }] });

    // Cumulative running bill → invoice → part payment.
    const rb = await generateSoRunningBill(fx.roles.pm.actor, { soId: so.id });
    await raBillAction(fx.roles.pm.actor, rb.id, "submit_review", { version: await v("raBill", rb.id) });
    const view = await getRaBill(fx.actors.admin, rb.id);
    await certifyRaBill(fx.roles.ac.actor, rb.id, await v("raBill", rb.id), { clientCertRef: "C-1", clientCertDate: day(), lines: view.bill.lines.map((l) => ({ lineId: l.id, certifiedQty: l.claimedQty })) });
    const inv = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: rb.id, invoiceDate: day() });
    await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await v("clientInvoice", inv.id) });
    const rcpt = await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", reference: "UTR-77812", amount: "75000", idempotencyKey: key(), allocations: [{ documentId: inv.id, amount: "75000" }] });

    const out = process.env.RENDER_PDF_DIR;
    if (out) mkdirSync(out, { recursive: true });
    const docs: [string, string][] = [["purchase_order", po.id], ["challan", ch.id], ["ra_bill", rb.id], ["payment", rcpt.id], ["project_accounts", fx.p1.id]];
    for (const [type, id] of docs) {
      const doc = await buildPdfModel(fx.actors.admin, type, id);
      const buf = await renderToBuffer(createElement(CommercialPdf, { doc }) as Parameters<typeof renderToBuffer>[0]);
      expect(Buffer.from(buf).subarray(0, 4).toString()).toBe("%PDF");
      if (out) writeFileSync(join(out, `${type}.pdf`), buf);
    }
    const po2 = await buildPdfModel(fx.actors.admin, "purchase_order", po.id);
    expect(po2.panels[1]!.heading).toBe("General stock (no project)");
    const dc = await buildPdfModel(fx.actors.admin, "challan", ch.id);
    expect(dc.sections?.some((s) => s.title === "On receipt at site")).toBe(true);
    const acc = await buildPdfModel(fx.actors.admin, "project_accounts", fx.p1.id);
    expect(acc.rows.length).toBeGreaterThan(3);
    // Accounts statement needs accounts.view.
    await expect(buildPdfModel(fx.roles.se.actor, "project_accounts", fx.p1.id)).rejects.toThrow();
  });
});
