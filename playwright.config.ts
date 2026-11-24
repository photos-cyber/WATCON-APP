import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export const E2E = {
  baseURL: `http://localhost:${PORT}`,
  databaseUrl: process.env.E2E_DATABASE_URL ?? "postgresql://watcon:watcon_local_dev@localhost:5433/watcon_e2e",
  // Disposable test-database fixture only (never used outside the throwaway _e2e database).
  superAdmin: { email: "e2e.super@example.test", username: "e2esuper", password: "E2e-super-admin-2026", name: "E2E Super Admin" },
};

/**
 * E2E runs against the PRODUCTION build (`npm run build` first) on port 3100 with a
 * dedicated database that is reset on every run.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: E2E.baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node tests/e2e/prepare-db.mjs && node node_modules/next/dist/bin/next start -p ${PORT}`,
    url: `${E2E.baseURL}/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    env: {
      DATABASE_URL: E2E.databaseUrl,
      APP_URL: E2E.baseURL,
      MAIL_TRANSPORT: "console",
      // Do not inherit a production CA from .env into the disposable local DB.
      DB_SSL_CA: process.env.E2E_DB_SSL_CA ?? "",
      BOOTSTRAP_ORG_NAME: "Watcon E2E",
      BOOTSTRAP_ADMIN_NAME: E2E.superAdmin.name,
      BOOTSTRAP_ADMIN_EMAIL: E2E.superAdmin.email,
      BOOTSTRAP_ADMIN_USERNAME: E2E.superAdmin.username,
      BOOTSTRAP_ADMIN_PASSWORD: E2E.superAdmin.password,
    },
  },
});
