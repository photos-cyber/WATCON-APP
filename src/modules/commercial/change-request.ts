import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { text, uuid } from "@/lib/validations/common";
import { parseInput, projectScoped, requirePermission } from "./core";

/**
 * "Request change" on a finalized document. Under the simplified workflow only the Super Admin may
 * amend / cancel / reverse finalized stock or money documents; everyone else raises a request here.
 * It is audited on the document and notifies every active Super Admin with a link — no new table,
 * no status change. The Super Admin then performs the change on the document (reason required).
 */
const KINDS = {
  purchase_order: { label: "Purchase order", path: "/purchase-orders", perm: "po.view" },
  grn: { label: "Material receipt", path: "/site-receipts", perm: "grn.view" },
  supplier_bill: { label: "Supplier bill", path: "/supplier-bills", perm: "bills.view" },
  ra_bill: { label: "Running bill", path: "/running-bills", perm: "rabill.view" },
  client_invoice: { label: "Client invoice", path: "/client-invoices", perm: "invoice.view" },
  payment: { label: "Payment", path: "/payments", perm: "payments.view" },
  client_po: { label: "Client PO", path: "/client-pos", perm: "cpo.view" },
  challan: { label: "Site challan", path: "/challans", perm: "grn.view" },
} as const satisfies Record<string, { label: string; path: string; perm: PermissionKey }>;

export type ChangeRequestKind = keyof typeof KINDS;

const schema = z.object({
  kind: z.enum(Object.keys(KINDS) as [ChangeRequestKind, ...ChangeRequestKind[]]),
  id: uuid,
  change: z.enum(["AMEND", "CANCEL", "REVERSE", "OTHER"]).default("AMEND"),
  reason: text("What needs to change and why", 1000, 5),
});

const CHANGE_LABEL = { AMEND: "Amend", CANCEL: "Cancel", REVERSE: "Reverse", OTHER: "Change" } as const;

async function loadDoc(actor: Actor, kind: ChangeRequestKind, id: string): Promise<{ number: string; projectId: string | null } | null> {
  const scope = projectScoped(actor) as object;
  const where = { AND: [{ id }, scope] };
  const sel = { select: { number: true, projectId: true } } as const;
  switch (kind) {
    case "purchase_order": return db.purchaseOrder.findFirst({ where, ...sel });
    case "grn": return db.grn.findFirst({ where, ...sel });
    case "supplier_bill": return db.supplierBill.findFirst({ where, ...sel });
    case "ra_bill": return db.raBill.findFirst({ where, ...sel });
    case "client_invoice": return db.clientInvoice.findFirst({ where, ...sel });
    case "payment": return db.payment.findFirst({ where, ...sel });
    case "client_po": return db.clientPo.findFirst({ where, ...sel });
    case "challan": return db.challan.findFirst({ where, ...sel });
  }
}

export async function requestChange(actor: Actor, input: unknown) {
  const data = parseInput(schema, input);
  const k = KINDS[data.kind];
  requirePermission(actor, k.perm);
  const doc = await loadDoc(actor, data.kind, data.id);
  if (!doc) throw new NotFoundError(k.label);
  if (actor.role === "SUPER_ADMIN") throw new ValidationError("You are the Super Admin — make the change on the document directly.");
  const verb = CHANGE_LABEL[data.change];
  const link = `${k.path}/${data.id}`;
  return db.$transaction(async (tx) => {
    const admins = await tx.user.findMany({ where: { organizationId: actor.organizationId, role: { key: "SUPER_ADMIN" }, status: "ACTIVE" }, select: { id: true } });
    if (!admins.length) throw new ValidationError("No active Super Admin is set up to receive the request.");
    const me = await tx.user.findUnique({ where: { id: actor.id }, select: { fullName: true } });
    await tx.notification.createMany({ data: admins.map((a) => ({ userId: a.id, type: "change_request", title: `${verb} requested: ${k.label} ${doc.number}`, body: `${me?.fullName ?? "A user"}: ${data.reason}`, link })) });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "change.requested", entityType: data.kind, entityId: data.id, projectId: doc.projectId, summary: `Requested Super Admin to ${verb.toLowerCase()} ${k.label.toLowerCase()} ${doc.number} – ${data.reason}` }, tx);
    return { notified: admins.length };
  });
}

/** Whether the "Request change" button applies (non-Super Admin with view access). */
export const canRequestChange = (actor: Actor, kind: ChangeRequestKind) => actor.role !== "SUPER_ADMIN" && can(actor, KINDS[kind].perm);
