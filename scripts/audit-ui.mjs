// Read-only UI checks against fictional LOCAL training records. Never targets production.
import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";

const base = "http://localhost:3200";
const results = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
const out = "docs/user-guide/screenshots";
mkdirSync(out, { recursive: true });
const save = () => writeFileSync("docs/audit/evidence/local-ui-results.json", JSON.stringify({ results, consoleErrors }, null, 2));
async function login(p, email) {
  await p.goto(`${base}/login`);
  await p.getByLabel("Email or username").fill(email);
  await p.getByLabel("Password", { exact: true }).fill("Test-password-123");
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await p.waitForURL("**/dashboard");
}
async function capture(name) {
  // Numbered annotations sit over actual rendered UI, and are removed after capture.
  await page.evaluate(() => {
    const el = document.querySelector('main h1');
    if (el) { const r = el.getBoundingClientRect(); const badge = document.createElement('span'); badge.id = 'audit-annotation'; badge.textContent = '1  Page name'; Object.assign(badge.style, { position: 'absolute', left: `${r.right + scrollX + 8}px`, top: `${r.top + scrollY}px`, background: '#075985', color: 'white', padding: '4px 8px', font: 'bold 12px Arial', borderRadius: '4px', zIndex: '99999' }); document.body.append(badge); }
  });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  await page.evaluate(() => document.getElementById('audit-annotation')?.remove());
}
try {
  await login(page, "audit.trainer");
  const articles = JSON.parse(readFileSync("src/modules/help/content.json", "utf8"));
  for (const a of articles.filter((a) => a.category === "All Modules")) {
    const response = await page.goto(`${base}${a.route}`);
    await page.locator("main h1").waitFor();
    const error = await page.getByText("Something went wrong", { exact: true }).count();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    results.push({ id: `LOCAL-${a.id}`, name: `Desktop ${a.title} opens`, status: response?.ok() && !error ? "passed" : "failed", path: a.route, http: response?.status(), overflow });
    if (["projects", "stock", "purchase-orders", "site-receipts", "challans", "supplier-bills", "running-bills", "accounts", "payments", "tasks"].includes(a.id)) await capture(`local-${a.id}`);
    save();
    console.log(`${a.title}: ${response?.status()}`);
  }
  for (const route of ["/projects/new", "/purchase-orders/new", "/sales-orders/new", "/supplier-bills/new", "/payments/new"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}${route}`);
    await page.locator("main h1").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    results.push({ id: `MOBILE-${route.split('/')[1]}`, name: `Mobile ${route} fits viewport`, status: overflow ? "failed" : "passed", path: route });
    if (route === "/purchase-orders/new") await capture("local-po-mobile");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/help`);
  await page.getByLabel("Search help articles").fill("insufficient stock");
  const found = await page.getByRole("heading", { name: "Troubleshooting", exact: true }).count();
  results.push({ id: "HELP-SEARCH", name: "Help search finds troubleshooting", status: found ? "passed" : "failed" });
  await page.getByLabel("Search help articles").fill("");
  await capture("local-help");
  for (const format of ["pdf", "quick", "docx"]) {
    const r = await context.request.get(`${base}/api/help/manual?format=${format}`);
    const b = await r.body();
    const valid = format === "docx" ? b.subarray(0,2).toString() === "PK" : b.subarray(0,4).toString() === "%PDF";
    results.push({ id: `MANUAL-${format}`, name: `Authenticated ${format} manual download`, status: r.ok() && valid ? "passed" : "failed", http: r.status() });
  }
  // Verify each implemented system role through its own normal login.
  const client = new pg.Client({ connectionString: "postgresql://audit:audit_local_only@localhost:5544/watcon_audit_test" });
  await client.connect();
  const { rows } = await client.query("SELECT DISTINCT ON (r.key) u.email, r.key FROM users u JOIN roles r ON r.id=u.role_id ORDER BY r.key,u.created_at");
  await client.end();
  const catalog = JSON.parse(readFileSync("docs/audit/evidence/permission-catalog.json", "utf8"));
  for (const row of rows) {
    const c = await browser.newContext();
    const p = await c.newPage();
    await login(p, row.email);
    await p.goto(`${base}/supplier-bills`);
    const expected = catalog.roles.find((r) => r.key === row.key).permissions.includes("bills.view");
    // Server-component redirects may arrive after the initial streamed response.
    await expect(p).toHaveURL(expected ? /\/supplier-bills$/ : /\/dashboard\?denied=1$/);
    const allowed = new URL(p.url()).pathname === "/supplier-bills";
    results.push({ id: `ROLE-${row.key}`, name: `${row.key} supplier-bill page permission`, status: allowed === expected ? "passed" : "failed" });
    await p.goto(`${base}/help`);
    if (row.key === "SUPER_ADMIN") await expect(p.getByLabel("Search help articles")).toBeVisible();
    else await expect(p.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    const manual = await c.request.get(`${base}/api/help/manual`);
    results.push({ id: `ROLE-HELP-${row.key}`, name: `${row.key} Super-Admin-only help and manual access`, status: manual.status() === (row.key === "SUPER_ADMIN" ? 200 : 404) ? "passed" : "failed", http: manual.status() });
    await c.close(); save();
  }
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/login");
  results.push({ id: "LOCAL-LOGOUT", name: "Local normal logout", status: "passed" });
  const r = await context.request.get(`${base}/api/help/manual`);
  results.push({ id: "HELP-UNAUTH", name: "Signed-out manual access blocked", status: r.status() === 401 ? "passed" : "failed", http: r.status() });
} catch (e) {
  results.push({ id: "UI-RUN-ERROR", name: "UI runner completed", status: "failed", error: String(e) });
  console.error(String(e));
  process.exitCode = 1;
} finally { save(); await browser.close(); }
