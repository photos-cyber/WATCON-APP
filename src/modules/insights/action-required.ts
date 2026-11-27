import "server-only";
import { db } from "@/lib/db";
import { addMoney, cmpMoney, cmpQty, qtyTimesRate, subMoney } from "@/lib/money";
import { can, canAny, type Actor } from "@/lib/permissions/definitions";
import { assertProjectVisible, dec2 } from "@/modules/commercial/core";
import { getMrp } from "@/modules/planning/service";
import { clientAccount } from "@/modules/sales/client-account";
import { soBillingPosition } from "@/modules/sales/so-running-bill";
import { evaluateProof } from "@/modules/stores/proof-rules";

/**
 * Project "Action required" (workflow v2 · Phase 9): one card per next job, each opening the records
 * it counts. Only cards the user may act on / see are returned; empty ones are kept (count 0) so the
 * layout is stable and "all clear" is visible.
 */
export type ActionCard = { key: string; label: string; count: number; amount?: string | null; detail: string; href: string; tone: "action" | "warn" | "bad" | "done" };

export async function projectActionRequired(actor: Actor, projectId: string): Promise<ActionCard[]> {
  await assertProjectVisible(actor, projectId);
  const org = actor.organizationId;
  const w = { organizationId: org, projectId };
  const t = (tab: string, extra = "") => `/projects/${projectId}?tab=${tab}${extra}`;
  const cards: ActionCard[] = [];

  const [plan, pendingPos, drafts, account, bills, sos] = await Promise.all([
    can(actor, "mrp.view") ? getMrp(actor, { projectId, view: "open" }) : Promise.resolve(null),
    can(actor, "po.view") ? db.purchaseOrder.findMany({ where: { ...w, status: { in: ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] } }, select: { id: true, lines: { select: { quantity: true, acceptedQty: true } } } }) : Promise.resolve(null),
    can(actor, "grn.view") ? db.grn.findMany({ where: { ...w, status: { in: ["DRAFT", "REJECTED"] } }, select: { id: true, poId: true, challanId: true, lines: { select: { damagedQty: true, rejectedQty: true } } } }) : Promise.resolve(null),
    canAny(actor, "invoice.view", "payments.view") ? clientAccount(actor, { projectId }).catch(() => null) : Promise.resolve(null),
    can(actor, "bills.view") ? db.supplierBill.findMany({ where: { ...w, status: { in: ["APPROVED", "PARTIALLY_PAID"] } }, select: { netPayable: true, paidAmount: true, adjustedAmount: true, dueDate: true } }) : Promise.resolve(null),
    can(actor, "rabill.view") ? db.salesOrder.findMany({ where: { ...w, status: { in: ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] } }, select: { id: true, number: true } }) : Promise.resolve(null),
  ]);

  if (plan) {
    const toOrder = plan.rows.filter((r) => cmpQty(r.toOrder, "0") > 0);
    const value = addMoney("0", ...toOrder.map((r) => r.estimatedCost ?? "0"));
    cards.push({ key: "order", label: "Materials needing ordering", count: toOrder.length, amount: toOrder.length ? value : null, detail: toOrder.length ? "Not covered by stock or open orders — request rates or raise a PO" : "Everything planned is covered", href: t("planning", "&status=TO_ORDER"), tone: toOrder.length ? "action" : "done" });
    if (can(actor, "stock.transfer")) {
      const ready = plan.rows.filter((r) => Number(r.requiredQty) - Number(r.issuedQty) > 0 && Number(r.freeStock) + Number(r.projectReserved) > 0);
      cards.push({ key: "issue", label: "Materials ready to issue", count: ready.length, detail: ready.length ? "In the warehouse and still needed at site" : "Nothing in stock waiting to go to site", href: `/projects/${projectId}/issue`, tone: ready.length ? "action" : "done" });
    }
  }
  if (pendingPos) {
    const open = pendingPos.filter((p) => p.lines.some((l) => cmpQty(dec2(l.quantity), dec2(l.acceptedQty)) > 0));
    cards.push({ key: "delivery", label: "POs awaiting delivery", count: open.length, detail: open.length ? "Approved orders with material still to arrive" : "No deliveries pending", href: `/purchase-orders?projectId=${projectId}&pending=1`, tone: open.length ? "warn" : "done" });
  }
  if (drafts) {
    const files = drafts.length ? await db.attachment.findMany({ where: { organizationId: org, entityType: "grn", entityId: { in: drafts.map((d) => d.id) }, deletedAt: null }, select: { entityId: true, id: true, category: true, mimeType: true, fileName: true } }) : [];
    const missing = drafts.filter((d) => !evaluateProof({ poId: d.poId, challanId: d.challanId, lines: d.lines.map((l) => ({ damagedQty: String(l.damagedQty), rejectedQty: String(l.rejectedQty) })) }, files.filter((f) => f.entityId === d.id)).complete);
    cards.push({ key: "proof", label: "Receipts awaiting proof", count: missing.length, detail: missing.length ? "Photos or signed challan still to upload before submitting" : "No receipts waiting for proof", href: `/site-receipts?projectId=${projectId}&status=DRAFT`, tone: missing.length ? "bad" : "done" });
  }
  if (sos) {
    let lines = 0;
    let value = "0.00";
    let only: string | null = null;
    const positions = await Promise.all(sos.map((so) => soBillingPosition(db, so.id)));
    for (const [i, so] of sos.entries()) {
      const pos = positions[i]!.lines.filter((l) => l.kind === "MATERIAL" && cmpQty(l.billable, "0") > 0);
      if (!pos.length) continue;
      lines += pos.length;
      only = only === null ? so.id : "many";
      value = addMoney(value, ...pos.map((l) => qtyTimesRate(l.billable, l.rate)));
    }
    cards.push({ key: "billing", label: "Deliveries ready for billing", count: lines, amount: lines ? value : null, detail: lines ? "Material received at site / delivered and not yet on a running bill" : "All delivered material is billed", href: only && only !== "many" ? `/running-bills/new?soId=${only}` : t("running-bills"), tone: lines ? "action" : "done" });
  }
  if (account) {
    const due = cmpMoney(account.outstandingBilled, "0") > 0;
    cards.push({ key: "client", label: "Client outstanding", count: due ? 1 : 0, amount: account.outstandingBilled, detail: cmpMoney(account.overdue, "0") > 0 ? `₹${account.overdue} overdue` : due ? "Issued invoices not yet paid" : "Nothing outstanding", href: `/client-invoices?projectId=${projectId}&outstanding=1`, tone: cmpMoney(account.overdue, "0") > 0 ? "bad" : due ? "warn" : "done" });
  }
  if (bills) {
    const today = new Date();
    const open = bills.map((b) => ({ due: b.dueDate, left: subMoney(subMoney(dec2(b.netPayable), dec2(b.paidAmount)), dec2(b.adjustedAmount)) })).filter((b) => cmpMoney(b.left, "0") > 0);
    const overdue = open.filter((b) => b.due && b.due < today);
    cards.push({ key: "supplier", label: "Supplier payments due", count: open.length, amount: open.length ? addMoney("0", ...open.map((b) => b.left)) : null, detail: overdue.length ? `${overdue.length} past due date` : open.length ? "Approved bills not yet paid" : "No supplier bills due", href: `/supplier-bills?projectId=${projectId}&view=unpaid`, tone: overdue.length ? "bad" : open.length ? "warn" : "done" });
  }
  return cards;
}
