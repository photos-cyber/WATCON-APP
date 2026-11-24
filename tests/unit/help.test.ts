import { expect, it } from "vitest";
import { HELP_ARTICLES, helpForActor } from "@/modules/help/articles";
import { defaultPermissionsFor, type RoleKey } from "@/lib/permissions/definitions";
const actor = (role: RoleKey) => ({ id: "test", organizationId: "test", role, permissions: defaultPermissionsFor(role) });
it("uses unique article identifiers and keeps manuals free of business records", () => {
  expect(new Set(HELP_ARTICLES.map((a) => a.id)).size).toBe(HELP_ARTICLES.length);
  expect(HELP_ARTICLES.every((a) => a.sections.length > 0)).toBe(true);
});
it("limits module instructions and role guides to the reader's grants", () => {
  const ids = helpForActor(actor("USER")).map((a) => a.id);
  expect(ids).toContain("getting-started");
  expect(ids).toContain("role-user");
  expect(ids).not.toContain("supplier-bills");
  expect(ids).not.toContain("administration");
  expect(ids).not.toContain("role-super_admin");
  expect(helpForActor(actor("SUPER_ADMIN"))).toHaveLength(HELP_ARTICLES.length);
  expect(helpForActor(actor("PROJECT_MANAGER")).map((a) => a.id)).toContain("role-project_manager-sales");
});
