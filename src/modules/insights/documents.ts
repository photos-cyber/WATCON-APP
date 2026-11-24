import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { can, type Actor } from "@/lib/permissions/definitions";
import { projectAccessWhere } from "@/lib/permissions/scopes";
import { attachmentModuleWhere } from "@/modules/documents/visibility";

const query = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  projectId: z.string().uuid().optional().catch(undefined),
  category: z.string().max(40).optional().catch(undefined),
  entityType: z.string().max(40).optional().catch(undefined),
  verification: z.enum(["PENDING", "VERIFIED", "REJECTED"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).catch(1).default(1),
});

/**
 * Organisation-wide document browser (latest version of each file). Project files are limited to
 * projects the actor can see; company-level files (e.g. supplier KYC) need the directory permission.
 */
export async function listOrgDocuments(actor: Actor, raw: unknown) {
  const q = query.parse(raw ?? {});
  const pageSize = 30;
  const scope: Prisma.AttachmentWhereInput = can(actor, "projects.view_all")
    ? {}
    : {
        OR: [
          { projectId: { in: (await db.project.findMany({ where: projectAccessWhere(actor), select: { id: true } })).map((p) => p.id) } },
          ...(can(actor, "parties.view") ? [{ projectId: null }] : []),
        ],
      };
  const where: Prisma.AttachmentWhereInput = {
    AND: [
      { organizationId: actor.organizationId, deletedAt: null, nextVersion: { is: null } },
      scope,
      await attachmentModuleWhere(actor),
      q.projectId ? { projectId: q.projectId } : {},
      q.category ? { category: q.category } : {},
      q.entityType ? { entityType: q.entityType } : {},
      q.verification ? { verificationStatus: q.verification } : {},
      q.q ? { OR: [{ fileName: { contains: q.q, mode: "insensitive" } }, { description: { contains: q.q, mode: "insensitive" } }] } : {},
    ],
  };
  const [total, rows] = await Promise.all([
    db.attachment.count({ where }),
    db.attachment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * pageSize, take: pageSize, include: { uploadedBy: { select: { fullName: true } }, project: { select: { id: true, code: true } } } }),
  ]);
  return {
    total,
    page: q.page,
    pageSize,
    rows: rows.map((r) => ({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes, category: r.category, entityType: r.entityType, entityId: r.entityId, verificationStatus: r.verificationStatus, version: r.version, uploadedBy: r.uploadedBy.fullName, createdAt: r.createdAt.toISOString(), project: r.project })),
  };
}
