import { db, type Prisma, type Tx } from "@/lib/db";

/** Phase 1 entities plus every commercial document type (see modules/documents/registry). */
export type AuditEntityType =
  | "client_quotation"
  | "user"
  | "project"
  | "department"
  | "task"
  | "organization"
  | "role"
  | "session"
  | "item"
  | "brand"
  | "stock"
  | "settings"
  | "party"
  | "location"
  | "reservation"
  | "attachment"
  | "material_requirement"
  | "purchase_requisition"
  | "rfq"
  | "supplier_quotation"
  | "purchase_order"
  | "grn"
  | "challan"
  | "supplier_bill"
  | "payment"
  | "adjustment_note"
  | "client_po"
  | "sales_order"
  | "so_amendment"
  | "ra_bill"
  | "client_invoice"
  | "stock_count";

export type AuditEntry = {
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: AuditEntityType;
  entityId?: string | null;
  /** Commercial records carry their project so project activity timelines can show them. */
  projectId?: string | null;
  summary?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
};

/** Append-only audit trail. Pass the transaction client when inside a transaction. */
export async function writeAudit(entry: AuditEntry, client: Tx | typeof db = db): Promise<void> {
  await client.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      projectId: entry.projectId ?? null,
      summary: entry.summary,
      metadata: entry.metadata,
      ipAddress: entry.ipAddress ?? null,
    },
  });
}
