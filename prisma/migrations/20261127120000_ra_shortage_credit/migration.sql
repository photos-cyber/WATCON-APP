-- Final sales-order running bill: automatic credit for material billed earlier that never fully reached the site.
ALTER TABLE "ra_bills" ADD COLUMN "shortage_credit" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "ra_bills" ADD CONSTRAINT "ra_bills_shortage_credit_check" CHECK ("shortage_credit" >= 0);
