/**
 * Read-only stock posting + accounts reconciliation audit (workflow v2 · Phases 4 and 8). Prints duplicate / inconsistent postings
 * for every organisation in the database at DATABASE_URL. Changes nothing.
 *
 *   DATABASE_URL=postgresql://…local… npx tsx scripts/audit-stock-postings.ts
 *
 * Never point it at production without the owner's approval (it only reads, but still).
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { accountsReconciliation } from "../src/modules/insights/project-accounts";
import { inventoryIntegrityReport } from "../src/modules/inventory/integrity";

async function main() {
  const orgs = await db.organization.findMany({ select: { id: true, name: true } });
  let errors = 0;
  for (const o of orgs) {
    const r = await inventoryIntegrityReport(o.id);
    errors += r.errors;
    console.log(`\n${o.name}: ${r.errors} error(s), ${r.warnings} warning(s)`);
    for (const i of r.issues) console.log(`  [${i.severity}] ${i.code}: ${i.detail} ${JSON.stringify(i.ref)}`);
    // Workflow v2 · Phase 8: settlement counters vs allocations / refunds.
    const acc = await accountsReconciliation(o.id);
    errors += acc.errors;
    console.log(`  accounts reconciliation: ${acc.errors} mismatch(es)`);
    for (const i of acc.issues) console.log(`  [error] ${i.code}: ${i.detail}`);
  }
  await db.$disconnect();
  process.exit(errors ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(2);
});
