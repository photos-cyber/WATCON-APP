-- Workflow v2 · Phase 8 — supplier advances against a purchase order (additive).
ALTER TABLE "payments" ADD COLUMN "po_id" UUID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only supplier payments carry a purchase order.
ALTER TABLE "payments" ADD CONSTRAINT "payments_po_direction_check" CHECK ("po_id" IS NULL OR "direction" = 'OUT');
CREATE INDEX "payments_po_id_idx" ON "payments"("po_id") WHERE "po_id" IS NOT NULL;
