-- Supplier quote links: each invited supplier gets a secret link to fill in their own rates.

-- AlterTable (existing invitations get a token from the column default)
ALTER TABLE "rfq_suppliers" ADD COLUMN     "access_token" TEXT NOT NULL DEFAULT (replace((gen_random_uuid())::text, '-'::text, ''::text) || replace((gen_random_uuid())::text, '-'::text, ''::text)),
ADD COLUMN     "viewed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "supplier_quotations" ADD COLUMN     "via_portal" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "rfq_suppliers_access_token_key" ON "rfq_suppliers"("access_token");
