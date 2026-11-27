import "server-only";
import { attachmentModuleWhere } from "./visibility";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { db, type Tx } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, type Actor } from "@/lib/permissions/definitions";
import { activeDriver, driverFor, maxUploadBytes } from "@/lib/storage";
import { ALLOWED_TYPES, safeFileName, sniffMime } from "@/lib/storage/sniff";
import { getCommercialSettings, parseInput, segregationBlocks } from "@/modules/commercial/core";
import { resolveAccess } from "./access";
import { ATTACHMENT_CATEGORIES } from "./categories";

/**
 * Universal evidence / attachment service. Authorisation always goes through the owning
 * record's resolver (modules/documents/access.ts): you can see a file only if you can see
 * its record, and upload only if you may add evidence to that record.
 */

const metaSchema = z.object({
  entityType: z.string().min(1).max(40),
  entityId: z.string().uuid(),
  category: z.enum(ATTACHMENT_CATEGORIES),
  description: z.string().trim().max(500).optional().nullable().transform((v) => (v ? v : null)),
  replacesId: z.string().uuid().optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
  latitude: z.coerce.number().min(-90).max(90).optional().nullable().catch(null),
  longitude: z.coerce.number().min(-180).max(180).optional().nullable().catch(null),
  accuracyM: z.coerce.number().int().min(0).max(100000).optional().nullable().catch(null),
  capturedAt: z.string().datetime().optional().nullable().catch(null),
});

export type UploadInput = z.input<typeof metaSchema> & { fileName: string; bytes: Uint8Array };

async function accessOrThrow(actor: Actor, entityType: string, entityId: string) {
  const access = await resolveAccess(actor, entityType, entityId);
  if (!access || !access.canView) throw new NotFoundError("Record");
  return access;
}

export async function uploadAttachment(actor: Actor, input: UploadInput) {
  const meta = parseInput(metaSchema, input);
  const access = await accessOrThrow(actor, meta.entityType, meta.entityId);
  if (!access.canUpload) throw new ForbiddenError("You cannot add documents to this record.");
  if (!input.bytes.length) throw new ValidationError("The file is empty.", { file: "The file is empty." });
  if (input.bytes.length > maxUploadBytes()) throw new ValidationError(`Files must be ${Math.round(maxUploadBytes() / 1048576)} MB or smaller.`, { file: "File is too large." });
  const mime = sniffMime(input.bytes, input.fileName);
  if (!mime) throw new ValidationError(`Unsupported file type. Allowed: ${Object.values(ALLOWED_TYPES).map((t) => t.label).join(", ")}.`, { file: "Unsupported file type." });

  let previous: { id: string; version: number; category: string } | null = null;
  if (meta.replacesId) {
    previous = await db.attachment.findFirst({ where: { id: meta.replacesId, organizationId: actor.organizationId, entityType: meta.entityType, entityId: meta.entityId, deletedAt: null }, select: { id: true, version: true, category: true } });
    if (!previous) throw new NotFoundError("Previous version");
    const newer = await db.attachment.count({ where: { previousVersionId: previous.id } });
    if (newer) throw new ConflictError("A newer version of this file already exists. Reload and replace the latest version.");
  }

  const bytes = Buffer.from(input.bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const driver = activeDriver();
  const key = `${actor.organizationId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`.replace(/-/g, "_").replace(/\//g, "/");
  const fileName = safeFileName(input.fileName, mime);

  // Database driver: bytes + metadata commit together. Filesystem driver: write first, clean up on failure.
  if (driver.name !== "database") await driver.put(key, bytes);
  try {
    return await db.$transaction(async (tx) => {
      if (driver.name === "database") await driver.put(key, bytes, tx);
      const row = await tx.attachment.create({
        data: {
          organizationId: actor.organizationId,
          projectId: access.projectId,
          entityType: meta.entityType,
          entityId: meta.entityId,
          category: meta.category,
          description: meta.description,
          fileName,
          mimeType: mime,
          sizeBytes: bytes.length,
          sha256,
          storageDriver: driver.name,
          storageKey: key,
          version: previous ? previous.version + 1 : 1,
          previousVersionId: previous?.id ?? null,
          latitude: meta.latitude ?? null,
          longitude: meta.longitude ?? null,
          accuracyM: meta.accuracyM ?? null,
          capturedAt: meta.capturedAt ? new Date(meta.capturedAt) : null,
          uploadedById: actor.id,
        },
        select: { id: true, fileName: true, version: true },
      });
      await writeAudit(
        {
          organizationId: actor.organizationId,
          actorId: actor.id,
          action: previous ? "attachment.new_version" : "attachment.uploaded",
          entityType: "attachment",
          entityId: row.id,
          projectId: access.projectId,
          summary: `${previous ? `Uploaded version ${row.version} of` : "Attached"} ${fileName} (${meta.category.replace(/_/g, " ").toLowerCase()}) to ${access.label}`,
          metadata: { entityType: meta.entityType, entityId: meta.entityId, sha256, sizeBytes: bytes.length },
        },
        tx,
      );
      return row;
    });
  } catch (e) {
    if (driver.name !== "database") await driver.remove(key).catch(() => {});
    throw e;
  }
}

export type AttachmentView = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  category: string;
  description: string | null;
  version: number;
  verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
  verificationNote: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  uploadedBy: string;
  uploadedById: string;
  createdAt: string;
  sha256: string;
  hasLocation: boolean;
  latitude: string | null;
  longitude: string | null;
  history: { id: string; version: number; fileName: string; createdAt: string; uploadedBy: string }[];
};

/** Latest versions with their history, for one record. */
export async function listAttachments(actor: Actor, entityType: string, entityId: string) {
  const access = await accessOrThrow(actor, entityType, entityId);
  const rows = await db.attachment.findMany({
    where: { organizationId: actor.organizationId, entityType, entityId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { uploadedBy: { select: { fullName: true } }, verifiedBy: { select: { fullName: true } } },
  });
  const superseded = new Set(rows.map((r) => r.previousVersionId).filter(Boolean) as string[]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const settings = await getCommercialSettings(actor.organizationId);
  const items: AttachmentView[] = rows
    .filter((r) => !superseded.has(r.id))
    .map((r) => {
      const history: AttachmentView["history"] = [];
      let prev = r.previousVersionId ? byId.get(r.previousVersionId) : undefined;
      while (prev) {
        history.push({ id: prev.id, version: prev.version, fileName: prev.fileName, createdAt: prev.createdAt.toISOString(), uploadedBy: prev.uploadedBy.fullName });
        prev = prev.previousVersionId ? byId.get(prev.previousVersionId) : undefined;
      }
      return {
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        category: r.category,
        description: r.description,
        version: r.version,
        verificationStatus: r.verificationStatus,
        verificationNote: r.verificationNote,
        verifiedBy: r.verifiedBy?.fullName ?? null,
        verifiedAt: r.verifiedAt?.toISOString() ?? null,
        uploadedBy: r.uploadedBy.fullName,
        uploadedById: r.uploadedById,
        createdAt: r.createdAt.toISOString(),
        sha256: r.sha256,
        hasLocation: r.latitude !== null,
        latitude: r.latitude?.toFixed(6) ?? null,
        longitude: r.longitude?.toFixed(6) ?? null,
        history,
      };
    });
  return {
    items,
    canUpload: access.canUpload,
    canVerify: can(actor, "attachments.verify"),
    canDelete: access.canUpload && !access.locked,
    locked: access.locked,
    // The panel uses this to hide "verify" on your own uploads; Super Admins are exempt.
    enforceSegregation: settings.enforceSegregation && actor.role !== "SUPER_ADMIN",
    maxUploadMb: Math.round(maxUploadBytes() / 1048576),
  };
}

/** Bytes for download. Integrity is re-checked against the stored SHA-256. */
export async function readAttachment(actor: Actor, id: string) {
  const row = await db.attachment.findFirst({ where: { id, organizationId: actor.organizationId } });
  if (!row) throw new NotFoundError("File");
  await accessOrThrow(actor, row.entityType, row.entityId);
  if (row.deletedAt) throw new NotFoundError("File");
  const bytes = await driverFor(row.storageDriver).get(row.storageKey);
  if (!bytes) throw new NotFoundError("File");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== row.sha256) {
    console.error("[attachment-integrity]", row.id, "stored hash mismatch");
    throw new ConflictError("This file failed its integrity check and cannot be served. Contact an administrator.");
  }
  return { bytes, fileName: row.fileName, mimeType: row.mimeType };
}

const verifySchema = z.object({ status: z.enum(["VERIFIED", "REJECTED"]), note: z.string().trim().max(500).optional().nullable().transform((v) => (v ? v : null)) });

export async function verifyAttachment(actor: Actor, id: string, input: unknown) {
  if (!can(actor, "attachments.verify")) throw new ForbiddenError();
  const data = parseInput(verifySchema, input);
  if (data.status === "REJECTED" && !data.note) throw new ValidationError("Give a reason when rejecting evidence.", { note: "Reason is required." });
  const row = await db.attachment.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
  if (!row) throw new NotFoundError("File");
  const access = await accessOrThrow(actor, row.entityType, row.entityId);
  const settings = await getCommercialSettings(actor.organizationId);
  if (segregationBlocks(actor, settings.enforceSegregation, row.uploadedById)) throw new ForbiddenError("Separation of duties: you cannot verify evidence you uploaded.");
  await db.$transaction(async (tx) => {
    await tx.attachment.update({ where: { id }, data: { verificationStatus: data.status, verificationNote: data.note, verifiedById: actor.id, verifiedAt: new Date() } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `attachment.${data.status.toLowerCase()}`, entityType: "attachment", entityId: id, projectId: access.projectId, summary: `${data.status === "VERIFIED" ? "Verified" : "Rejected"} ${row.fileName} on ${access.label}${data.note ? ` – ${data.note}` : ""}` }, tx);
  });
}

const deleteSchema = z.object({ reason: z.string().trim().min(3, "Give a reason.").max(300) });

/** Soft delete; evidence on posted / approved records is retained and cannot be removed. */
export async function deleteAttachment(actor: Actor, id: string, input: unknown) {
  const data = parseInput(deleteSchema, input);
  const row = await db.attachment.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
  if (!row) throw new NotFoundError("File");
  const access = await accessOrThrow(actor, row.entityType, row.entityId);
  if (access.locked) throw new ValidationError("Evidence attached to a posted or approved record is retained and cannot be removed.");
  if (!access.canUpload) throw new ForbiddenError();
  if (row.verificationStatus === "VERIFIED") throw new ValidationError("Verified evidence cannot be removed.");
  await db.$transaction(async (tx) => {
    await tx.attachment.update({ where: { id }, data: { deletedAt: new Date(), deletedById: actor.id, deleteReason: data.reason } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "attachment.removed", entityType: "attachment", entityId: id, projectId: access.projectId, summary: `Removed ${row.fileName} from ${access.label} – ${data.reason}` }, tx);
  });
}

/** Project "Documents & Proofs": every file attached to the project or any of its records. */
export async function listProjectDocuments(actor: Actor, projectId: string, opts: { category?: string; page?: number }) {
  const access = await resolveAccess(actor, "project", projectId);
  if (!access) throw new NotFoundError("Project");
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = 30;
  const where = { organizationId: actor.organizationId, projectId, deletedAt: null, nextVersion: { is: null }, ...(opts.category ? { category: opts.category } : {}), AND: [await attachmentModuleWhere(actor)] };
  const [total, rows] = await Promise.all([
    db.attachment.count({ where }),
    db.attachment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { uploadedBy: { select: { fullName: true } } } }),
  ]);
  return { total, page, pageSize, rows: rows.map((r) => ({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes, category: r.category, entityType: r.entityType, entityId: r.entityId, verificationStatus: r.verificationStatus, uploadedBy: r.uploadedBy.fullName, createdAt: r.createdAt.toISOString(), version: r.version })) };
}

/**
 * Stores an evidence file inside the caller's transaction (database driver: bytes + row commit
 * together with the business change). The caller has already authorised the change.
 */
export async function storeEvidenceTx(tx: Tx, actor: Actor, opts: { entityType: string; entityId: string; projectId: string | null; label: string; category: (typeof ATTACHMENT_CATEGORIES)[number]; description?: string | null; fileName: string; bytes: Uint8Array }) {
  if (!opts.bytes.length) throw new ValidationError("The evidence file is empty.", { evidence: "Empty file." });
  if (opts.bytes.length > maxUploadBytes()) throw new ValidationError(`Files must be ${Math.round(maxUploadBytes() / 1048576)} MB or smaller.`, { evidence: "File is too large." });
  const mime = sniffMime(opts.bytes, opts.fileName);
  if (!mime) throw new ValidationError(`Unsupported evidence file. Allowed: ${Object.values(ALLOWED_TYPES).map((t) => t.label).join(", ")}.`, { evidence: "Unsupported file type." });
  const bytes = Buffer.from(opts.bytes);
  const driver = activeDriver();
  const key = `${actor.organizationId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}`.replace(/-/g, "_");
  await driver.put(key, bytes, driver.name === "database" ? tx : undefined);
  const fileName = safeFileName(opts.fileName, mime);
  const row = await tx.attachment.create({
    data: { organizationId: actor.organizationId, projectId: opts.projectId, entityType: opts.entityType, entityId: opts.entityId, category: opts.category, description: opts.description ?? null, fileName, mimeType: mime, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), storageDriver: driver.name, storageKey: key, uploadedById: actor.id },
    select: { id: true },
  });
  await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "attachment.uploaded", entityType: "attachment", entityId: row.id, projectId: opts.projectId, summary: `Attached evidence ${fileName} to ${opts.label}` }, tx);
  return row;
}
