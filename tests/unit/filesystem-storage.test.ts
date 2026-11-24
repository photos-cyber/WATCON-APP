import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { driverFor } from "@/lib/storage";

afterEach(() => vi.unstubAllEnvs());
it("keeps runtime filesystem uploads readable without bundling the user-data volume", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "watcon-audit-storage-"));
  vi.stubEnv("STORAGE_DIR", dir);
  const driver = driverFor("filesystem");
  await driver.put("audit/fixture", Buffer.from("fictional evidence"));
  expect((await driver.get("audit/fixture"))?.toString()).toBe("fictional evidence");
  await expect(driver.get("../outside")).resolves.toBeNull();
  await driver.remove("audit/fixture");
  expect(await driver.get("audit/fixture")).toBeNull();
});
