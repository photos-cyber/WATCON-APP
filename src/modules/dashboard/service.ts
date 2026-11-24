import "server-only";
import { db } from "@/lib/db";
import { can, type Actor } from "@/lib/permissions/definitions";
import { memberAccessWhere, projectAccessWhere, taskAccessWhere } from "@/lib/permissions/scopes";
import { OPEN_STATUSES, startOfToday } from "@/modules/tasks/rules";
import { taskCountsByProject } from "@/modules/projects/service";
import { taskListSelect } from "@/modules/tasks/service";

/**
 * All dashboard figures are computed from live database records and are scoped to
 * what the actor is authorized to see.
 *   Pending = To Do + Blocked; In Progress = In Progress; Overdue = open with due date before today.
 */
export async function getDashboard(actor: Actor) {
  const today = startOfToday();
  const projectScope = { AND: [projectAccessWhere(actor), { archivedAt: null }] };
  const taskScope = taskAccessWhere(actor);
  const showMembers = can(actor, "members.view");

  const [projectGroups, taskGroups, overdueCount, departmentCount, memberCount, recentProjects, myTasks, overdueTasks, activity] = await Promise.all([
    db.project.groupBy({ by: ["status"], where: projectScope, _count: { _all: true } }),
    db.task.groupBy({ by: ["status"], where: taskScope, _count: { _all: true } }),
    db.task.count({ where: { AND: [taskScope, { status: { in: OPEN_STATUSES } }, { dueDate: { lt: today } }] } }),
    db.department.count({ where: { organizationId: actor.organizationId, status: "ACTIVE" } }),
    showMembers ? db.user.count({ where: { AND: [memberAccessWhere(actor), { status: "ACTIVE" }] } }) : Promise.resolve(null),
    db.project.findMany({
      where: projectScope,
      orderBy: { updatedAt: "desc" },
      take: 6,
      select: { id: true, code: true, name: true, siteAddress: true, status: true, updatedAt: true },
    }),
    db.task.findMany({
      where: { AND: [taskScope, { assignees: { some: { userId: actor.id } } }, { status: { in: OPEN_STATUSES } }] },
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { priority: "desc" }],
      take: 8,
      select: taskListSelect,
    }),
    db.task.findMany({
      where: { AND: [taskScope, { status: { in: OPEN_STATUSES } }, { dueDate: { lt: today } }] },
      orderBy: [{ dueDate: "asc" }, { priority: "desc" }],
      take: 8,
      select: taskListSelect,
    }),
    db.taskActivity.findMany({
      where: { task: taskScope },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { actor: { select: { fullName: true } }, task: { select: { id: true, code: true, title: true, project: { select: { name: true } } } } },
    }),
  ]);

  const pc = (s: string) => projectGroups.find((g) => g.status === s)?._count._all ?? 0;
  const tc = (s: string) => taskGroups.find((g) => g.status === s)?._count._all ?? 0;
  const counts = await taskCountsByProject(actor, recentProjects.map((p) => p.id));

  return {
    metrics: {
      totalProjects: projectGroups.reduce((n, g) => n + g._count._all, 0),
      activeProjects: pc("ACTIVE"),
      completedProjects: pc("COMPLETED"),
      totalTasks: taskGroups.reduce((n, g) => n + g._count._all, 0),
      pendingTasks: tc("TODO") + tc("BLOCKED"),
      inProgressTasks: tc("IN_PROGRESS"),
      completedTasks: tc("COMPLETED"),
      overdueTasks: overdueCount,
      totalDepartments: departmentCount,
      totalMembers: memberCount,
    },
    recentProjects: recentProjects.map((p) => ({ ...p, counts: counts.get(p.id) ?? { total: 0, completed: 0, cancelled: 0, open: 0, progress: 0, taskProgress: 0, progressBasis: "tasks" as const, delivery: null } })),
    myTasks,
    overdueTasks,
    activity,
    quickActions: {
      createProject: can(actor, "projects.create"),
      createTask: can(actor, "tasks.create"),
      addDepartment: can(actor, "departments.manage"),
      addMember: can(actor, "members.manage"),
    },
  };
}
