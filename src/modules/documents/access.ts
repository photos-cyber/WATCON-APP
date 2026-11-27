import "server-only";
import type { Actor } from "@/lib/permissions/definitions";

/**
 * Record-level access for cross-cutting features (attachments, activity, related documents).
 * Each module exports a resolver that loads the record THROUGH ITS OWN SCOPED QUERY, so a
 * record the actor cannot see resolves to null (→ 404), exactly like the module's pages.
 */
export type EntityAccess = {
  projectId: string | null;
  /** Human reference, e.g. "PO/2026-27/0004". */
  label: string;
  canView: boolean;
  /** May add evidence / new file versions. */
  canUpload: boolean;
  /** Posted / approved records: evidence is retained (no deletion). */
  locked: boolean;
};

export type AccessResolver = (actor: Actor, id: string) => Promise<EntityAccess | null>;

// Lazy imports avoid import cycles between module services and this registry.
const RESOLVERS: Record<string, () => Promise<AccessResolver>> = {
  project: async () => (await import("@/modules/commercial/project-access")).projectAccess,
  party: async () => (await import("@/modules/parties/service")).partyAccess,
  purchase_requisition: async () => (await import("@/modules/procurement/pr")).prAccess,
  rfq: async () => (await import("@/modules/procurement/rfq")).rfqAccess,
  supplier_quotation: async () => (await import("@/modules/procurement/rfq")).quotationAccess,
  purchase_order: async () => (await import("@/modules/procurement/po")).poAccess,
  grn: async () => (await import("@/modules/stores/grn")).grnAccess,
  challan: async () => (await import("@/modules/stores/challan")).challanAccess,
  client_po: async () => (await import("@/modules/sales/client-po")).clientPoAccess,
  sales_order: async () => (await import("@/modules/sales/sales-order")).salesOrderAccess,
  client_quotation: async () => (await import("@/modules/sales/quotation")).quotationAccess,
  so_amendment: async () => (await import("@/modules/sales/sales-order")).soAmendmentAccess,
  ra_bill: async () => (await import("@/modules/sales/ra-bill")).raBillAccess,
  client_invoice: async () => (await import("@/modules/sales/invoice")).clientInvoiceAccess,
  supplier_bill: async () => (await import("@/modules/payables/bills")).billAccess,
  payment: async () => (await import("@/modules/payables/payments")).paymentAccess,
  adjustment_note: async () => (await import("@/modules/payables/notes")).noteAccess,
  stock_txn: async () => (await import("@/modules/inventory/locations")).stockTxnAccess,
};

export async function resolveAccess(actor: Actor, entityType: string, entityId: string): Promise<EntityAccess | null> {
  const loader = RESOLVERS[entityType];
  if (!loader) return null;
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) return null;
  const resolver = await loader();
  return resolver(actor, entityId);
}
