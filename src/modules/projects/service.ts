import "server-only";
import { db, type Prisma, type Tx } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { nextCode } from "@/lib/codes";
import { ForbiddenError, NotFoundError, ValidationError, zodFieldErrors } from "@/lib/errors";
import { can, type Actor } from "@/lib/permissions/definitions";
import { projectAccessWhere, projectManageWhere, taskAccessWhere } from "@/lib/permissions/scopes";
import { toDbDate } from "@/lib/validations/common";
import { completionRate } from "@/modules/tasks/rules";
import { deliveryProgressByProject, type DeliveryProgress } from "./lifecycle";
import {
  projectInputSchema,
  projectListQuerySchema,
  statusUpdateSchema,
  type ProjectData,
  type ProjectListQuery,
} from "./validation";

/**
 * `progress` is the project's headline progress: sales-order delivery when the project has an
 * approved sales order with material lines, otherwise task completion (`progressBasis` says which).
 * `taskProgress` is always the task completion rate.
 */
export type TaskCounts = { total: number; completed: number; cancelled: number; open: number; progress: number; taskProgress: number; progressBasis: "delivery" | "tasks"; delivery: DeliveryProgress | null };

const EMPTY_COUNTS: TaskCounts = { total: 0, completed: 0, cancelled: 0, open: 0, progress: 0, taskProgress: 0, progressBasis: "tasks", delivery: null };

/** Visible-task counts per project in ONE grouped query (no N+1). */
export async function taskCountsByProject(actor: Actor, projectIds: string[]): Promise<Map<string, TaskCounts>> {
  const map = new Map<string, TaskCounts>();
  if (!projectIds.length) return map;
  const groups = await db.task.groupBy({
    by: ["projectId", "status"],
    where: { AND: [taskAccessWhere(actor), { projectId: { in: projectIds } }] },
    _count: { _all: true },
  });
  for (const g of groups) {
    const c = map.get(g.projectId) ?? { ...EMPTY_COUNTS };
    c.total += g._count._all;
    if (g.status === "COMPLETED") c.completed += g._count._all;
    else if (g.status === "CANCELLED") c.cancelled += g._count._all;
    else c.open += g._count._all;
    map.set(g.projectId, c);
  }
  const delivery = await deliveryProgressByProject(projectIds);
  for (const id of projectIds) {
    const c = map.get(id) ?? { ...EMPTY_COUNTS };
    c.taskProgress = completionRate(c);
    const d = delivery.get(id) ?? null;
    c.delivery = d;
    c.progressBasis = d ? "delivery" : "tasks";
    c.progress = d ? d.progress : c.taskProgress;
    map.set(id, c);
  }
  return map;
}

export async function listProjects(actor: Actor, rawQuery: unknown) {
  const query: ProjectListQuery = projectListQuerySchema.parse(rawQuery ?? {});
  const and: Prisma.ProjectWhereInput[] = [projectAccessWhere(actor)];
  if (query.archived === "only") and.push({ archivedAt: { not: null } });
  else if (query.archived !== "include") and.push({ archivedAt: null });
  if (query.status) and.push({ status: query.status });
  if (query.q) {
    and.push({
      OR: [
        { name: { contains: query.q, mode: "insensitive" } },
        { code: { contains: query.q, mode: "insensitive" } },
        { siteAddress: { contains: query.q, mode: "insensitive" } },
      ],
    });
  }
  if (query.from) and.push({ updatedAt: { gte: new Date(`${query.from}T00:00:00.000Z`) } });
  if (query.to) and.push({ updatedAt: { lt: new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000) } });

  const where: Prisma.ProjectWhereInput = { AND: and };
  const [total, rows] = await Promise.all([
    db.project.count({ where }),
    db.project.findMany({
      where,
      orderBy: [{ [query.sort]: query.dir }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        code: true,
        name: true,
        siteAddress: true,
        status: true,
        priority: true,
        updatedAt: true,
        archivedAt: true,
        manager: { select: { id: true, fullName: true } },
      },
    }),
  ]);
  const counts = await taskCountsByProject(actor, rows.map((r) => r.id));
  return {
    rows: rows.map((r) => ({ ...r, counts: counts.get(r.id) ?? EMPTY_COUNTS })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    query,
  };
}

export type ProjectCapabilities = {
  canEdit: boolean;
  canArchive: boolean;
  canPostStatus: boolean;
  canCreateTask: boolean;
  canReport: boolean;
};

async function capabilitiesFor(actor: Actor, projectId: string, archived: boolean): Promise<ProjectCapabilities> {
  const manageable = (await db.project.count({ where: { AND: [projectManageWhere(actor), { id: projectId }] } })) > 0;
  return {
    canEdit: manageable && can(actor, "projects.edit"),
    canArchive: manageable && can(actor, "projects.archive"),
    canPostStatus: manageable && !archived && can(actor, "projects.post_status"),
    canCreateTask: manageable && !archived && can(actor, "tasks.create"),
    canReport: can(actor, "reports.view") || can(actor, "reports.own"),
  };
}

export async function getProject(actor: Actor, id: string) {
  const project = await db.project.findFirst({
    where: { AND: [projectAccessWhere(actor), { id }] },
    include: {
      manager: { select: { id: true, fullName: true, designation: true } },
      createdBy: { select: { id: true, fullName: true } },
      archivedBy: { select: { id: true, fullName: true } },
      members: { include: { user: { select: { id: true, fullName: true, designation: true, employeeCode: true } } }, orderBy: { addedAt: "asc" } },
      statusUpdates: { orderBy: { createdAt: "desc" }, take: 1, include: { author: { select: { id: true, fullName: true } } } },
    },
  });
  if (!project) throw new NotFoundError("Project");
  const [counts, capabilities] = await Promise.all([
    taskCountsByProject(actor, [project.id]),
    capabilitiesFor(actor, project.id, project.archivedAt !== null),
  ]);
  return { project, counts: counts.get(project.id) ?? EMPTY_COUNTS, capabilities };
}

/** Projects the actor can create tasks in (manageable, not archived, not closed). */
export async function listProjectOptions(actor: Actor, opts: { forTaskCreation?: boolean } = {}) {
  const where: Prisma.ProjectWhereInput = opts.forTaskCreation
    ? { AND: [projectManageWhere(actor), { archivedAt: null }, { status: { notIn: ["CANCELLED"] } }] }
    : { AND: [projectAccessWhere(actor)] };
  return db.project.findMany({ where, orderBy: { name: "asc" }, select: { id: true, code: true, name: true }, take: 1000 });
}

function parseProject(input: unknown): ProjectData {
  const parsed = projectInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Please correct the highlighted fields.", zodFieldErrors(parsed.error.issues));
  return parsed.data;
}

async function assertActiveUsers(tx: Tx, organizationId: string, ids: string[], field: string) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await tx.user.count({ where: { id: { in: unique }, organizationId, status: "ACTIVE" } });
  if (found !== unique.length) throw new ValidationError("Selected people must be active team members.", { [field]: "One or more selected people are inactive or do not exist." });
}

function projectFields(data: ProjectData) {
  return {
    name: data.name,
    siteAddress: data.siteAddress,
    description: data.description,
    startDate: toDbDate(data.startDate),
    expectedCompletionDate: toDbDate(data.expectedCompletionDate),
    priority: data.priority,
    status: data.status,
    managerId: data.managerId,
  };
}

export async function createProject(actor: Actor, input: unknown) {
  if (!can(actor, "projects.create")) throw new ForbiddenError();
  const data = parseProject(input);
  return db.$transaction(async (tx) => {
    await assertActiveUsers(tx, actor.organizationId, [...(data.managerId ? [data.managerId] : []), ...data.memberIds], "memberIds");
    const code = await nextCode(tx, actor.organizationId, "PROJECT");
    const project = await tx.project.create({
      data: {
        ...projectFields(data),
        organizationId: actor.organizationId,
        code,
        createdById: actor.id,
        members: { create: [...new Set(data.memberIds)].map((userId) => ({ userId })) },
      },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "project.created", entityType: "project", entityId: project.id, summary: `Created project ${code} – ${project.name}` }, tx);
    return project;
  });
}

async function findManageable(tx: Tx, actor: Actor, id: string) {
  const project = await tx.project.findFirst({ where: { AND: [projectManageWhere(actor), { id }] }, include: { members: true } });
  if (!project) {
    // Distinguish "can see but not manage" (403) from "cannot see" (404) without leaking existence.
    const visible = await tx.project.count({ where: { AND: [projectAccessWhere(actor), { id }] } });
    if (visible) throw new ForbiddenError();
    throw new NotFoundError("Project");
  }
  return project;
}

export async function updateProject(actor: Actor, id: string, input: unknown) {
  if (!can(actor, "projects.edit")) throw new ForbiddenError();
  const data = parseProject(input);
  return db.$transaction(async (tx) => {
    const before = await findManageable(tx, actor, id);
    await assertActiveUsers(
      tx,
      actor.organizationId,
      [...(data.managerId && data.managerId !== before.managerId ? [data.managerId] : []), ...data.memberIds.filter((m) => !before.members.some((x) => x.userId === m))],
      "memberIds",
    );
    const nextMembers = new Set(data.memberIds);
    const current = new Set(before.members.map((m) => m.userId));
    const toAdd = [...nextMembers].filter((m) => !current.has(m));
    const toRemove = [...current].filter((m) => !nextMembers.has(m));
    const project = await tx.project.update({
      where: { id },
      data: {
        ...projectFields(data),
        members: {
          deleteMany: toRemove.length ? { userId: { in: toRemove } } : undefined,
          create: toAdd.map((userId) => ({ userId })),
        },
      },
    });
    const changed = (Object.keys(projectFields(data)) as (keyof ReturnType<typeof projectFields>)[]).filter(
      (k) => String(before[k] ?? "") !== String(project[k] ?? ""),
    );
    await writeAudit(
      {
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: "project.updated",
        entityType: "project",
        entityId: id,
        summary: `Updated project ${project.code}`,
        metadata: { changed, membersAdded: toAdd.length, membersRemoved: toRemove.length, ...(before.status !== project.status ? { status: { from: before.status, to: project.status } } : {}) },
      },
      tx,
    );
    return project;
  });
}

export async function setProjectArchived(actor: Actor, id: string, archived: boolean) {
  if (!can(actor, "projects.archive")) throw new ForbiddenError();
  return db.$transaction(async (tx) => {
    const before = await findManageable(tx, actor, id);
    if (archived === (before.archivedAt !== null)) return before;
    const project = await tx.project.update({
      where: { id },
      data: archived ? { archivedAt: new Date(), archivedById: actor.id } : { archivedAt: null, archivedById: null },
    });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: archived ? "project.archived" : "project.restored", entityType: "project", entityId: id, summary: `${archived ? "Archived" : "Restored"} project ${project.code}` }, tx);
    return project;
  });
}

/** Appends a status paragraph. History rows are never updated or deleted. */
export async function addStatusUpdate(actor: Actor, input: unknown) {
  if (!can(actor, "projects.post_status")) throw new ForbiddenError();
  const parsed = statusUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Please correct the highlighted fields.", zodFieldErrors(parsed.error.issues));
  return db.$transaction(async (tx) => {
    const project = await findManageable(tx, actor, parsed.data.projectId);
    if (project.archivedAt) throw new ValidationError("Archived projects cannot receive status updates. Restore the project first.");
    const update = await tx.projectStatusUpdate.create({ data: { projectId: project.id, body: parsed.data.body, authorId: actor.id } });
    await tx.project.update({ where: { id: project.id }, data: { updatedAt: new Date() } });
    await writeAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "project.status_posted", entityType: "project", entityId: project.id, summary: `Posted status update on ${project.code}` }, tx);
    return update;
  });
}

export async function listStatusUpdates(actor: Actor, projectId: string, page = 1, pageSize = 20) {
  const visible = await db.project.count({ where: { AND: [projectAccessWhere(actor), { id: projectId }] } });
  if (!visible) throw new NotFoundError("Project");
  const [total, rows] = await Promise.all([
    db.projectStatusUpdate.count({ where: { projectId } }),
    db.projectStatusUpdate.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { author: { select: { id: true, fullName: true } } },
    }),
  ]);
  return { rows, total, page, pageSize };
}

/** Project activity: project audit events + activity of tasks visible to the actor, merged by time. */
export async function projectActivity(actor: Actor, projectId: string, limit = 50) {
  const visible = await db.project.count({ where: { AND: [projectAccessWhere(actor), { id: projectId }] } });
  if (!visible) throw new NotFoundError("Project");
  const [audits, taskEvents] = await Promise.all([
    db.auditLog.findMany({
      where: { organizationId: actor.organizationId, entityType: "project", entityId: projectId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { actor: { select: { fullName: true } } },
    }),
    db.taskActivity.findMany({
      where: { task: { AND: [taskAccessWhere(actor), { projectId }] } },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { actor: { select: { fullName: true } }, task: { select: { id: true, code: true, title: true } } },
    }),
  ]);
  type Item = { id: string; at: Date; actor: string; text: string; href?: string };
  const items: Item[] = [
    ...audits.map((a) => ({ id: a.id, at: a.createdAt, actor: a.actor?.fullName ?? "System", text: a.summary ?? a.action })),
    ...taskEvents.map((t) => ({ id: t.id, at: t.createdAt, actor: t.actor.fullName, text: `${t.task.code} ${t.task.title}: ${t.action.replaceAll("_", " ").toLowerCase()}`, href: `/tasks/${t.task.id}` })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
