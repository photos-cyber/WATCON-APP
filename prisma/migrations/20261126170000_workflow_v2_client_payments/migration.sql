-- Workflow v2 · Phase 7 — authorised refunds of client advances (additive).
ALTER TABLE "payments" ADD COLUMN "refunded_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "refund_of_id" UUID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_id_fkey" FOREIGN KEY ("refund_of_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_refunded_amount_check" CHECK ("refunded_amount" >= 0);
-- A receipt can never give back more than its unallocated part.
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_within_amount_check" CHECK ("allocated_amount" + "refunded_amount" <= "amount" + "tds_amount");
CREATE INDEX "payments_refund_of_id_idx" ON "payments"("refund_of_id") WHERE "refund_of_id" IS NOT NULL;
