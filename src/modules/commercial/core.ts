import "server-only";
import { db, type Tx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, zodFieldErrors } from "@/lib/errors";
import { cmpMoney, formatINR } from "@/lib/money";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { projectAccessWhere, projectManageWhere } from "@/lib/permissions/scopes";
import type { Prisma } from "@/generated/prisma/client";

/** Shared building blocks for every commercial module (procurement, stores, billing, accounts). */

export function requirePermission(actor: Actor, permission: PermissionKey, message?: string) {
  if (!can(actor, permission)) throw new ForbiddenError(message);
}

type SafeParser<T> = { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } };

export function parseInput<T>(schema: SafeParser<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError("Please correct the highlighted fields.", zodFieldErrors(r.error.issues));
  return r.data;
}

/**
 * Scope for records that belong to a project (nullable = central / company-level record).
 * Without projects.view_all, project-linked records are limited to projects the actor can see;
 * central records (no project) are visible to anyone holding the module's view permission.
 */
export function projectScoped(actor: Actor): { organizationId: string; OR?: object[] } {
  if (can(actor, "projects.view_all")) return { organizationId: actor.organizationId };
  return { organizationId: actor.organizationId, OR: [{ projectId: null }, { project: { is: projectAccessWhere(actor) } }] };
}

/** Same as projectScoped for records whose project is mandatory. */
export function projectRequiredScoped(actor: Actor): { organizationId: string; project?: object } {
  if (can(actor, "projects.view_all")) return { organizationId: actor.organizationId };
  return { organizationId: actor.organizationId, project: { is: projectAccessWhere(actor) } };
}

/** Throws NotFound (never reveals existence) unless the project is visible to the actor. */
export async function assertProjectVisible(actor: Actor, projectId: string, client: Tx | typeof db = db) {
  const p = await client.project.findFirst({ where: { AND: [projectAccessWhere(actor), { id: projectId }] }, select: { id: true, code: true, name: true, archivedAt: true, siteAddress: true } });
  if (!p) throw new NotFoundError("Project");
  return p;
}

/** For creating commercial records against a project: visible + member/manager (or view_all) + not archived. */
export async function assertProjectUsable(actor: Actor, projectId: string, client: Tx | typeof db = db) {
  const p = await client.project.findFirst({ where: { AND: [projectManageWhere(actor), { id: projectId }] }, select: { id: true, code: true, name: true, archivedAt: true, siteAddress: true } });
  if (!p) {
    await assertProjectVisible(actor, projectId, client);
    throw new ForbiddenError("You are not a member of this project, so you cannot raise documents for it.");
  }
  if (p.archivedAt) throw new ValidationError("This project is archived. Restore it before adding commercial records.");
  return p;
}

// ─────────────────────────── Settings ───────────────────────────

export type CommercialSettings = {
  gstin: string | null;
  pan: string | null;
  stateCode: string | null;
  enforceSegregation: boolean;
  allowReceiptOnUnapprovedPo: boolean;
  billMatchMode: "TWO_WAY" | "THREE_WAY";
  receiptTolerancePct: string;
  rateTolerancePct: string;
  poTerms: string | null;
  /** PROFORMA (advance request, not a tax invoice) or TAX_INVOICE for advance milestones. */
  advanceDocument: "PROFORMA" | "TAX_INVOICE";
};

export async function getCommercialSettings(organizationId: string, client: Tx | typeof db = db): Promise<CommercialSettings> {
  const s = await client.orgSettings.findUnique({ where: { organizationId } });
  return {
    gstin: s?.gstin ?? null,
    pan: s?.pan ?? null,
    stateCode: s?.stateCode ?? null,
    enforceSegregation: s?.enforceSegregation ?? true,
    allowReceiptOnUnapprovedPo: s?.allowReceiptOnUnapprovedPo ?? false,
    billMatchMode: s?.billMatchMode ?? "THREE_WAY",
    receiptTolerancePct: s?.receiptTolerancePct?.toFixed(2) ?? "0.00",
    rateTolerancePct: s?.rateTolerancePct?.toFixed(2) ?? "0.00",
    poTerms: s?.poTerms ?? null,
    advanceDocument: s?.advanceDocument === "TAX_INVOICE" ? "TAX_INVOICE" : "PROFORMA",
  };
}

// ─────────────────────────── Approvals ───────────────────────────

/**
 * Separation of duties: true when the actor is one of the given people (creator / submitter /
 * uploader) and segregation is enforced. Super Admins are exempt and may act on their own documents.
 */
export function segregationBlocks(actor: Pick<Actor, "id" | "role">, enforceSegregation: boolean, ...personIds: (string | null | undefined)[]): boolean {
  if (!enforceSegregation || actor.role === "SUPER_ADMIN") return false;
  return personIds.some((id) => !!id && id === actor.id);
}

/**
 * Approval guard: permission + separation of duties (approver ≠ creator / submitter, when
 * enforced) + the role's approval ceiling for this document type. Super Admins have no
 * ceiling and are exempt from separation of duties.
 */
export async function assertCanApprove(
  actor: Actor,
  opts: { permission: PermissionKey; docType: string; amount?: string | null; createdById?: string | null; submittedById?: string | null; what: string },
  client: Tx | typeof db = db,
) {
  requirePermission(actor, opts.permission, `You do not have permission to approve ${opts.what}.`);
  const settings = await getCommercialSettings(actor.organizationId, client);
  if (segregationBlocks(actor, settings.enforceSegregation, opts.createdById, opts.submittedById)) {
    throw new ForbiddenError(`Separation of duties: you cannot approve ${opts.what} that you created or submitted. Ask another approver.`);
  }
  if (actor.role !== "SUPER_ADMIN" && opts.amount) {
    const limit = await client.approvalLimit.findUnique({ where: { organizationId_roleKey_docType: { organizationId: actor.organizationId, roleKey: actor.role, docType: opts.docType } } });
    if (limit && cmpMoney(opts.amount, limit.maxAmount.toFixed(2)) > 0) {
      throw new ForbiddenError(`This ${opts.what} (${formatINR(opts.amount)}) exceeds your approval limit of ${formatINR(limit.maxAmount.toFixed(2))}.`);
    }
  }
}

/** Whether an approve button should be shown (UI hint; the server re-checks with assertCanApprove). */
export function approvalHint(actor: Actor, permission: PermissionKey, doc: { createdById?: string | null; submittedById?: string | null }, enforceSegregation: boolean) {
  if (!can(actor, permission)) return { canApprove: false, reason: null as string | null };
  if (segregationBlocks(actor, enforceSegregation, doc.createdById, doc.submittedById)) return { canApprove: false, reason: "You created or submitted this document; another approver must approve it." };
  return { canApprove: true, reason: null };
}

// ─────────────────────────── Status transitions ───────────────────────────

type UpdatableDelegate = { updateMany: (args: { where: object; data: object }) => Promise<{ count: number }> };

/**
 * Optimistic, guarded status change: succeeds only if the row is still in one of `from` and
 * (when given) still at `version`. Two people approving / posting the same document at once:
 * exactly one wins, the other gets a clear conflict instead of a double posting.
 */
export async function transition(
  delegate: UpdatableDelegate,
  where: { id: string; organizationId: string; version?: number },
  from: readonly string[],
  data: Record<string, unknown>,
  label = "document",
) {
  const res = await delegate.updateMany({
    where: { id: where.id, organizationId: where.organizationId, status: { in: [...from] }, ...(where.version !== undefined ? { version: where.version } : {}) },
    data: { ...data, version: { increment: 1 } },
  });
  if (res.count !== 1) throw new ConflictError(`This ${label} was changed by someone else or is no longer in a state that allows this action. Reload and try again.`);
}

export function assertStatus(current: string, allowed: readonly string[], message: string) {
  if (!allowed.includes(current)) throw new ValidationError(message);
}

/** Prisma Decimal → fixed string helpers used by every repository. */
export const dec2 = (d: Prisma.Decimal | null | undefined) => (d ? d.toFixed(2) : "0.00");
export const dec3 = (d: Prisma.Decimal | null | undefined) => (d ? d.toFixed(3).replace(/\.?0+$/, "") || "0" : "0");
export const dec4 = (d: Prisma.Decimal | null | undefined) => (d ? d.toFixed(4).replace(/\.?0+$/, "") || "0" : "0");
export const decOpt2 = (d: Prisma.Decimal | null | undefined) => (d ? d.toFixed(2) : null);
