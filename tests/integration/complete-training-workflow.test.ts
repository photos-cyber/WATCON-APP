import { mkdirSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { db } from "@/lib/db";
import { createItem, createBrand, linkBrand } from "@/modules/inventory/service";
import { createPo, poAction } from "@/modules/procurement/po";
import { createGrn, postGrn } from "@/modules/stores/grn";
import { billAction, billPrefillFromPo, createBill } from "@/modules/payables/bills";
import { createPayment } from "@/modules/payables/payments";
import { createClientPo, clientPoAction } from "@/modules/sales/client-po";
import { createSalesOrder, salesOrderAction } from "@/modules/sales/sales-order";
import { createChallan, challanAction } from "@/modules/stores/challan";
import { createRaBill, raBillAction, certifyRaBill } from "@/modules/sales/ra-bill";
import { createClientInvoice, clientInvoiceAction } from "@/modules/sales/invoice";
import { projectFinancials } from "@/modules/insights/finance";
import { buildPdfModel } from "@/modules/documents/pdf-models";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { CommercialPdf } from "@/components/documents/commercial-pdf";
import { commercialFixture, day, key } from "./commercial-helpers";

it("ABC Hotel: partial supplier receipts, bill, deliveries, certified RA, invoice and two-sided settlement reconcile", async () => {
  const fx = await commercialFixture();
  await db.project.update({ where: { id: fx.p1.id }, data: { name: "ABC Hotel Swimming Pool Installation" } });
  const item = await createItem(fx.actors.admin, { name: "Training pool filter", unit: "Nos" });
  const brand = await createBrand(fx.actors.admin, { name: "Training brand" });
  const ib = await linkBrand(fx.actors.superAdmin, { itemId: item.id, brandId: brand.id, openingQty: "0", openingDate: day(-1) });
  const version = async (model: string, id: string) => {
    const row = await (db[model as "purchaseOrder"] as unknown as { findUniqueOrThrow(a: object): Promise<{ version: number }> }).findUniqueOrThrow({ where: { id } });
    return row.version;
  };
  const stock = async () => (await db.itemBrand.findUniqueOrThrow({ where: { id: ib.id } })).currentQty.toFixed(3);
  const po = await createPo(fx.roles.pu.actor, { projectId: fx.p1.id, partyId: fx.supplier.id, deliveryLocationId: fx.warehouse.id, orderDate: day(), lines: [{ itemBrandId: ib.id, quantity: "10", rate: "1000", gstRate: "18" }] });
  await poAction(fx.roles.pu.actor, po.id, "submit", { version: await version("purchaseOrder", po.id) });
  await poAction(fx.actors.admin, po.id, "approve", { version: await version("purchaseOrder", po.id) });
  expect(await stock()).toBe("0.000");
  const pl = await db.poLine.findFirstOrThrow({ where: { poId: po.id } });
  for (const qty of ["6", "4"]) {
    const g = await createGrn(fx.roles.se.actor, { clientKey: key(), poId: po.id, receiptDate: day(), submit: true, lines: [{ poLineId: pl.id, receivedQty: qty }] });
    await postGrn(fx.roles.sk.actor, g.id, await version("grn", g.id));
  }
  expect(await stock()).toBe("10.000");
  const pref = await billPrefillFromPo(fx.roles.ac.actor, po.id);
  const bill = await createBill(fx.roles.ac.actor, { poId: po.id, supplierInvoiceNo: "TRAINING-ABC-001", invoiceDate: day(), lines: pref.lines });
  await billAction(fx.roles.ac.actor, bill.id, "submit", { version: await version("supplierBill", bill.id) });
  await billAction(fx.actors.admin, bill.id, "approve", { version: await version("supplierBill", bill.id) });
  expect(bill.total.toFixed(2)).toBe("11800.00");
  expect(await stock()).toBe("10.000"); // bills never double-post a GRN
  const cpo = await createClientPo(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoNumber: "ABC-TRAINING-001", poDate: day(), placeOfSupply: "27", lines: [{ itemId: item.id, description: "Pool filters", unit: "Nos", quantity: "10", rate: "1500", gstRate: "18" }] });
  await clientPoAction(fx.roles.pm.actor, cpo.id, "submit", { version: await version("clientPo", cpo.id) });
  await clientPoAction(fx.actors.admin, cpo.id, "approve", { version: await version("clientPo", cpo.id) });
  const cl = await db.clientPoLine.findFirstOrThrow({ where: { clientPoId: cpo.id } });
  const so = await createSalesOrder(fx.roles.pm.actor, { projectId: fx.p1.id, partyId: fx.client.id, clientPoId: cpo.id, orderDate: day(), lines: [{ clientPoLineId: cl.id, itemBrandId: ib.id, quantity: "10", rate: "1500", gstRate: "18" }] });
  await salesOrderAction(fx.roles.pm.actor, so.id, "submit", { version: await version("salesOrder", so.id) });
  await salesOrderAction(fx.actors.admin, so.id, "approve", { version: await version("salesOrder", so.id) });
  expect(await stock()).toBe("10.000");
  const sl = await db.soLine.findFirstOrThrow({ where: { soId: so.id } });
  for (const qty of ["4", "6"]) {
    const c = await createChallan(fx.roles.sk.actor, { type: "CLIENT_DELIVERY", projectId: fx.p1.id, soId: so.id, partyId: fx.client.id, fromLocationId: fx.warehouse.id, dispatchDate: day(), lines: [{ itemBrandId: ib.id, quantity: qty, soLineId: sl.id }] });
    await challanAction(fx.roles.sk.actor, c.id, "dispatch", { version: await version("challan", c.id) });
  }
  expect(await stock()).toBe("0.000");
  const ra = await createRaBill(fx.roles.se.actor, { clientPoId: cpo.id, billDate: day(), periodFrom: day(), periodTo: day(), lines: [{ clientPoLineId: cl.id, claimedQty: "10" }] });
  await raBillAction(fx.roles.se.actor, ra.id, "submit_review", { version: await version("raBill", ra.id) });
  await raBillAction(fx.roles.pm.actor, ra.id, "approve", { version: await version("raBill", ra.id) });
  const rl = await db.raBillLine.findFirstOrThrow({ where: { raBillId: ra.id } });
  await certifyRaBill(fx.roles.ac.actor, ra.id, await version("raBill", ra.id), { clientCertRef: "ABC-CERT-001", clientCertDate: day(), lines: [{ lineId: rl.id, certifiedQty: "10" }] });
  const inv = await createClientInvoice(fx.roles.ac.actor, { source: "RA", raBillId: ra.id, invoiceDate: day() });
  await clientInvoiceAction(fx.actors.admin, inv.id, "issue", { version: await version("clientInvoice", inv.id) });
  expect(inv.total.toFixed(2)).toBe("17700.00");
  for (const amount of ["7080", "10620"]) await createPayment(fx.roles.ac.actor, { direction: "IN", partyId: fx.client.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", amount, idempotencyKey: key(), allocations: [{ documentId: inv.id, amount }] });
  for (const amount of ["5000", "6800"]) await createPayment(fx.roles.ac.actor, { direction: "OUT", partyId: fx.supplier.id, projectId: fx.p1.id, paymentDate: day(), mode: "BANK_TRANSFER", amount, idempotencyKey: key(), allocations: [{ documentId: bill.id, amount }] });
  const fin = (await projectFinancials(fx.org.id, [fx.p1.id])).get(fx.p1.id)!;
  expect({ receivable: fin.receivable, payable: fin.payable, margin: fin.margin, billed: fin.billed, received: fin.received, paid: fin.paid, contract: fin.contractValue }).toEqual({ receivable: "0.00", payable: "0.00", margin: "5000.00", billed: "17700.00", received: "17700.00", paid: "11800.00", contract: "17700.00" });
  if (process.env.AUDIT_TRAINING_EVIDENCE === "1") {
    const dir = "docs/audit/evidence/training";
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/reconciliation.json`, JSON.stringify({ project: "ABC Hotel Swimming Pool Installation", stock: await stock(), financials: fin, ids: { project: fx.p1.id, po: po.id, so: so.id, cpo: cpo.id, ra: ra.id, invoice: inv.id, bill: bill.id } }, null, 2));
    for (const [type, id] of [["purchase_order", po.id], ["client_po", cpo.id], ["sales_order", so.id], ["ra_bill", ra.id], ["client_invoice", inv.id], ["supplier_bill", bill.id]]) {
      const doc = await buildPdfModel(fx.actors.superAdmin, type, id);
      writeFileSync(`${dir}/${type}.pdf`, Buffer.from(await renderToBuffer(createElement(CommercialPdf, { doc }) as Parameters<typeof renderToBuffer>[0])));
    }
  }
}, 120_000);
