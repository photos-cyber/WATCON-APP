import "server-only";
import { db, type Prisma } from "@/lib/db";
import { can, type Actor, type PermissionKey } from "@/lib/permissions/definitions";
import { projectScoped } from "@/modules/commercial/core";

const ENTITY_PERMISSIONS: Record<string, PermissionKey> = {
  party: "parties.view", purchase_requisition: "pr.view", rfq: "rfq.view",
  supplier_quotation: "rfq.view", purchase_order: "po.view", grn: "grn.view",
  challan: "grn.view", client_po: "cpo.view", sales_order: "so.view",
  client_quotation: "so.view", so_amendment: "so.view", ra_bill: "rabill.view",
  client_invoice: "invoice.view", supplier_bill: "bills.view", payment: "payments.view",
};

/** Metadata must obey module permissions, just like the actual download does.
 * Apply before counting/pagination so even hidden filenames and counts stay private.
 * Callers also apply organization and project visibility.
 */
export async function attachmentModuleWhere(actor: Actor): Promise<Prisma.AttachmentWhereInput> {
  const types = ["project", ...Object.entries(ENTITY_PERMISSIONS).filter(([, p]) => can(actor, p)).map(([t]) => t)];
  const roles = (["SUPPLIER", "CLIENT"] as const).filter((r) => can(actor, r === "SUPPLIER" ? "bills.view" : "invoice.view"));
  if (!roles.length) return { entityType: { in: types } };
  // Notes have different permissions on their supplier and client sides.
  const notes = await db.adjustmentNote.findMany({ where: { AND: [projectScoped(actor) as Prisma.AdjustmentNoteWhereInput, { partyRole: { in: roles } }] }, select: { id: true } });
  return { OR: [{ entityType: { in: types } }, { entityType: "adjustment_note", entityId: { in: notes.map((n) => n.id) } }] };
}
