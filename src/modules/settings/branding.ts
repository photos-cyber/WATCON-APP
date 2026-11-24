import "server-only";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ForbiddenError } from "@/lib/errors";
import { can, type Actor } from "@/lib/permissions/definitions";
import { optionalText } from "@/lib/validations/common";
import { parseInput } from "@/modules/commercial/core";

/** Letterhead & document settings printed on every PDF (stored on org_settings). */

const MAX_IMAGE_BYTES = 256 * 1024;
const image = (label: string) =>
  z
    .string()
    .optional()
    .nullable()
    .refine((v) => !v || /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v), `${label} must be a PNG or JPEG image.`)
    .refine((v) => !v || Math.floor((v.length - v.indexOf(",") - 1) * 0.75) <= MAX_IMAGE_BYTES, `${label} must be 256 KB or smaller.`)
    .transform((v) => (v ? v : null));

export const brandingSchema = z.object({
  website: optionalText("Website", 120),
  officeAddress: optionalText("Office address", 500),
  bankName: optionalText("Bank name", 120),
  bankAccountName: optionalText("Account name", 160),
  bankAccountNo: z.string().trim().max(30).regex(/^[0-9A-Za-z-]*$/, "Digits / letters only.").optional().nullable().transform((v) => (v ? v : null)),
  bankIfsc: z.string().trim().toUpperCase().optional().nullable().transform((v) => (v ? v : null)).refine((v) => v === null || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), "IFSC format is AAAA0XXXXXX."),
  bankBranch: optionalText("Branch", 160),
  signatoryName: optionalText("Signatory name", 120),
  signatoryDesignation: optionalText("Designation", 120),
  signatureDataUrl: image("Signature"),
  stampDataUrl: image("Stamp"),
  documentFooter: optionalText("Footer text", 200),
});

export type Branding = z.output<typeof brandingSchema>;

export async function getBranding(organizationId: string): Promise<Branding> {
  const s = await db.orgSettings.findUnique({ where: { organizationId } });
  return {
    website: s?.website ?? null,
    officeAddress: s?.officeAddress ?? null,
    bankName: s?.bankName ?? null,
    bankAccountName: s?.bankAccountName ?? null,
    bankAccountNo: s?.bankAccountNo ?? null,
    bankIfsc: s?.bankIfsc ?? null,
    bankBranch: s?.bankBranch ?? null,
    signatoryName: s?.signatoryName ?? null,
    signatoryDesignation: s?.signatoryDesignation ?? null,
    signatureDataUrl: s?.signatureDataUrl ?? null,
    stampDataUrl: s?.stampDataUrl ?? null,
    documentFooter: s?.documentFooter ?? null,
  };
}

export async function updateBranding(actor: Actor, input: unknown) {
  if (!can(actor, "settings.company")) throw new ForbiddenError();
  const data = parseInput(brandingSchema, input);
  await db.$transaction(async (tx) => {
    await tx.orgSettings.upsert({ where: { organizationId: actor.organizationId }, create: { organizationId: actor.organizationId, ...data }, update: data });
    // Never put bank numbers or images in the audit trail; record which fields are set.
    const filled = Object.entries(data).filter(([, v]) => v).map(([k]) => k);
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "settings.branding_updated", entityType: "settings", summary: "Updated letterhead & document settings", metadata: { filled } }, tx);
  });
}
