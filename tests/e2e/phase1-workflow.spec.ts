import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E } from "../../playwright.config";

/**
 * Full Phase 1 workflow, executed serially against the production build.
 * Super Admin → Admin, departments, members, project, status, multi-assigned task →
 * assignee updates progress → admin sees it, filters, prints, exports PDF, opens
 * WhatsApp → authorization, invalid input, inactive account and expired session checks.
 */
test.describe.configure({ mode: "serial" });

const TEMP_PASSWORD = "Temp-pass-2026x";
const NEW_PASSWORD = "Own-pass-2026y";
const admin = { name: "Alice Admin", email: "alice.admin@example.test", username: "alice.admin" };
const amit = { name: "Amit Kumar", email: "amit@example.test", username: "amit.k", whatsapp: "9876543210" };
const rahul = { name: "Rahul Singh", email: "rahul@example.test", username: "rahul.s" };
const sara = { name: "Sara Khan", email: "sara@example.test", username: "sara.k" };
const PROJECT = "Site Alpha";
const TASK = "Install Electrical Panel";
const PRIVATE_TASK = "Rahul private survey";

let saPage: Page;
let projectUrl = "";
let taskUrl = "";
let privateTaskUrl = "";

async function login(page: Page, identifier: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(identifier);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function firstLoginChangePassword(browser: Browser, identifier: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, identifier, TEMP_PASSWORD);
  await expect(page).toHaveURL(/\/change-password/);
  await page.getByLabel("Current password").fill(TEMP_PASSWORD);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  return page;
}

async function pickMany(page: Page, triggerId: string, labels: string[]) {
  await page.locator(`#${triggerId}`).click();
  for (const label of labels) {
    await page.getByRole("option", { name: new RegExp(label) }).first().click();
  }
  await page.keyboard.press("Escape");
}

async function pickOne(page: Page, triggerId: string, label: string) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: new RegExp(label) }).first().click();
}

async function selectOption(page: Page, triggerId: string, label: string) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function createMember(page: Page, m: { name: string; email: string; username: string; whatsapp?: string }, role: "Admin" | "User", departments: string[] = []) {
  await page.goto("/team-members/new");
  await page.locator("#fullName").fill(m.name);
  await page.locator("#email").fill(m.email);
  await page.locator("#username").fill(m.username);
  if (m.whatsapp) await page.locator("#whatsappNumber").fill(m.whatsapp);
  await selectOption(page, "role", role);
  if (departments[0]) await pickOne(page, "primaryDepartmentId", departments[0]);
  if (departments.length > 1) await pickMany(page, "additionalDepartmentIds", departments.slice(1));
  await page.locator("#password").fill(TEMP_PASSWORD);
  await page.getByRole("button", { name: "Create member" }).click();
  await expect(page).toHaveURL(/\/team-members\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: m.name })).toBeVisible();
}

test("1-2. Super Admin logs in and creates an Admin", async ({ browser }) => {
  saPage = await (await browser.newContext()).newPage();
  await login(saPage, E2E.superAdmin.email, E2E.superAdmin.password);
  await expect(saPage).toHaveURL(/\/dashboard/);
  await expect(saPage.getByText("Total projects")).toBeVisible();
  // Departments needed for members are created first.
  for (const name of ["Electrical", "HSE"]) {
    await saPage.goto("/departments");
    await saPage.getByRole("button", { name: "Add department" }).click();
    await saPage.locator("#dep-name").fill(name);
    await saPage.getByRole("button", { name: "Create department" }).click();
    await expect(saPage.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await createMember(saPage, admin, "Admin", ["Electrical"]);
});

test("3. invalid department and duplicate names are rejected", async () => {
  await saPage.goto("/departments");
  await saPage.getByRole("button", { name: "Add department" }).click();
  await saPage.getByRole("button", { name: "Create department" }).click();
  await expect(saPage.getByRole("alert").first()).toBeVisible();
  await saPage.locator("#dep-name").fill("electrical");
  await saPage.getByRole("button", { name: "Create department" }).click();
  await expect(saPage.getByText(/already exists/).first()).toBeVisible();
  await saPage.keyboard.press("Escape");
});

test("4. creates team members with multiple departments", async () => {
  await createMember(saPage, amit, "User", ["Electrical", "HSE"]);
  await expect(saPage.getByText("Electrical").first()).toBeVisible();
  await expect(saPage.getByText("HSE").first()).toBeVisible();
  await createMember(saPage, rahul, "User", ["HSE"]);
  await createMember(saPage, sara, "User", ["Electrical"]);
});

test("5-6. creates a project (validation first) and posts status paragraphs", async () => {
  await saPage.goto("/projects/new");
  await saPage.getByRole("button", { name: "Create project" }).click();
  await expect(saPage.getByText("Site / project name is required.")).toBeVisible();

  await saPage.locator("#name").fill(PROJECT);
  await saPage.locator("#siteAddress").fill("Plot 4, Sector 18, Gurugram");
  await saPage.locator("#description").fill("Commercial building electrical and HSE works.");
  await saPage.locator("#startDate").fill("2026-11-01");
  await saPage.locator("#expectedCompletionDate").fill("2027-03-31");
  await selectOption(saPage, "status", "Active");
  await pickOne(saPage, "managerId", admin.name);
  await saPage.getByRole("button", { name: "Create project" }).click();
  await expect(saPage).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  projectUrl = new URL(saPage.url()).pathname;
  await expect(saPage.getByText(/^PRJ-\d{4}$/).first()).toBeVisible();

  await saPage.getByLabel("New status update").fill("Civil work for the second floor is completed.");
  await saPage.getByRole("button", { name: "Save update" }).click();
  await expect(saPage.getByRole("region", { name: "Current project status" }).getByText("Civil work for the second floor is completed.")).toBeVisible();
  await expect(saPage.getByLabel("New status update")).toHaveValue("");
  await saPage.getByLabel("New status update").fill("Electrical installation is currently in progress.");
  await saPage.getByRole("button", { name: "Save update" }).click();
  await expect(saPage.getByText("Electrical installation is currently in progress.").first()).toBeVisible();

  await saPage.goto(`${projectUrl}?tab=history`);
  await expect(saPage.getByText("Civil work for the second floor is completed.")).toBeVisible();
  await expect(saPage.getByText("Electrical installation is currently in progress.")).toBeVisible();
});

test("7-9. creates a task from the project page with multiple departments and members", async () => {
  await saPage.goto(projectUrl);
  await saPage.getByRole("link", { name: "Create task" }).first().click();
  await expect(saPage).toHaveURL(/\/tasks\/new\?projectId=/);
  await expect(saPage.locator("#projectId")).toContainText(PROJECT);

  // Owner must be an assignee; due date before start is rejected.
  await saPage.locator("#title").fill(TASK);
  await saPage.locator("#description").fill("Main LT panel on the ground floor. Coordinate with HSE for the permit to work.");
  await pickMany(saPage, "departmentIds", ["Electrical", "HSE"]);
  await pickMany(saPage, "assigneeIds", [amit.name, rahul.name, sara.name]);
  await pickOne(saPage, "ownerId", amit.name);
  await saPage.locator("#startDate").fill("2026-11-10");
  await saPage.locator("#dueDate").fill("2026-11-05");
  await saPage.getByRole("button", { name: "Create task" }).click();
  await expect(saPage.getByText("Due date cannot be earlier than the start date.")).toBeVisible();
  await saPage.locator("#dueDate").fill("2026-11-30");
  await saPage.getByRole("button", { name: "Create task" }).click();
  await expect(saPage).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  taskUrl = new URL(saPage.url()).pathname;
  await expect(saPage.getByRole("heading", { name: TASK })).toBeVisible();
  for (const n of [amit.name, rahul.name, sara.name, "Electrical", "HSE"]) await expect(saPage.getByText(n).first()).toBeVisible();

  // A second task only for Rahul (used for the authorization check).
  await saPage.goto(`/tasks/new?projectId=${projectUrl.split("/").pop()}`);
  await saPage.locator("#title").fill(PRIVATE_TASK);
  await pickMany(saPage, "assigneeIds", [rahul.name]);
  await saPage.getByRole("button", { name: "Create task" }).click();
  await expect(saPage).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  privateTaskUrl = new URL(saPage.url()).pathname;

  // One record, visible from the department page too.
  await saPage.goto("/departments");
  await saPage.getByRole("link", { name: "HSE", exact: true }).click();
  await expect(saPage.getByRole("link", { name: TASK })).toBeVisible();
});

test("10-12. assigned user logs in, sees the task and updates progress", async ({ browser }) => {
  const page = await firstLoginChangePassword(browser, amit.username);
  await page.goto("/tasks");
  await expect(page.getByRole("link", { name: TASK })).toBeVisible();
  await expect(page.getByRole("link", { name: PRIVATE_TASK })).toHaveCount(0);
  await page.getByRole("link", { name: TASK }).click();
  await page.getByRole("button", { name: "Update progress" }).click();
  await page.locator("#pd-progress").fill("40");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("40%").first()).toBeVisible();
  await expect(page.getByText(/In Progress/).first()).toBeVisible();
  await page.getByPlaceholder("Add a comment or site update…").fill("Panel delivered to site.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("Panel delivered to site.")).toBeVisible();

  // 18. Unauthorized access is blocked server-side.
  await page.goto(privateTaskUrl);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.goto("/team-members");
  await expect(page).toHaveURL(/\/dashboard\?denied=1/);
  await page.goto(`${projectUrl}/edit`);
  await expect(page).not.toHaveURL(/\/edit$/);
  const pdf = await page.request.get(`/api/reports/pdf?type=project&id=${projectUrl.split("/").pop()}`);
  expect(pdf.status()).toBe(404);
  const own = await page.request.get(`/api/reports/pdf?type=task&id=${taskUrl.split("/").pop()}`);
  expect(own.status()).toBe(200);
  await page.context().close();
});

test("13-17. admin sees the update, filters, prints, exports PDF and opens WhatsApp", async ({ browser }) => {
  const page = await firstLoginChangePassword(browser, admin.email);
  await page.goto(taskUrl);
  await expect(page.getByText("40%").first()).toBeVisible();
  await expect(page.getByText("Panel delivered to site.")).toBeVisible();

  // Global search (Ctrl K) returns scoped results and navigates.
  await page.getByRole("button", { name: /Search projects/ }).click();
  await page.keyboard.type("Electrical Panel", { delay: 30 });
  await page.getByRole("option", { name: new RegExp(TASK) }).click();
  await expect(page).toHaveURL(new RegExp(taskUrl));

  // 14. Combined filters through the URL (the same state the filter bar writes).
  const projectId = projectUrl.split("/").pop();
  await page.goto(`/tasks?projectId=${projectId}&status=IN_PROGRESS&dueFrom=2026-11-01&dueTo=2026-11-30`);
  await expect(page.getByRole("link", { name: TASK })).toBeVisible();
  await expect(page.getByRole("link", { name: PRIVATE_TASK })).toHaveCount(0);
  await page.getByPlaceholder("Search title, code or description…").fill("nothing-matches-this");
  await expect(page.getByText("No tasks found")).toBeVisible();

  // 15. Print layout.
  await page.goto(projectUrl);
  const printLink = page.getByRole("link", { name: "Print" }).first();
  const printHref = await printLink.getAttribute("href");
  expect(printHref).toContain("type=project");
  await page.goto(printHref!);
  await expect(page.getByRole("heading", { name: "Project Task List" })).toBeVisible();
  await expect(page.getByText(TASK)).toBeVisible();
  await expect(page.getByText(PRIVATE_TASK)).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("print-button")).toBeHidden();

  // 16. PDF export.
  const pdf = await page.request.get(`/api/reports/pdf?type=project&id=${projectId}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  // 17. WhatsApp click-to-chat (member list prefilled with the member's number).
  await page.emulateMedia({ media: "screen" });
  const amitRow = await page.request.get("/team-members?q=Amit");
  expect(amitRow.ok()).toBe(true);
  await page.goto("/team-members?q=Amit");
  await page.getByRole("link", { name: amit.name }).first().click();
  await page.getByRole("button", { name: "WhatsApp" }).click();
  await expect(page.getByLabel("WhatsApp number")).toHaveValue(amit.whatsapp);
  const href = await page.getByRole("link", { name: "Open WhatsApp" }).getAttribute("href");
  expect(href).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  expect(decodeURIComponent(href!.split("text=")[1]!)).toContain(TASK);
  await page.context().close();
});

test("18b. inactive accounts cannot sign in; expired/forged sessions are rejected", async ({ browser }) => {
  // Deactivate Sara.
  await saPage.goto("/team-members?q=Sara");
  await saPage.getByRole("link", { name: sara.name }).first().click();
  await saPage.getByRole("button", { name: "Deactivate" }).click();
  await saPage.getByRole("alertdialog").getByRole("button", { name: "Deactivate" }).click();
  await expect(saPage.getByText("Inactive").first()).toBeVisible();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, sara.username, TEMP_PASSWORD);
  await expect(page.getByText(/deactivated/)).toBeVisible();

  await ctx.addCookies([{ name: "wc_session", value: "forged-or-expired-token-value-000000000000", url: E2E.baseURL }]);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test("concurrent updates: a stale form is rejected instead of overwriting", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a, E2E.superAdmin.email, E2E.superAdmin.password);
  await login(b, rahul.username, TEMP_PASSWORD);
  await b.getByLabel("Current password").fill(TEMP_PASSWORD);
  await b.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await b.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await b.getByRole("button", { name: "Update password" }).click();
  await expect(b).toHaveURL(/\/dashboard/);
  for (const p of [a, b]) {
    await p.goto(taskUrl);
    await p.getByRole("button", { name: "Update progress" }).click();
  }
  await a.locator("#pd-progress").fill("60");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await expect(a.getByText("60%").first()).toBeVisible();
  await b.locator("#pd-progress").fill("70");
  await b.getByRole("button", { name: "Save", exact: true }).click();
  await expect(b.getByText(/changed by someone else/).first()).toBeVisible();
});
