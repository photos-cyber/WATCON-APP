import { expect, it } from "vitest";
import { db } from "@/lib/db";
import { projectAccountsSummary } from "@/modules/insights/accounts";
import { commercialFixture } from "./commercial-helpers";

it("includes every accessible project in accounts rather than silently truncating at 1000", async () => {
  const fx = await commercialFixture();
  await db.project.createMany({ data: Array.from({ length: 1001 }, (_, n) => ({ organizationId: fx.org.id, code: `AUDIT-LARGE-${n}`, name: `Large portfolio ${n}`, siteAddress: "Fictional site", description: "Disposable regression fixture", managerId: fx.roles.pm.user.id, createdById: fx.users.admin.id })) });
  const summary = await projectAccountsSummary(fx.actors.superAdmin);
  expect(summary.rows).toHaveLength(1003);
  expect(new Set(summary.rows.map((r) => r.project.id)).size).toBe(1003);
  expect(summary.totals.receivable).toBe("0.00");
  const outsider = await projectAccountsSummary({ ...fx.roles.outsider.actor, permissions: [...fx.roles.outsider.actor.permissions, "accounts.view"] });
  expect(outsider.rows).toHaveLength(0);
}, 60_000);
