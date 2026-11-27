-- Workflow v2 · Phase 6 — cumulative running bills on a sales order (client PO optional). Additive.

ALTER TABLE "ra_bills" ADD COLUMN "so_id" UUID,
  ADD COLUMN "previous_value" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "previous_billed" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "previous_outstanding" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "received_to_date" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "is_final" BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN "client_po_id" DROP NOT NULL;
-- Every existing bill has a client PO, so this holds for old data.
ALTER TABLE "ra_bills" ADD CONSTRAINT "ra_bills_basis_check" CHECK (("client_po_id" IS NULL) <> ("so_id" IS NULL));
ALTER TABLE "ra_bills" ADD CONSTRAINT "ra_bills_so_id_fkey" FOREIGN KEY ("so_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ra_bills_so_id_ra_number_key" ON "ra_bills"("so_id", "ra_number");

ALTER TABLE "ra_bill_lines" ADD COLUMN "so_line_id" UUID,
  ADD COLUMN "delivered_qty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  ALTER COLUMN "client_po_line_id" DROP NOT NULL;
ALTER TABLE "ra_bill_lines" ADD CONSTRAINT "ra_bill_lines_basis_check" CHECK (("client_po_line_id" IS NULL) <> ("so_line_id" IS NULL));
ALTER TABLE "ra_bill_lines" ADD CONSTRAINT "ra_bill_lines_so_line_id_fkey" FOREIGN KEY ("so_line_id") REFERENCES "so_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ra_bill_lines_ra_bill_id_so_line_id_key" ON "ra_bill_lines"("ra_bill_id", "so_line_id");
