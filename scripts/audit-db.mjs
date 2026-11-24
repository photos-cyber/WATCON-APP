// A separate, local-only PostgreSQL cluster. Never reads .env or touches .pgdata.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const databaseDir = path.resolve(".audit-pgdata");
const server = new EmbeddedPostgres({ databaseDir, port: 5544, user: "audit", password: "audit_local_only", persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: (e) => console.error(String(e).trim()) });
if (!existsSync(path.join(databaseDir, "PG_VERSION"))) await server.initialise();
await server.start();
const client = new pg.Client({ connectionString: "postgresql://audit:audit_local_only@localhost:5544/postgres" });
await client.connect();
for (const name of ["watcon_audit_test", "watcon_audit_e2e"]) {
  if (!(await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount) await client.query(`CREATE DATABASE "${name}"`);
}
await client.end();
console.log("Isolated audit databases ready on localhost:5544");
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.stop(); process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
