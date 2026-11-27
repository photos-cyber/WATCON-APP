import "server-only";
import { db } from "@/lib/db";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { assertProjectVisible, dec2 } from "@/modules/commercial/core";
import { startOfToday } from "@/modules/tasks/rules";
import { listApprovals } from "./approvals";
import { projectFinancials } from "./finance";

/**
 * Read-only views behind the project workspace: one project, every commercial document type.
 * The project's visibility is asserted first (invisible → 404), and every query is filtered
 * to that project, so module records follow the same project scoping as their own pages.
 */

export type DocKind = "pr" | "rfq" | "po" | "grn" | "challan" | "bill" | "payment" | "note" | "cpo" | "so" | "rabill" | "invoice" | "receipt";

export type DocRow = {
  id: string;
  number: string;
  href: string;
  date: string | null;
  title: string | null;
  party: string | null;
  status: string;
  amount: string | null;
  secondary: string | null;
  overdue: boolean;
};

type KindDef = {
  label: string;
  plural: string;
  view: PermissionKey;
  create: PermissionKey | null;
  path: string;
  newHref: ((projectId: string) => string) | null;
  newLabel: string | null;
  about: string;
};

export const DOC_KINDS: Record<DocKind, KindDef> = {
  pr: { label: "Requisition", plural: "Purchase requisitions", view: "pr.view", create: "pr.create", path: "/purchase-requisitions", newHref: (p) => `/purchase-requisitions/new?projectId=${p}`, newLabel: "New requisition", about: "Site and store requests for material. Once approved, purchasing gets rates or raises a purchase order." },
  rfq: { label: "Rate enquiry", plural: "Rate enquiries", view: "rfq.view", create: "rfq.manage", path: "/rate-enquiries", newHref: (p) => `/rate-enquiries/new?projectId=${p}`, newLabel: "New rate enquiry", about: "Ask several suppliers for prices, compare quotations side by side and award the best offer." },
  po: { label: "Purchase order", plural: "Purchase orders", view: "po.view", create: "po.create", path: "/purchase-orders", newHref: (p) => `/purchase-orders/new?projectId=${p}`, newLabel: "New purchase order", about: "Orders placed on suppliers for this project. Approved orders appear as pending deliveries at site." },
  grn: { label: "Site receipt", plural: "Site receipts (GRN)", view: "grn.view", create: "grn.create", path: "/site-receipts", newHref: (p) => `/site-receipts?projectId=${p}`, newLabel: "Receive material", about: "Material received at site against a purchase order or transfer — with photos, signed challan and accepted / rejected quantities." },
  challan: { label: "Challan", plural: "Delivery challans", view: "grn.view", create: "stock.transfer", path: "/challans", newHref: (p) => `/challans/new?projectId=${p}`, newLabel: "New challan", about: "Material moved from the warehouse or another site to this project, returned to store or supplier, or delivered to the client." },
  bill: { label: "Supplier bill", plural: "Supplier bills", view: "bills.view", create: "bills.manage", path: "/supplier-bills", newHref: (p) => `/supplier-bills/new?projectId=${p}`, newLabel: "Enter supplier bill", about: "Supplier invoices for this project, matched against the purchase order and site receipts before payment." },
  payment: { label: "Payment", plural: "Supplier payments", view: "payments.view", create: "payments.manage", path: "/payments", newHref: (p) => `/payments/new?direction=OUT&projectId=${p}`, newLabel: "Record payment", about: "Money paid to suppliers for this project. Unallocated amounts are kept as supplier advances." },
  note: { label: "Note", plural: "Credit / debit notes", view: "bills.view", create: "bills.manage", path: "/notes", newHref: (p) => `/notes/new?projectId=${p}`, newLabel: "New note", about: "Adjustments to supplier bills or client invoices — price differences, returns or short supplies." },
  cpo: { label: "Client PO", plural: "Client purchase orders", view: "cpo.view", create: "cpo.manage", path: "/client-pos", newHref: (p) => `/client-pos/new?projectId=${p}`, newLabel: "New client PO", about: "The client's order or contract for this project — the ceiling for everything that can be billed." },
  so: { label: "Sales order", plural: "Sales orders", view: "so.view", create: "so.manage", path: "/sales-orders", newHref: (p) => `/sales-orders/new?projectId=${p}`, newLabel: "New sales order", about: "Supply orders drawn from the client PO. They drive deliveries to the client and supply invoices." },
  rabill: { label: "Running bill", plural: "Running bills (RA)", view: "rabill.view", create: "rabill.manage", path: "/running-bills", newHref: (p) => `/running-bills/new?projectId=${p}`, newLabel: "New running bill", about: "Periodic bills of work done, claimed against the client PO and certified by the client." },
  invoice: { label: "Invoice", plural: "Client invoices", view: "invoice.view", create: "invoice.manage", path: "/client-invoices", newHref: (p) => `/client-invoices/new?projectId=${p}`, newLabel: "New invoice", about: "GST tax invoices raised on the client for certified running bills or supplies." },
  receipt: { label: "Receipt", plural: "Client receipts", view: "payments.view", create: "payments.manage", path: "/payments", newHref: (p) => `/payments/new?direction=IN&projectId=${p}`, newLabel: "Record receipt", about: "Money received from the client for this project, allocated to invoices. TDS deducted by the client counts as received." },
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date) => d.toISOString().slice(0, 10);
export const DOC_PAGE_SIZE = 25;

/** Status values per document kind (for the tab status filter). */
export const DOC_STATUSES: Record<DocKind, string[]> = {
  pr: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PARTIALLY_ORDERED", "ORDERED", "CLOSED", "CANCELLED"],
  rfq: ["DRAFT", "SENT", "RESPONSES_IN", "AWARD_PENDING", "AWARDED", "CLOSED", "CANCELLED"],
  po: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "CANCELLED"],
  grn: ["DRAFT", "SUBMITTED", "POSTED", "REJECTED", "CANCELLED", "REVERSED"],
  challan: ["DRAFT", "DISPATCHED", "PARTIALLY_RECEIVED", "RECEIVED", "DELIVERED", "CLOSED", "CANCELLED"],
  bill: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "PARTIALLY_PAID", "PAID", "CANCELLED"],
  payment: ["POSTED", "CANCELLED"],
  receipt: ["POSTED", "CANCELLED"],
  note: ["DRAFT", "APPROVED", "CANCELLED"],
  cpo: ["DRAFT", "PENDING_APPROVAL", "ACTIVE", "REJECTED", "COMPLETED", "CLOSED", "CANCELLED"],
  so: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED", "CANCELLED"],
  rabill: ["DRAFT", "INTERNAL_REVIEW", "SUBMITTED", "CLIENT_CERTIFIED", "DISPUTED", "INVOICED", "PARTIALLY_PAID", "PAID", "CANCELLED"],
  invoice: ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "CANCELLED"],
};

/** What counts as "needs action" per kind, shown as a badge on the tab (e.g. "3 to finalize"). */
export const DOC_PENDING: Partial<Record<DocKind, { statuses: string[]; label: string }>> = {
  pr: { statuses: ["DRAFT", "SUBMITTED"], label: "to finalize" },
  rfq: { statuses: ["AWARD_PENDING"], label: "award to confirm" },
  po: { statuses: ["DRAFT", "PENDING_APPROVAL"], label: "to finalize" },
  grn: { statuses: ["DRAFT", "SUBMITTED"], label: "to confirm" },
  challan: { statuses: ["DISPATCHED"], label: "in transit" },
  bill: { statuses: ["DRAFT", "PENDING_APPROVAL"], label: "to finalize" },
  note: { statuses: ["DRAFT"], label: "drafts" },
  cpo: { statuses: ["DRAFT", "PENDING_APPROVAL"], label: "to finalize" },
  so: { statuses: ["DRAFT", "PENDING_APPROVAL"], label: "to confirm" },
  rabill: { statuses: ["DRAFT", "INTERNAL_REVIEW"], label: "to submit" },
  invoice: { statuses: ["DRAFT"], label: "drafts" },
};

export type DocListQuery = { q?: string; status?: string; page?: number; pageSize?: number };
export type DocPage = { rows: DocRow[]; total: number; page: number; pageSize: number };

const contains = (v: string) => ({ contains: v, mode: "insensitive" as const });

/** One project's documents of one kind: search, status filter and pagination (newest first). */
export async function listProjectDocs(actor: Actor, projectId: string, kind: DocKind, query: DocListQuery = {}): Promise<DocPage> {
  const pageSize = Math.min(100, Math.max(5, Math.floor(query.pageSize ?? DOC_PAGE_SIZE) || DOC_PAGE_SIZE));
  const page = Math.max(1, Math.floor(query.page ?? 1) || 1);
  if (!can(actor, DOC_KINDS[kind].view)) return { rows: [], total: 0, page, pageSize };
  await assertProjectVisible(actor, projectId);
  const q = query.q?.trim().slice(0, 100) || undefined;
  const status = query.status && DOC_STATUSES[kind].includes(query.status) ? query.status : undefined;
  const base = { organizationId: actor.organizationId, projectId, ...(status ? { status: status as never } : {}) };
  const skip = (page - 1) * pageSize;
  const path = DOC_KINDS[kind].path;
  const today = startOfToday();
  const party = q ? [{ party: { is: { name: contains(q) } } }] : [];
  const or = (...extra: object[]) => (q ? { OR: [{ number: contains(q) }, ...party, ...extra] } : {});
  const out = async <T>(where: object, count: (a: { where: never }) => Promise<number>, find: () => Promise<T[]>, map: (r: T) => DocRow): Promise<DocPage> => {
    const [total, rows] = await Promise.all([count({ where: where as never }), find()]);
    return { rows: rows.map(map), total, page, pageSize };
  };

  switch (kind) {
    case "pr": {
      const where = { ...base, ...(q ? { OR: [{ number: contains(q) }, { purpose: contains(q) }] } : {}) };
      return out(where, (a) => db.purchaseRequisition.count(a), () => db.purchaseRequisition.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize, include: { _count: { select: { lines: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.createdAt), title: r.purpose, party: null, status: r.status, amount: null, secondary: `${r._count.lines} line${r._count.lines === 1 ? "" : "s"}${r.requiredBy ? ` · needed by ${day(r.requiredBy)}` : ""}`, overdue: false }));
    }
    case "rfq": {
      const where = { ...base, ...(q ? { OR: [{ number: contains(q) }, { title: contains(q) }] } : {}) };
      return out(where, (a) => db.rfq.count(a), () => db.rfq.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize, include: { _count: { select: { suppliers: true, quotations: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.createdAt), title: r.title, party: null, status: r.status, amount: null, secondary: `${r._count.quotations} of ${r._count.suppliers} suppliers quoted`, overdue: false }));
    }
    case "po": {
      const where = { ...base, ...or() };
      return out(where, (a) => db.purchaseOrder.count(a), () => db.purchaseOrder.findMany({ where, orderBy: { orderDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } } } }), (r) => ({ id: r.id, number: r.revision ? `${r.number} rev ${r.revision}` : r.number, href: `${path}/${r.id}`, date: iso(r.orderDate), title: null, party: r.party.name, status: r.status, amount: dec2(r.total), secondary: r.expectedDate ? `Expected ${day(r.expectedDate)}` : null, overdue: !!r.expectedDate && r.expectedDate < today && OPEN_PO.includes(r.status) }));
    }
    case "grn": {
      const where = { ...base, ...or({ supplierChallanNo: contains(q ?? "") }) };
      return out(where, (a) => db.grn.count(a), () => db.grn.findMany({ where, orderBy: { receiptDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } }, po: { select: { number: true } }, challan: { select: { number: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.receiptDate), title: r.po ? `Against ${r.po.number}` : r.challan ? `Against ${r.challan.number}` : null, party: r.party?.name ?? null, status: r.status, amount: null, secondary: r.supplierChallanNo ? `Supplier challan ${r.supplierChallanNo}` : null, overdue: false }));
    }
    case "challan": {
      const where = { ...base, ...or({ vehicleNo: contains(q ?? "") }) };
      return out(where, (a) => db.challan.count(a), () => db.challan.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize, include: { fromLocation: { select: { name: true } }, toLocation: { select: { name: true } }, party: { select: { name: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.dispatchDate ?? r.createdAt), title: CHALLAN_LABEL[r.type] ?? r.type, party: r.party?.name ?? null, status: r.status, amount: null, secondary: [r.fromLocation?.name, r.toLocation?.name].filter(Boolean).join(" → ") || null, overdue: r.status === "DISPATCHED" && !!r.expectedDate && r.expectedDate < today }));
    }
    case "bill": {
      const where = { ...base, ...or({ supplierInvoiceNo: contains(q ?? "") }) };
      return out(where, (a) => db.supplierBill.count(a), () => db.supplierBill.findMany({ where, orderBy: { invoiceDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.invoiceDate), title: `Supplier invoice ${r.supplierInvoiceNo}`, party: r.party.name, status: r.status, amount: dec2(r.total), secondary: r.matchStatus === "EXCEPTION" ? "Match exceptions" : r.dueDate ? `Due ${day(r.dueDate)}` : null, overdue: !!r.dueDate && r.dueDate < today && ["APPROVED", "PARTIALLY_PAID"].includes(r.status) }));
    }
    case "payment":
    case "receipt": {
      const where = { ...base, direction: kind === "payment" ? ("OUT" as const) : ("IN" as const), ...or({ reference: contains(q ?? "") }) };
      return out(where, (a) => db.payment.count(a), () => db.payment.findMany({ where, orderBy: { paymentDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.paymentDate), title: `${r.mode.replace(/_/g, " ").toLowerCase()}${r.reference ? ` · ${r.reference}` : ""}`, party: r.party.name, status: r.status, amount: dec2(r.amount), secondary: r.status === "POSTED" && r.allocatedAmount.lt(r.amount.add(r.tdsAmount)) ? `Unallocated ${r.amount.add(r.tdsAmount).sub(r.allocatedAmount).toFixed(2)}` : null, overdue: false }));
    }
    case "note": {
      const where = { ...base, ...or({ reason: contains(q ?? "") }) };
      return out(where, (a) => db.adjustmentNote.count(a), () => db.adjustmentNote.findMany({ where, orderBy: { noteDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.noteDate), title: `${r.noteType === "CREDIT" ? "Credit" : "Debit"} note · ${r.partyRole === "SUPPLIER" ? "supplier" : "client"}`, party: r.party.name, status: r.status, amount: dec2(r.total), secondary: r.reason, overdue: false }));
    }
    case "cpo": {
      const where = { ...base, ...or({ clientPoNumber: contains(q ?? "") }) };
      return out(where, (a) => db.clientPo.count(a), () => db.clientPo.findMany({ where, orderBy: { poDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } } } }), (r) => ({ id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.poDate), title: `Client ref ${r.clientPoNumber}${r.revision ? ` · rev ${r.revision}` : ""}`, party: r.party.name, status: r.status, amount: dec2(r.total), secondary: r.endDate ? `Ends ${day(r.endDate)}` : null, overdue: false }));
    }
    case "so": {
      const where = { ...base, ...or() };
      return out(where, (a) => db.salesOrder.count(a), () => db.salesOrder.findMany({ where, orderBy: { orderDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } }, clientPo: { select: { number: true } } } }), (r) => ({ id: r.id, number: r.revision ? `${r.number} rev ${r.revision}` : r.number, href: `${path}/${r.id}`, date: iso(r.orderDate), title: r.clientPo ? `Under ${r.clientPo.number}` : null, party: r.party.name, status: r.status, amount: dec2(r.total), secondary: r.deliveryDate ? `Deliver by ${day(r.deliveryDate)}` : null, overdue: !!r.deliveryDate && r.deliveryDate < today && ["APPROVED", "PARTIALLY_FULFILLED"].includes(r.status) }));
    }
    case "rabill": {
      const where = { ...base, ...or() };
      return out(where, (a) => db.raBill.count(a), () => db.raBill.findMany({ where, orderBy: { billDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } }, clientPo: { select: { number: true } } } }), (r) => ({ id: r.id, number: `${r.number} (RA-${r.raNumber})`, href: `${path}/${r.id}`, date: iso(r.billDate), title: `${r.clientPo?.number ?? "Sales order"} · ${day(r.periodFrom)} to ${day(r.periodTo)}`, party: r.party.name, status: r.status, amount: dec2(r.certifiedAmount.gt(0) ? r.certifiedAmount : r.claimedAmount), secondary: r.certifiedAmount.gt(0) ? `Claimed ${dec2(r.claimedAmount)}` : "Claimed (not yet certified)", overdue: false }));
    }
    case "invoice": {
      const where = { ...base, ...or() };
      return out(where, (a) => db.clientInvoice.count(a), () => db.clientInvoice.findMany({ where, orderBy: { invoiceDate: "desc" }, skip, take: pageSize, include: { party: { select: { name: true } } } }), (r) => {
        const outstanding = r.netReceivable.sub(r.receivedAmount).sub(r.adjustedAmount);
        const open = ["ISSUED", "PARTIALLY_PAID"].includes(r.status);
        return { id: r.id, number: r.number, href: `${path}/${r.id}`, date: iso(r.invoiceDate), title: null, party: r.party.name, status: r.status, amount: dec2(r.total), secondary: open ? `Outstanding ${outstanding.toFixed(2)}` : null, overdue: !!r.dueDate && r.dueDate < today && open };
      });
    }
  }
}

const OPEN_PO: string[] = ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"];
const CHALLAN_LABEL: Record<string, string> = { ISSUE_TO_SITE: "Issue to site", SITE_TO_SITE: "Site to site", RETURN_TO_STORE: "Return to store", RETURN_TO_SUPPLIER: "Return to supplier", CLIENT_DELIVERY: "Client delivery" };

export type DocCount = { total: number; pending: number; pendingLabel: string | null };

/** Per-kind totals and "needs action" counts for the tab badges (only kinds the actor may view). */
export async function projectDocCounts(actor: Actor, projectId: string): Promise<Partial<Record<DocKind, DocCount>>> {
  const kinds = (Object.keys(DOC_KINDS) as DocKind[]).filter((k) => can(actor, DOC_KINDS[k].view));
  const w = { organizationId: actor.organizationId, projectId };
  const grouped = async (k: DocKind): Promise<{ status: string; n: number }[]> => {
    const map = (rows: { status: string; _count: number }[]) => rows.map((r) => ({ status: r.status, n: r._count }));
    switch (k) {
      case "pr": { const r = await db.purchaseRequisition.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "rfq": { const r = await db.rfq.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "po": { const r = await db.purchaseOrder.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "grn": { const r = await db.grn.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "challan": { const r = await db.challan.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "bill": { const r = await db.supplierBill.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "payment": { const r = await db.payment.groupBy({ by: ["status"], _count: true, where: { ...w, direction: "OUT" } }); return map(r); }
      case "receipt": { const r = await db.payment.groupBy({ by: ["status"], _count: true, where: { ...w, direction: "IN" } }); return map(r); }
      case "note": { const r = await db.adjustmentNote.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "cpo": { const r = await db.clientPo.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "so": { const r = await db.salesOrder.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "rabill": { const r = await db.raBill.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
      case "invoice": { const r = await db.clientInvoice.groupBy({ by: ["status"], _count: true, where: w }); return map(r); }
    }
  };
  const res = await Promise.all(kinds.map(async (k) => [k, await grouped(k)] as const));
  return Object.fromEntries(
    res.map(([k, rows]) => {
      const p = DOC_PENDING[k];
      return [k, { total: rows.reduce((a, r) => a + r.n, 0), pending: p ? rows.filter((r) => p.statuses.includes(r.status)).reduce((a, r) => a + r.n, 0) : 0, pendingLabel: p?.label ?? null }];
    }),
  );
}

export type AttentionItem = { key: string; tone: "bad" | "warn" | "info"; title: string; detail: string; href: string };

/** Command-center data for one project: financial KPIs, material status and what needs attention. */
export async function projectCommandCenter(actor: Actor, projectId: string) {
  await assertProjectVisible(actor, projectId);
  const w = { organizationId: actor.organizationId, projectId };
  const today = startOfToday();
  const seeMoney = can(actor, "accounts.view");
  const [fin, approvals, overduePos, openPoCount, grnsToPost, billExceptions, transitLate, overdueInvoices, shortages] = await Promise.all([
    seeMoney ? projectFinancials(actor.organizationId, [projectId]).then((m) => m.get(projectId)!) : Promise.resolve(null),
    can(actor, "approvals.view") ? listApprovals(actor, { projectId }) : Promise.resolve([]),
    can(actor, "po.view") ? db.purchaseOrder.findMany({ where: { ...w, status: { in: ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] }, expectedDate: { lt: today } }, orderBy: { expectedDate: "asc" }, take: 10, include: { party: { select: { name: true } } } }) : Promise.resolve([]),
    can(actor, "po.view") ? db.purchaseOrder.count({ where: { ...w, status: { in: ["APPROVED", "SENT", "ACKNOWLEDGED", "PARTIALLY_RECEIVED"] } } }) : Promise.resolve(0),
    can(actor, "grn.view") ? db.grn.findMany({ where: { ...w, status: "SUBMITTED" }, orderBy: { submittedAt: "asc" }, take: 10 }) : Promise.resolve([]),
    can(actor, "bills.view") ? db.supplierBill.findMany({ where: { ...w, matchStatus: "EXCEPTION", status: { in: ["DRAFT", "PENDING_APPROVAL"] } }, take: 10, include: { party: { select: { name: true } } } }) : Promise.resolve([]),
    can(actor, "grn.view") ? db.challan.findMany({ where: { ...w, status: "DISPATCHED", expectedDate: { lt: today } }, take: 10 }) : Promise.resolve([]),
    can(actor, "invoice.view") ? db.clientInvoice.findMany({ where: { ...w, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, dueDate: { lt: today } }, take: 10, include: { party: { select: { name: true } } } }) : Promise.resolve([]),
    can(actor, "mrp.view") ? shortageCount(actor.organizationId, projectId) : Promise.resolve(null),
  ]);

  const attention: AttentionItem[] = [];
  for (const a of approvals) attention.push({ key: `ap-${a.id}`, tone: "warn", title: `${a.action}: ${a.number}`, detail: `Waiting to be finalized${a.party ? ` · ${a.party}` : ""}`, href: a.href });
  for (const p of overduePos) attention.push({ key: `po-${p.id}`, tone: "bad", title: `Delivery overdue: ${p.number}`, detail: `${p.party.name} · expected ${p.expectedDate!.toISOString().slice(0, 10)}`, href: `/purchase-orders/${p.id}` });
  for (const c of transitLate) attention.push({ key: `ch-${c.id}`, tone: "bad", title: `Transfer not received: ${c.number}`, detail: `In transit since ${c.dispatchDate?.toISOString().slice(0, 10) ?? "—"}`, href: `/challans/${c.id}` });
  for (const b of billExceptions) attention.push({ key: `sb-${b.id}`, tone: "bad", title: `Bill mismatch: ${b.number}`, detail: `${b.party.name} · invoice ${b.supplierInvoiceNo} does not match the PO / receipts`, href: `/supplier-bills/${b.id}` });
  for (const i of overdueInvoices) attention.push({ key: `inv-${i.id}`, tone: "bad", title: `Payment overdue: ${i.number}`, detail: `${i.party.name} · due ${i.dueDate!.toISOString().slice(0, 10)}`, href: `/client-invoices/${i.id}` });
  if (shortages) attention.push({ key: "mrp", tone: "warn", title: `${shortages} material shortage${shortages === 1 ? "" : "s"} still to order`, detail: "Open material planning to request rates or create a purchase order for the shortfall.", href: `/projects/${projectId}?tab=planning&status=SHORTAGE` });

  return {
    financials: fin,
    material: { openPos: openPoCount, overduePos: overduePos.length, grnsToPost: grnsToPost.length, shortages: shortages ?? 0, transitLate: transitLate.length },
    approvals,
    attention,
  };
}

/** Requirement lines with nothing ordered, nothing incoming and not covered by stock (cheap SQL proxy for MRP "shortage"). */
async function shortageCount(organizationId: string, projectId: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM material_requirements r
    WHERE r.organization_id = ${organizationId}::uuid AND r.project_id = ${projectId}::uuid AND r.status = 'OPEN'
      AND r.required_qty > COALESCE((
        SELECT SUM(b.on_hand) FROM stock_balances b JOIN stock_locations l ON l.id = b.location_id
        WHERE b.item_brand_id = r.item_brand_id AND l.project_id = r.project_id), 0)
      + COALESCE((
        SELECT SUM(pl.quantity - pl.accepted_qty) FROM po_lines pl JOIN purchase_orders p ON p.id = pl.po_id
        WHERE pl.item_brand_id = r.item_brand_id AND p.project_id = r.project_id
          AND p.status IN ('DRAFT','PENDING_APPROVAL','APPROVED','SENT','ACKNOWLEDGED','PARTIALLY_RECEIVED')), 0)
      + COALESCE((
        SELECT SUM(prl.quantity - prl.ordered_qty) FROM pr_lines prl JOIN purchase_requisitions pr ON pr.id = prl.pr_id
        WHERE prl.item_brand_id = r.item_brand_id AND pr.project_id = r.project_id
          AND pr.status IN ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_ORDERED')), 0)
      + COALESCE((
        SELECT SUM(t.quantity) FROM stock_transactions t
        WHERE t.item_brand_id = r.item_brand_id AND t.project_id = r.project_id
          -- Client deliveries fulfil the requirement too (same rule as planning/service.ts).
          AND t.type IN ('CONSUMPTION', 'CLIENT_DELIVERY')), 0)`;
  return Number(rows[0]?.n ?? 0);
}

/** Project team (manager + members) for the Team tab. */
export async function projectTeam(actor: Actor, projectId: string) {
  await assertProjectVisible(actor, projectId);
  const p = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { manager: { select: { id: true, fullName: true, designation: true, role: { select: { name: true } } } }, members: { orderBy: { addedAt: "asc" }, select: { addedAt: true, user: { select: { id: true, fullName: true, designation: true, employeeCode: true, status: true, role: { select: { name: true } } } } } } },
  });
  return p;
}

export type FlowStep = {
  n: number;
  key: string;
  title: string;
  summary: string;
  state: "done" | "active" | "todo";
  tab: string;
  action: { label: string; href: string } | null;
  /** Optional step (shown, but never picked as "Next"). */
  optional?: boolean;
};

/**
 * The project's order flow (simplified workflow): optional client quotation / PO → sales order →
 * material planning → rates & purchase orders → receive material → issue to site (+ site receipt) →
 * running bills & invoices → client payments. Requisitions are optional and not a step. Each step
 * shows live counts and the next action the user can take (only actions they hold the permission for).
 */
export async function projectOrderFlow(actor: Actor, projectId: string): Promise<FlowStep[]> {
  await assertProjectVisible(actor, projectId);
  const w = { organizationId: actor.organizationId, projectId };
  const cnt = (perm: PermissionKey, p: () => Promise<number>) => (can(actor, perm) ? p() : Promise.resolve(0));
  const INTERNAL_OUT = ["ISSUE_TO_SITE", "SITE_TO_SITE"] as never;
  const [quoteAll, cpoAll, cpoActive, soAll, soApproved, soPending, reqOpen, shortages, rfqAll, poAll, poOpen, supplierGrns, grnToConfirm, issueAll, inTransit, siteGrns, delivAll, raAll, raOpen, invAll, invOpen, rcpAll, firstSo] = await Promise.all([
    cnt("so.view", () => db.clientQuotation.count({ where: { ...w, status: { notIn: ["CANCELLED"] } } })),
    cnt("cpo.view", () => db.clientPo.count({ where: { ...w, status: { notIn: ["CANCELLED"] } } })),
    cnt("cpo.view", () => db.clientPo.count({ where: { ...w, status: { in: ["ACTIVE", "COMPLETED", "CLOSED"] } } })),
    cnt("so.view", () => db.salesOrder.count({ where: { ...w, status: { notIn: ["CANCELLED"] } } })),
    cnt("so.view", () => db.salesOrder.count({ where: { ...w, status: { in: ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] } } })),
    cnt("so.view", () => db.salesOrder.count({ where: { ...w, status: { in: ["DRAFT", "PENDING_APPROVAL", "REJECTED"] } } })),
    cnt("mrp.view", () => db.materialRequirement.count({ where: { ...w, status: "OPEN" } })),
    can(actor, "mrp.view") ? shortageCount(actor.organizationId, projectId) : Promise.resolve(0),
    cnt("rfq.view", () => db.rfq.count({ where: { ...w, status: { notIn: ["CANCELLED"] } } })),
    cnt("po.view", () => db.purchaseOrder.count({ where: { ...w, status: { notIn: ["CANCELLED", "REJECTED"] } } })),
    cnt("po.view", () => db.purchaseOrder.count({ where: { ...w, status: { in: [...OPEN_PO] as never } } })),
    cnt("grn.view", () => db.grn.count({ where: { ...w, status: "POSTED", poId: { not: null } } })),
    cnt("grn.view", () => db.grn.count({ where: { ...w, status: { in: ["DRAFT", "SUBMITTED"] } } })),
    cnt("grn.view", () => db.challan.count({ where: { ...w, type: { in: INTERNAL_OUT }, status: { notIn: ["CANCELLED", "DRAFT"] } } })),
    cnt("grn.view", () => db.challan.count({ where: { ...w, type: { in: INTERNAL_OUT }, status: { in: ["DISPATCHED", "PARTIALLY_RECEIVED"] } } })),
    cnt("grn.view", () => db.grn.count({ where: { ...w, status: "POSTED", challanId: { not: null } } })),
    cnt("grn.view", () => db.challan.count({ where: { ...w, type: "CLIENT_DELIVERY", status: { notIn: ["CANCELLED", "DRAFT"] } } })),
    cnt("rabill.view", () => db.raBill.count({ where: { ...w, status: { notIn: ["CANCELLED"] } } })),
    cnt("rabill.view", () => db.raBill.count({ where: { ...w, status: { in: ["DRAFT", "INTERNAL_REVIEW", "SUBMITTED", "DISPUTED", "CLIENT_CERTIFIED"] } } })),
    cnt("invoice.view", () => db.clientInvoice.count({ where: { ...w, kind: "TAX_INVOICE", status: { notIn: ["CANCELLED"] } } })),
    cnt("invoice.view", () => db.clientInvoice.count({ where: { ...w, status: { in: ["ISSUED", "PARTIALLY_PAID"] } } })),
    cnt("payments.view", () => db.payment.count({ where: { ...w, direction: "IN", status: "POSTED", refundOfId: null } })),
    can(actor, "so.view") ? db.salesOrder.findFirst({ where: { ...w, status: { in: ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] } }, orderBy: { orderDate: "asc" }, select: { id: true, partyId: true, clientPoId: true } }) : Promise.resolve(null),
  ]);
  const q = `projectId=${projectId}`;
  const tab = (t: string, extra = "") => `/projects/${projectId}?tab=${t}${extra}`;
  const act = (perm: PermissionKey, label: string, href: string) => (can(actor, perm) ? { label, href } : null);
  const plural = (n: number, s: string, many = `${s}s`) => `${n} ${n === 1 ? s : many}`;
  const state = (done: boolean, started: boolean): FlowStep["state"] => (done ? "done" : started ? "active" : "todo");
  const received = supplierGrns + siteGrns;
  const billable = !!firstSo;

  return [
    {
      n: 1, key: "contract", title: "Client quotation / PO", tab: "client-pos", optional: true,
      state: state(cpoActive > 0, quoteAll + cpoAll > 0),
      summary: quoteAll || cpoAll ? `${plural(quoteAll, "quotation")} · ${plural(cpoAll, "client PO")}${cpoAll && !cpoActive ? " · not finalized" : ""}` : "Optional — record the client's quotation or PO, or start directly with the sales order.",
      action: cpoAll ? act("cpo.view", "View client POs", tab("client-pos")) : act("cpo.manage", "Add client PO", `/client-pos/new?${q}`) ?? act("so.manage", "New quotation", `/quotations/new?${q}`),
    },
    { n: 2, key: "so", title: "Sales order", tab: "sales-orders", state: state(soApproved > 0, soAll > 0), summary: soAll ? `${plural(soApproved, "confirmed order")}${soPending ? ` · ${soPending} to confirm` : ""}` : "Start here: record what the client has ordered.", action: soAll ? act("so.view", soPending ? "Confirm sales order" : "View sales orders", tab("sales-orders")) : act("so.manage", "Create sales order", `/sales-orders/new?${q}`) },
    { n: 3, key: "planning", title: "Material planning", tab: "planning", state: state(reqOpen > 0 && shortages === 0, reqOpen > 0), summary: reqOpen ? `${plural(reqOpen, "material line")}${shortages ? ` · ${shortages} still to order` : " · all covered"}` : "Material needs appear here once the sales order is confirmed.", action: act("mrp.view", shortages ? "Order shortages" : "Open planning", tab("planning", shortages ? "&status=TO_ORDER" : "")) },
    { n: 4, key: "po", title: "Rates & purchase orders", tab: "purchase-orders", state: state(poAll > 0 && reqOpen > 0 && shortages === 0, poAll + rfqAll > 0), summary: poAll || rfqAll ? `${plural(rfqAll, "rate enquiry", "rate enquiries")} · ${plural(poAll, "PO")}${poOpen ? ` · ${poOpen} awaiting delivery` : ""}` : "Ask suppliers for rates (optional) or order directly from planning. Stock already in the warehouse can be issued without buying.", action: shortages ? act("po.create", "Order from planning", tab("planning", "&status=TO_ORDER")) : act("po.view", "View purchase orders", tab("purchase-orders")) },
    { n: 5, key: "grn", title: "Receive material", tab: "site-receipts", state: state(supplierGrns > 0 && poOpen === 0 && grnToConfirm === 0, supplierGrns + grnToConfirm > 0), summary: supplierGrns || grnToConfirm || poOpen ? `${plural(supplierGrns, "receipt")} confirmed${poOpen ? ` · ${poOpen} PO${poOpen === 1 ? "" : "s"} awaiting delivery` : ""}${grnToConfirm ? ` · ${grnToConfirm} to finish (add proof)` : ""}` : "Receive supplier deliveries against the PO, with photos and the supplier challan.", action: act("grn.create", grnToConfirm ? "Finish receipts" : "Receive material", grnToConfirm ? `/site-receipts?${q}&status=DRAFT` : `/site-receipts?${q}`) },
    { n: 6, key: "issue", title: "Issue to site", tab: "challans", state: state(issueAll > 0 && inTransit === 0 && shortages === 0, issueAll + delivAll > 0), summary: issueAll || delivAll ? `${plural(issueAll, "site challan")}${inTransit ? ` · ${inTransit} in transit` : ""} · ${plural(siteGrns, "site receipt")} confirmed${delivAll ? ` · ${plural(delivAll, "client delivery", "client deliveries")}` : ""}` : "Issue material from stock to the site with a challan; the site confirms receipt with proof.", action: inTransit ? act("grn.create", "Confirm site receipt", tab("site-receipts")) : act("stock.transfer", "Issue material to site", `/projects/${projectId}/issue`) },
    { n: 7, key: "billing", title: "Running bills & invoices", tab: "running-bills", state: state(raAll + invAll > 0 && raOpen === 0, raAll + invAll > 0), summary: raAll || invAll ? `${plural(raAll, "running bill")}${raOpen ? ` · ${raOpen} in progress` : ""} · ${plural(invAll, "invoice")}` : received ? "Bill the delivered material at sales-order rates." : "Running bills are generated from delivered material.", action: billable ? act("rabill.manage", "Generate running bill", `/running-bills/new?soId=${firstSo!.id}`) : act("rabill.view", "View running bills", tab("running-bills")) },
    { n: 8, key: "payments", title: "Client payments", tab: "accounts", state: state(invAll > 0 && invOpen === 0 && rcpAll > 0, rcpAll > 0), summary: rcpAll || invOpen ? `${plural(rcpAll, "payment")} received${invOpen ? ` · ${plural(invOpen, "invoice")} unpaid` : ""}` : "Record advances and payments against invoices.", action: firstSo ? act("payments.manage", "Record client payment", `/payments/new?direction=IN&${q}&partyId=${firstSo.partyId}`) : act("accounts.view", "Project accounts", tab("accounts")) },
  ];
}
