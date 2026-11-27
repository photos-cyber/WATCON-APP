-- Workflow v2 · Phase 5 — idempotent "Issue material to site" (additive; existing challans keep NULL).
ALTER TABLE "challans" ADD COLUMN "client_key" TEXT;
CREATE UNIQUE INDEX "challans_organization_id_client_key_key" ON "challans"("organization_id", "client_key");
