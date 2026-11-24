import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { cmpMoney } from "@/lib/money";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { projectAccessWhere } from "@/lib/permissions/scopes";
import { dec2, getCommercialSettings, segregationBlocks } from "@/modules/commercial/core";

/**
 * Cross-module approvals inbox. A row is "yours" when you hold the approving permission and
 * separation of duties allows you to act (you did not create / submit it). Rows you created
 * or submitted are listed separately as "waiting for others". The approving action itself is
 * always re-checked by the owning module.
 */
export type ApprovalItem = {
  kind: ApprovalKind;
  kindLabel: string;
  action: string;
  id: string;
  number: string;
  href: string;
  project: { id: string; code: string; name: string } | null;
  party: string | null;
  amount: string | null;
  waitingSince: string;
  requestedBy: string | null;
  mine: boolean;
  blockedReason: string | null;
};

export type ApprovalKind = "pr" | "po" | "rfq" | "grn" | "bill" | "cpo" | "so" | "rabill";

type Row = {
  id: string;
  number: string;
  projectId: string | null;
  project: { id: string; code: string; name: string } | null;
  party?: { name: string } | null;
  amount?: Prisma.Decimal | null;
  at: Date;
  createdById: string | null;
  submittedById: string | null;
  requestedBy: string | null;
};

const projectSel = { select: { id: true, code: true, name: true } } as const;

function scopeFor(actor: Actor, projectId?: string): { organizationId: string; projectId?: string; project?: object } {
  const base: { organizationId: string; projectId?: string; project?: object } = { organizationId: actor.organizationId };
  if (projectId) base.projectId = projectId;
  if (!can(actor, "projects.view_all")) base.project = { is: projectAccessWhere(actor) };
  return base;
}

type Source = { kind: ApprovalKind; label: string; action: string; permission: PermissionKey; path: string; docType?: string; load: (where: ReturnType<typeof scopeFor>) => Promise<Row[]> };

const TAKE = 200;

const SOURCES: Source[] = [
  {
    kind: "pr", label: "Purchase requisition", action: "Approve requisition", permission: "pr.approve", path: "/purchase-requisitions",
    load: async (w) => (await db.purchaseRequisition.findMany({ where: { ...w, status: "SUBMITTED" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
  {
    kind: "po", label: "Purchase order", action: "Approve purchase order", permission: "po.approve", path: "/purchase-orders", docType: "PO",
    load: async (w) => (await db.purchaseOrder.findMany({ where: { ...w, status: "PENDING_APPROVAL" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, party: { select: { name: true } }, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, party: r.party, amount: r.total, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
  {
    kind: "rfq", label: "Rate enquiry award", action: "Approve supplier award", permission: "rfq.approve", path: "/rate-enquiries",
    load: async (w) => (await db.rfq.findMany({ where: { ...w, status: "AWARD_PENDING" }, orderBy: { awardProposedAt: "asc" }, take: TAKE, include: { project: projectSel, awardProposedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, at: r.awardProposedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.awardProposedById, requestedBy: r.awardProposedBy?.fullName ?? null })),
  },
  {
    kind: "grn", label: "Site receipt", action: "Verify & post to stock", permission: "grn.post", path: "/site-receipts",
    load: async (w) => (await db.grn.findMany({ where: { ...w, status: "SUBMITTED" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, party: { select: { name: true } }, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, party: r.party, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
  {
    kind: "bill", label: "Supplier bill", action: "Approve for payment", permission: "bills.approve", path: "/supplier-bills", docType: "SB",
    load: async (w) => (await db.supplierBill.findMany({ where: { ...w, status: "PENDING_APPROVAL" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, party: { select: { name: true } }, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, party: r.party, amount: r.total, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
  {
    kind: "cpo", label: "Client PO", action: "Approve client PO", permission: "cpo.approve", path: "/client-pos", docType: "CPO",
    load: async (w) => (await db.clientPo.findMany({ where: { ...w, status: "PENDING_APPROVAL" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, party: { select: { name: true } }, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, party: r.party, amount: r.total, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
  {
    kind: "so", label: "Sales order", action: "Approve sales order", permission: "so.approve", path: "/sales-orders", docType: "SO",
    load: async (w) => (await db.salesOrder.findMany({ where: { ...w, status: "PENDING_APPROVAL" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, party: { select: { name: true } }, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, party: r.party, amount: r.total, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
  {
    kind: "rabill", label: "Running bill", action: "Review & submit to client", permission: "rabill.approve", path: "/running-bills", docType: "RAB",
    load: async (w) => (await db.raBill.findMany({ where: { ...w, status: "INTERNAL_REVIEW" }, orderBy: { submittedAt: "asc" }, take: TAKE, include: { project: projectSel, party: { select: { name: true } }, submittedBy: { select: { fullName: true } } } }))
      .map((r) => ({ id: r.id, number: r.number, projectId: r.projectId, project: r.project, party: r.party, amount: r.claimedAmount, at: r.submittedAt ?? r.createdAt, createdById: r.createdById, submittedById: r.submittedById, requestedBy: r.submittedBy?.fullName ?? null })),
  },
];

/** Pending approvals visible to the actor, oldest first. `projectId` limits to one project. */
export async function listApprovals(actor: Actor, opts: { projectId?: string } = {}): Promise<ApprovalItem[]> {
  const sources = SOURCES.filter((s) => can(actor, s.permission));
  if (!sources.length) return [];
  const settings = await getCommercialSettings(actor.organizationId);
  const limits = actor.role === "SUPER_ADMIN" ? [] : await db.approvalLimit.findMany({ where: { organizationId: actor.organizationId, roleKey: actor.role } });
  const limitFor = (docType?: string) => (docType ? limits.find((l) => l.docType === docType) : undefined);
  const where = scopeFor(actor, opts.projectId);
  const batches = await Promise.all(sources.map(async (s) => ({ s, rows: await s.load(where) })));
  const items: ApprovalItem[] = [];
  for (const { s, rows } of batches) {
    for (const r of rows) {
      const own = segregationBlocks(actor, settings.enforceSegregation, r.createdById, r.submittedById);
      const amount = r.amount ? dec2(r.amount) : null;
      const limit = limitFor(s.docType);
      const overLimit = !!(limit && amount && cmpMoney(amount, limit.maxAmount.toFixed(2)) > 0);
      items.push({
        kind: s.kind,
        kindLabel: s.label,
        action: s.action,
        id: r.id,
        number: r.number,
        href: `${s.path}/${r.id}`,
        project: r.project,
        party: r.party?.name ?? null,
        amount,
        waitingSince: r.at.toISOString(),
        requestedBy: r.requestedBy,
        mine: !own && !overLimit,
        blockedReason: own ? "You created or submitted this — another approver must act." : overLimit ? "Above your approval limit — needs a higher approver." : null,
      });
    }
  }
  return items.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
}

/** Count of items the actor can act on now (for badges / dashboard). */
export async function countMyApprovals(actor: Actor): Promise<number> {
  const [items, amendments] = await Promise.all([listApprovals(actor), listSoAmendmentRequests(actor)]);
  return items.filter((i) => i.mine).length + amendments.filter((a) => a.mine).length;
}

export type AmendmentRequestItem = {
  id: string;
  requestNo: string;
  soId: string;
  soNumber: string;
  href: string;
  project: { id: string; code: string; name: string };
  reason: string;
  requestedBy: string;
  requestedAt: string;
  mine: boolean;
};

/**
 * Pending sales-order amendment requests. Only a Super Admin decides them (including their own);
 * other users see the requests they raised as "waiting for Super Admin".
 */
export async function listSoAmendmentRequests(actor: Actor, opts: { projectId?: string } = {}): Promise<AmendmentRequestItem[]> {
  const isSuper = actor.role === "SUPER_ADMIN";
  if (!isSuper && !can(actor, "so.view")) return [];
  const rows = await db.soAmendmentRequest.findMany({
    where: {
      organizationId: actor.organizationId,
      status: "PENDING",
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(can(actor, "projects.view_all") ? {} : { project: { is: projectAccessWhere(actor) } }),
      ...(isSuper ? {} : { requestedById: actor.id }),
    },
    orderBy: { requestedAt: "asc" },
    take: 200,
    include: { so: { select: { number: true } }, project: { select: { id: true, code: true, name: true } }, requestedBy: { select: { fullName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    requestNo: `Amendment #${r.requestNo}`,
    soId: r.soId,
    soNumber: r.so.number,
    href: `/sales-orders/${r.soId}`,
    project: r.project,
    reason: r.reason,
    requestedBy: r.requestedBy.fullName,
    requestedAt: r.requestedAt.toISOString(),
    mine: isSuper,
  }));
}
