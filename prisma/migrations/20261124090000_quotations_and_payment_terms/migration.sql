-- CreateEnum
CREATE TYPE "ClientQuotationStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('TAX_INVOICE', 'PROFORMA');

-- AlterTable
ALTER TABLE "org_settings" ADD COLUMN     "advance_document" TEXT NOT NULL DEFAULT 'PROFORMA';

-- AlterTable
ALTER TABLE "supplier_quotations" ADD COLUMN     "advance_pct" DECIMAL(5,2),
ADD COLUMN     "credit_days" INTEGER,
ADD COLUMN     "payment_milestones" JSONB,
ADD COLUMN     "warranty" TEXT;

-- AlterTable
ALTER TABLE "quotation_lines" ADD COLUMN     "payment_terms" TEXT;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "advance_pct" DECIMAL(5,2),
ADD COLUMN     "credit_days" INTEGER,
ADD COLUMN     "payment_milestones" JSONB,
ADD COLUMN     "warranty" TEXT;

-- AlterTable
ALTER TABLE "client_invoices" ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'TAX_INVOICE',
ADD COLUMN     "milestone_id" UUID;

-- CreateTable
CREATE TABLE "client_quotations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "subject" TEXT,
    "quote_date" DATE NOT NULL,
    "valid_until" DATE,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" "ClientQuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "status_note" TEXT,
    "tax_mode" "TaxMode" NOT NULL DEFAULT 'INTRA',
    "place_of_supply" TEXT,
    "taxable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "delivery_terms" TEXT,
    "payment_terms_text" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "access_token" TEXT NOT NULL DEFAULT (replace((gen_random_uuid())::text, '-'::text, ''::text) || replace((gen_random_uuid())::text, '-'::text, ''::text)),
    "sent_at" TIMESTAMP(3),
    "sent_via" TEXT,
    "viewed_at" TIMESTAMP(3),
    "otp_hash" TEXT,
    "otp_expires_at" TIMESTAMP(3),
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "accepted_at" TIMESTAMP(3),
    "acceptance_method" TEXT,
    "accepted_by_name" TEXT,
    "accepted_by_email" TEXT,
    "accepted_by_role" TEXT,
    "accepted_ip" TEXT,
    "accepted_agent" TEXT,
    "acceptance_note" TEXT,
    "accepted_revision" INTEGER,
    "accepted_snapshot" JSONB,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "converted_so_id" UUID,
    "converted_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "submitted_by_id" UUID,
    "submitted_at" TIMESTAMP(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_quotation_lines" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_brand_id" UUID,
    "description" TEXT NOT NULL,
    "brand" TEXT,
    "hsn_sac" TEXT,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "rate" DECIMAL(18,4) NOT NULL,
    "discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "client_quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_quotation_revisions" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_quotation_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_milestones" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "quotation_id" UUID,
    "so_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'PERCENT',
    "percent" DECIMAL(7,4),
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "trigger" TEXT NOT NULL DEFAULT 'CUSTOM',
    "due_date" DATE,
    "days" INTEGER,
    "note" TEXT,
    "achieved_at" TIMESTAMP(3),
    "achieved_by_id" UUID,

    CONSTRAINT "payment_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_term_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "milestones" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_term_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_quotations_access_token_key" ON "client_quotations"("access_token");

-- CreateIndex
CREATE UNIQUE INDEX "client_quotations_converted_so_id_key" ON "client_quotations"("converted_so_id");

-- CreateIndex
CREATE INDEX "client_quotations_organization_id_status_idx" ON "client_quotations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "client_quotations_project_id_idx" ON "client_quotations"("project_id");

-- CreateIndex
CREATE INDEX "client_quotations_party_id_idx" ON "client_quotations"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_quotations_organization_id_number_key" ON "client_quotations"("organization_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "client_quotation_lines_quotation_id_line_no_key" ON "client_quotation_lines"("quotation_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "client_quotation_revisions_quotation_id_revision_key" ON "client_quotation_revisions"("quotation_id", "revision");

-- CreateIndex
CREATE INDEX "payment_milestones_quotation_id_idx" ON "payment_milestones"("quotation_id");

-- CreateIndex
CREATE INDEX "payment_milestones_so_id_idx" ON "payment_milestones"("so_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_term_templates_organization_id_name_key" ON "payment_term_templates"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "payment_milestones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotations" ADD CONSTRAINT "client_quotations_converted_so_id_fkey" FOREIGN KEY ("converted_so_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotation_lines" ADD CONSTRAINT "client_quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "client_quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotation_lines" ADD CONSTRAINT "client_quotation_lines_item_brand_id_fkey" FOREIGN KEY ("item_brand_id") REFERENCES "item_brands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_quotation_revisions" ADD CONSTRAINT "client_quotation_revisions_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "client_quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "client_quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_so_id_fkey" FOREIGN KEY ("so_id") REFERENCES "sales_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_achieved_by_id_fkey" FOREIGN KEY ("achieved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_term_templates" ADD CONSTRAINT "payment_term_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

