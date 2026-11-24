-- Letterhead & document branding settings (all optional; printed on PDFs).
ALTER TABLE "org_settings" ADD COLUMN     "website" TEXT,
ADD COLUMN     "office_address" TEXT,
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "bank_account_name" TEXT,
ADD COLUMN     "bank_account_no" TEXT,
ADD COLUMN     "bank_ifsc" TEXT,
ADD COLUMN     "bank_branch" TEXT,
ADD COLUMN     "signatory_name" TEXT,
ADD COLUMN     "signatory_designation" TEXT,
ADD COLUMN     "signature_data_url" TEXT,
ADD COLUMN     "stamp_data_url" TEXT,
ADD COLUMN     "document_footer" TEXT;
