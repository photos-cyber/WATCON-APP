import "server-only";
import { db, type Prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { addMoney, cmpMoney, qtyTimesRate, subMoney } from "@/lib/money";
import { canAny, type Actor } from "@/lib/permissions/definitions";
import { ForbiddenError } from "@/lib/errors";
import { assertProjectVisible, dec2, projectRequiredScoped } from "@/modules/commercial/core";
import { TRIGGERS, type Trigger } from "@/modules/commercial/payment-terms";
import { startOfToday } from "@/modules/tasks/rules";
import { RA_CERTIFIED } from "./shared";
import { soBillingPosition } from "./so-running-bill";

/**
 * Client account position for a project (or one sales order) — workflow v2 · Phase 7.
 *
 *   contractValue         confirmed sales orders (client PO optional) + legacy active client POs that
 *                         have no confirmed sales order (incl. GST) — never both for the same contract
 *                         (one sales order: its total)
 *   invoiced              issued tax invoices, gross (proformas are requests, not billing)
 *   received              receipts allocated to tax invoices
 *   outstandingBilled     issued tax invoices: net receivable − received − credit notes
 *   overdue               part of outstandingBilled past its due date
 *   unbilled              contract − invoiced
 *   clientAdvances        money held, not yet set against a tax invoice:
 *                         unallocated receipts (after refunds) + proforma receipts not yet adjusted
 *   paymentReceived       all money received (allocated + advances held + advances already adjusted)
 *   remainingContract     contract − paymentReceived  (what the client still has to pay overall)
 *   nextMilestone         first payment milestone not yet covered by the money received
 *
 * Each rupee is counted once: an advance moves from "client advances" to "received" when it is
 * allocated or adjusted, so the totals never double-count it.
 */
export type ClientAccount = {
  scope: "PROJECT" | "SALES_ORDER";
  contractValue: string;
  invoiced: string;
  received: string;
  outstandingBilled: string;
  overdue: string;
  unbilled: string;
  clientAdvances: string;
  unallocatedReceipts: string;
  paymentReceived: string;
  remainingContract: string;
  /** Material delivered (site receipts / client deliveries) at sales-order selling rates, excl. GST. */
  deliveredValue: string;
  /** Live running bills (certified amount once certified, else claimed), excl. GST — shown, not added to invoiced. */
  runningBillValue: string;
  nextMilestone: { soNumber: string; label: string; amount: string; dueNow: string; trigger: string; dueDate: string | null } | null;
  clients: { id: string; name: string }[];
};

const max0 = (v: string) => (cmpMoney(v, "0") > 0 ? v : "0.00");
const SO_ACTIVE = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] as const;

export async function clientAccount(actor: Actor, opts: { projectId: string; soId?: string | null }): Promise<ClientAccount> {
  if (!canAny(actor, "invoice.view", "payments.view", "so.view")) throw new ForbiddenError();
  await assertProjectVisible(actor, opts.projectId);
  const org = actor.organizationId;
  let contract: string;
  let sos: { id: string; number: string; partyId: string; milestones: { label: string; amount: Prisma.Decimal; trigger: string; dueDate: Date | null; sortOrder: number }[] }[];
  if (opts.soId) {
    const so = await db.salesOrder.findFirst({ where: { AND: [{ id: opts.soId, projectId: opts.projectId }, projectRequiredScoped(actor) as Prisma.SalesOrderWhereInput] }, include: { milestones: true } });
    if (!so) throw new NotFoundError("Sales order");
    contract = dec2(so.total);
    sos = [so];
  } else {
    const [cpo, soRows] = await Promise.all([
      db.clientPo.aggregate({ where: { organizationId: org, projectId: opts.projectId, status: { in: ["ACTIVE", "COMPLETED"] }, salesOrders: { none: { status: { in: [...SO_ACTIVE] } } } }, _sum: { total: true } }),
      db.salesOrder.findMany({ where: { organizationId: org, projectId: opts.projectId, status: { in: [...SO_ACTIVE] } }, include: { milestones: true }, orderBy: { orderDate: "asc" } }),
    ]);
    contract = addMoney(dec2(cpo._sum.total), ...soRows.map((s) => dec2(s.total)));
    sos = soRows;
  }
  const invWhere: Prisma.ClientInvoiceWhereInput = { organizationId: org, projectId: opts.projectId, status: { not: "CANCELLED" }, ...(opts.soId ? { soId: opts.soId } : {}) };
  const [invoices, receipts] = await Promise.all([
    db.clientInvoice.findMany({ where: invWhere, select: { id: true, soId: true, kind: true, status: true, dueDate: true, total: true, netReceivable: true, receivedAmount: true, adjustedAmount: true, advanceRecovery: true } }),
    db.payment.findMany({ where: { organizationId: org, projectId: opts.projectId, direction: "IN", status: "POSTED", ...(opts.soId ? { soId: opts.soId } : {}) }, select: { amount: true, tdsAmount: true, allocatedAmount: true, refundedAmount: true, party: { select: { id: true, name: true } } } }),
  ]);
  const today = startOfToday();
  const tax = invoices.filter((i) => i.kind === "TAX_INVOICE" && i.status !== "DRAFT");
  const proformas = invoices.filter((i) => i.kind === "PROFORMA");
  const outstandingOf = (i: (typeof tax)[number]) => max0(subMoney(subMoney(dec2(i.netReceivable), dec2(i.receivedAmount)), dec2(i.adjustedAmount)));
  const invoiced = addMoney("0", ...tax.map((i) => dec2(i.total)));
  const received = addMoney("0", ...tax.map((i) => dec2(i.receivedAmount)));
  const outstandingBilled = addMoney("0", ...tax.map(outstandingOf));
  const overdue = addMoney("0", ...tax.filter((i) => i.dueDate && i.dueDate < today).map(outstandingOf));
  const proformaReceived = addMoney("0", ...proformas.map((i) => dec2(i.receivedAmount)));
  const advanceAdjusted = addMoney("0", ...tax.map((i) => dec2(i.advanceRecovery)));
  // One order: only receipts recorded against that order count (their unallocated part is its advance).
  // Project: every receipt. An allocated rupee sits in "received", the rest in advances — never both.
  const unallocatedReceipts = addMoney("0", ...receipts.map((p) => max0(subMoney(subMoney(addMoney(dec2(p.amount), dec2(p.tdsAmount)), dec2(p.allocatedAmount)), dec2(p.refundedAmount)))));
  const proformaHeld = max0(subMoney(proformaReceived, advanceAdjusted));
  const clientAdvances = addMoney(unallocatedReceipts, proformaHeld);
  const paymentReceived = addMoney(received, proformaReceived, unallocatedReceipts);

  // Delivered value and running bills, per confirmed order (each order's own lines / bills; nothing shared).
  const [positions, raBills] = await Promise.all([
    Promise.all(sos.map((so) => soBillingPosition(db, so.id).then((p) => p.lines))),
    db.raBill.findMany({ where: { organizationId: org, projectId: opts.projectId, status: { not: "CANCELLED" }, ...(opts.soId ? { soId: opts.soId } : {}) }, select: { status: true, claimedAmount: true, certifiedAmount: true } }),
  ]);
  const deliveredValue = addMoney("0", ...positions.flat().filter((l) => l.kind === "MATERIAL").map((l) => qtyTimesRate(l.delivered, l.rate)));
  const runningBillValue = addMoney("0", ...raBills.map((b) => ((RA_CERTIFIED as readonly string[]).includes(b.status) ? dec2(b.certifiedAmount) : dec2(b.claimedAmount))));

  // Next payment milestone: walk the schedules in order until the money received no longer covers them.
  let nextMilestone: ClientAccount["nextMilestone"] = null;
  let cash = paymentReceived;
  for (const so of sos) {
    const own = opts.soId ? cash : addMoney(...invoices.filter((i) => i.soId === so.id).map((i) => dec2(i.receivedAmount)));
    let covered = own;
    for (const m of [...so.milestones].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const amt = dec2(m.amount);
      if (cmpMoney(covered, amt) >= 0) {
        covered = subMoney(covered, amt);
        continue;
      }
      nextMilestone = { soNumber: so.number, label: m.label, amount: amt, dueNow: subMoney(amt, covered), trigger: TRIGGERS[m.trigger as Trigger] ?? m.trigger, dueDate: m.dueDate?.toISOString().slice(0, 10) ?? null };
      break;
    }
    if (nextMilestone) break;
    if (opts.soId) cash = "0";
  }

  return {
    scope: opts.soId ? "SALES_ORDER" : "PROJECT",
    contractValue: contract,
    invoiced,
    received,
    outstandingBilled,
    overdue,
    unbilled: max0(subMoney(contract, invoiced)),
    clientAdvances,
    unallocatedReceipts,
    paymentReceived,
    remainingContract: max0(subMoney(contract, paymentReceived)),
    deliveredValue,
    runningBillValue,
    nextMilestone,
    clients: [...new Map(receipts.map((r) => [r.party.id, r.party])).values()],
  };
}
