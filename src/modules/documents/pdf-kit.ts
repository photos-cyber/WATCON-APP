import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PdfOrg } from "@/components/documents/pdf/types";
import { db } from "@/lib/db";
import { stateName } from "@/lib/gst";
import { getCommercialSettings } from "@/modules/commercial/core";
import { getBranding } from "@/modules/settings/branding";

/** Letterhead loader for PDF builders. Formatting helpers live in ./pdf-format (re-exported). */

export * from "./pdf-format";

// ─────────────────────────── Letterhead ───────────────────────────

let defaultLogo: Promise<string | null> | null = null;
/** The official WATCON logo (public/logo1.png, dark wordmark for white paper). */
function standardLogo() {
  defaultLogo ??= readFile(path.join(process.cwd(), "public", "logo1.png"))
    .then((b) => `data:image/png;base64,${b.toString("base64")}`)
    .catch(() => null);
  return defaultLogo;
}

export async function loadPdfOrg(organizationId: string): Promise<PdfOrg> {
  const [org, settings, brand] = await Promise.all([db.organization.findUniqueOrThrow({ where: { id: organizationId } }), getCommercialSettings(organizationId), getBranding(organizationId)]);
  const hasBank = !!(brand.bankName || brand.bankAccountNo);
  return {
    name: org.name,
    legalName: org.legalName,
    address: org.address,
    officeAddress: brand.officeAddress,
    phone: org.phone,
    email: org.email,
    website: brand.website,
    gstin: settings.gstin,
    pan: settings.pan,
    state: settings.stateCode ? `${stateName(settings.stateCode)} (${settings.stateCode})` : null,
    logoDataUrl: org.logoDataUrl ?? (await standardLogo()),
    footer: brand.documentFooter,
    bank: hasBank ? { name: brand.bankName, accountName: brand.bankAccountName, accountNo: brand.bankAccountNo, ifsc: brand.bankIfsc, branch: brand.bankBranch } : null,
    signatory: { name: brand.signatoryName, designation: brand.signatoryDesignation, signatureDataUrl: brand.signatureDataUrl, stampDataUrl: brand.stampDataUrl },
  };
}

