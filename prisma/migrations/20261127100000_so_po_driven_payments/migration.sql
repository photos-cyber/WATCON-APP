-- SO / PO driven workflow (2026-11-27): a client receipt may be recorded against a sales order.
-- Additive and nullable; existing receipts keep so_id NULL (project-level, as before).
ALTER TABLE "payments" ADD COLUMN "so_id" UUID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_so_id_fkey" FOREIGN KEY ("so_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Only client receipts carry a sales order.
ALTER TABLE "payments" ADD CONSTRAINT "payments_so_direction_check" CHECK ("so_id" IS NULL OR "direction" = 'IN');
CREATE INDEX "payments_so_id_idx" ON "payments"("so_id") WHERE "so_id" IS NOT NULL;
