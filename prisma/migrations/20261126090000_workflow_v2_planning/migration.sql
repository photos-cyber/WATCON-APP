-- Workflow v2 · Phase 2 — Sales Order & Material Planning (additive; no data removed)

-- 1. Sales-order line kind: physical material vs services / installation charges.
CREATE TYPE "SoLineKind" AS ENUM ('MATERIAL', 'SERVICE', 'INSTALLATION');
ALTER TABLE "so_lines" ADD COLUMN "kind" "SoLineKind" NOT NULL DEFAULT 'MATERIAL';
-- Back-fill: lines without an item–brand were always services / labour (they never drove planning).
UPDATE "so_lines" SET "kind" = 'SERVICE' WHERE "item_brand_id" IS NULL;
ALTER TABLE "so_lines" ADD CONSTRAINT "so_lines_material_needs_item_check" CHECK ("kind" <> 'MATERIAL' OR "item_brand_id" IS NOT NULL);

-- 2. General-inventory target ("order up to") level; reorder_level is the minimum stock.
ALTER TABLE "item_brands" ADD COLUMN "target_stock" DECIMAL(14,3);
ALTER TABLE "item_brands" ADD CONSTRAINT "item_brands_target_stock_check" CHECK ("target_stock" IS NULL OR "target_stock" >= 0);

-- 3. General-inventory requirements (no project).
ALTER TABLE "material_requirements" ALTER COLUMN "project_id" DROP NOT NULL;
-- The existing UNIQUE (project_id, item_brand_id) still applies to project rows (NULLs are distinct).
CREATE UNIQUE INDEX "material_requirements_general_open_key" ON "material_requirements" ("organization_id", "item_brand_id") WHERE "project_id" IS NULL AND "status" = 'OPEN';
ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_general_no_so_check" CHECK ("project_id" IS NOT NULL OR "sales_order_line_id" IS NULL);

-- 4. Line-level allocation of RFQ / PO lines to requirements.
ALTER TABLE "po_lines" ADD COLUMN "requirement_id" UUID;
ALTER TABLE "rfq_lines" ADD COLUMN "requirement_id" UUID;
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "material_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "po_lines_requirement_id_idx" ON "po_lines" ("requirement_id") WHERE "requirement_id" IS NOT NULL;
CREATE INDEX "rfq_lines_requirement_id_idx" ON "rfq_lines" ("requirement_id") WHERE "requirement_id" IS NOT NULL;
-- Back-fill: PO lines ordered from a requisition line inherit its requirement.
UPDATE "po_lines" pl SET "requirement_id" = prl."requirement_id"
FROM "pr_lines" prl WHERE pl."pr_line_id" = prl."id" AND prl."requirement_id" IS NOT NULL AND pl."requirement_id" IS NULL;
