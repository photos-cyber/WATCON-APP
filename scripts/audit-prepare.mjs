import pg from "pg";
const c = new pg.Client({ connectionString: "postgresql://audit:audit_local_only@localhost:5544/postgres" });
await c.connect();
if (!(await c.query("SELECT 1 FROM pg_database WHERE datname=$1", ["watcon_regression_test"])).rowCount) await c.query("CREATE DATABASE watcon_regression_test");
await c.end();
// Only the fictional training fixture database is updated; no .env is read.
const t = new pg.Client({ connectionString: "postgresql://audit:audit_local_only@localhost:5544/watcon_audit_test" });
await t.connect();
await t.query("UPDATE users SET username='audit.trainer', email='audit.trainer@example.test' WHERE full_name='Sam Super'");
await t.end();
