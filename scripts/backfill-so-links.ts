/**
 * SO / PO driven workflow (2026-11-27): links legacy client-side records to their sales order ONLY where
 * the relationship is unambiguous, and reports everything else. Dry run by default; `--apply` writes.
 *
 *   DATABASE_URL=postgresql://…local… npx tsx scripts/backfill-so-links.ts [--apply]
 *
 * What it does:
 *   1. Site-issue challan lines without a sales-order line (ISSUE_TO_SITE, project set): linked when the
 *      project has exactly ONE confirmed sales-order material line for that item–brand. Several candidate
 *      lines = ambiguous → reported, left unlinked (billing keeps sharing them FIFO, as before).
 *   2. Client receipts without a sales order: reported only (never assigned). A receipt whose live
 *      allocations all settle invoices of one sales order is listed as "could be linked" for a person to decide.
 *   3. Running bills / invoices: already carry so_id or client_po_id (CHECK constraints) — counted only.
 *
 * Never deletes anything. Never point it at production without the owner's approval.
 */
import "dotenv/config";
import { db } from "../src/lib/db";

const apply = process.argv.includes("--apply");
const CONFIRMED = ["APPROVED", "PARTIALLY_FULFILLED", "FULFILLED", "CLOSED"] as const;

async function main() {
  // 1. Challan lines → sales-order lines.
  const lines = await db.challanLine.findMany({
    where: { soLineId: null, challan: { type: "ISSUE_TO_SITE", projectId: { not: null }, status: { not: "CANCELLED" } } },
    select: { id: true, itemBrandId: true, lineNo: true, challan: { select: { number: true, projectId: true } } },
  });
  let linked = 0;
  const ambiguous: string[] = [];
  const noOrder: string[] = [];
  for (const l of lines) {
    const candidates = await db.soLine.findMany({ where: { kind: "MATERIAL", itemBrandId: l.itemBrandId, so: { projectId: l.challan.projectId!, status: { in: [...CONFIRMED] } } }, select: { id: true, so: { select: { number: true } } } });
    const ref = `${l.challan.number} line ${l.lineNo}`;
    if (candidates.length === 1) {
      linked++;
      if (apply) await db.challanLine.update({ where: { id: l.id }, data: { soLineId: candidates[0]!.id } });
    } else if (candidates.length > 1) ambiguous.push(`${ref}: ${candidates.map((c) => c.so.number).join(", ")}`);
    else noOrder.push(ref);
  }
  console.log(`Site challan lines without an order line: ${lines.length}`);
  console.log(`  ${apply ? "linked" : "would link"} (one candidate order line): ${linked}`);
  console.log(`  ambiguous (several orders carry the item) — left unlinked: ${ambiguous.length}`);
  for (const a of ambiguous) console.log(`    - ${a}`);
  console.log(`  no confirmed order carries the item — left unlinked: ${noOrder.length}`);

  // 2. Client receipts without a sales order (report only).
  const receipts = await db.payment.findMany({
    where: { direction: "IN", soId: null, status: "POSTED", refundOfId: null },
    select: { number: true, allocations: { where: { reversedAt: null }, select: { clientInvoice: { select: { soId: true } } } } },
  });
  const single = receipts.filter((r) => {
    const sos = new Set(r.allocations.map((a) => a.clientInvoice?.soId ?? "none"));
    return sos.size === 1 && !sos.has("none");
  });
  console.log(`\nClient receipts without a sales order: ${receipts.length} (kept project-level; not changed)`);
  console.log(`  all allocations on one sales order (a person may link them): ${single.length}${single.length ? ` — ${single.map((r) => r.number).join(", ")}` : ""}`);

  // 3. Basis of running bills / invoices.
  const [raSo, raCpo, invNoSo] = await Promise.all([
    db.raBill.count({ where: { soId: { not: null } } }),
    db.raBill.count({ where: { clientPoId: { not: null } } }),
    db.clientInvoice.count({ where: { soId: null, status: { not: "CANCELLED" } } }),
  ]);
  console.log(`\nRunning bills: ${raSo} on sales orders, ${raCpo} on client POs (legacy, unchanged).`);
  console.log(`Live client invoices without a sales order (client-PO / legacy): ${invNoSo} (unchanged).`);
  console.log(apply ? "\nApplied." : "\nDry run — nothing changed. Re-run with --apply to link the unambiguous challan lines.");
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
