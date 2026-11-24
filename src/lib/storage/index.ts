import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { db, type Tx } from "@/lib/db";

/**
 * File storage abstraction for attachments.
 *
 *  - "database" (default): bytes in `attachment_blobs`, written in the SAME transaction as the
 *    attachment metadata, so a failed upload can never leave a half-saved record. Works on
 *    serverless hosts (Vercel) that have no persistent disk.
 *  - "filesystem": bytes under STORAGE_DIR (self-hosted servers with a backed-up volume).
 *
 * A future Firebase Cloud Storage driver implements the same interface; the attachment rows
 * keep `storage_driver` + `storage_key`, so files written by different drivers can coexist
 * during a migration.
 */
export interface StorageDriver {
  readonly name: string;
  /** `tx` is passed when the caller is inside a DB transaction (only the database driver uses it). */
  put(key: string, bytes: Buffer, tx?: Tx): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const databaseDriver: StorageDriver = {
  name: "database",
  async put(key, bytes, tx) {
    await (tx ?? db).attachmentBlob.create({ data: { key, data: new Uint8Array(bytes) } });
  },
  async get(key) {
    const row = await db.attachmentBlob.findUnique({ where: { key } });
    return row ? Buffer.from(row.data) : null;
  },
  async remove(key) {
    await db.attachmentBlob.deleteMany({ where: { key } });
  },
};

function fsRoot() {
  // Runtime user data lives on a separately managed volume; never bundle its contents.
  return path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_DIR || "storage");
}

/** Keys are generated server-side (UUID based); this guard rejects anything path-like anyway. */
function safePath(key: string) {
  if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
  const p = path.join(/* turbopackIgnore: true */ fsRoot(), key);
  if (!p.startsWith(fsRoot())) throw new Error("Invalid storage key");
  return p;
}

const filesystemDriver: StorageDriver = {
  name: "filesystem",
  async put(key, bytes) {
    const p = safePath(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes, { flag: "wx" });
  },
  async get(key) {
    try {
      return await readFile(/* turbopackIgnore: true */ safePath(key));
    } catch {
      return null;
    }
  },
  async remove(key) {
    await rm(safePath(key), { force: true });
  },
};

const DRIVERS: Record<string, StorageDriver> = { database: databaseDriver, filesystem: filesystemDriver };

/** Driver used for NEW uploads. */
export function activeDriver(): StorageDriver {
  const name = process.env.STORAGE_DRIVER || "database";
  const d = DRIVERS[name];
  if (!d) throw new Error(`Unknown STORAGE_DRIVER "${name}"`);
  return d;
}

/** Driver that holds an existing file. */
export function driverFor(name: string): StorageDriver {
  const d = DRIVERS[name];
  if (!d) throw new Error(`Storage driver "${name}" is not available in this deployment`);
  return d;
}

/** Upload limit. Vercel functions reject request bodies above 4.5 MB, hence the 4 MB default. */
export function maxUploadBytes(): number {
  const mb = Number(process.env.MAX_UPLOAD_MB || 4);
  return Math.max(1, Math.min(50, Number.isFinite(mb) ? mb : 4)) * 1024 * 1024;
}
