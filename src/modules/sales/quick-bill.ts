import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import type { Actor } from "@/lib/permissions/definitions";
import { optionalText, uuid } from "@/lib/validations/common";
import { parseInput, requireAnyPermission } from "@/modules/commercial/core";
import { startOfToday } from "@/modules/tasks/rules";
import { clientInvoiceAction, createClientInvoice } from "./invoice";
import { certifyRaBill } from "./ra-bill";

const schema = z.object({ clientCertRef: optionalText("Client reference", 100), issue: z.boolean().default(true) });

/**
 * Simplified workflow: "Client accepted — invoice now". For the common case where the client accepts
 * the running bill as submitted, this does in one click what used to take three screens:
 *   1. certify every line at its claimed quantity (existing deductions kept),
 *   2. create the invoice from the certified bill,
 *   3. issue it (when `issue`), allocating the invoice number.
 * Each step is the existing, fully-checked service, so no limit or duplicate guard is bypassed. If a
 * later step fails (e.g. no place of supply) the earlier ones stay done and the user finishes it from
 * the bill / invoice page.
 */
export async function acceptRaBillAndInvoice(actor: Actor, raBillId: string, input: unknown) {
  requireAnyPermission(actor, ["rabill.certify", "rabill.manage"], "You do not have permission to record client certification.");
  requireAnyPermission(actor, ["invoice.manage", "invoice.approve"], "You do not have permission to create invoices.");
  const data = parseInput(schema, input);
  const id = parseInput(uuid, raBillId);
  const bill = await db.raBill.findFirst({ where: { id, organizationId: actor.organizationId }, include: { lines: true } });
  if (!bill) throw new ValidationError("Running bill not found.");
  if (!["SUBMITTED", "DISPUTED"].includes(bill.status)) throw new ValidationError("Only a bill submitted to the client can be accepted.");
  const today = startOfToday().toISOString().slice(0, 10);
  await certifyRaBill(actor, id, bill.version, {
    clientCertRef: data.clientCertRef ?? "Accepted as claimed",
    clientCertDate: today,
    otherDeductions: bill.otherDeductions.toFixed(2),
    deductionNotes: bill.deductionNotes,
    lines: bill.lines.map((l) => ({ lineId: l.id, certifiedQty: l.claimedQty.toFixed(3) })),
  });
  const inv = await createClientInvoice(actor, { source: "RA", raBillId: id, invoiceDate: today });
  if (!data.issue) return { invoiceId: inv.id, issued: false, issueError: null as string | null };
  try {
    const fresh = await db.clientInvoice.findUniqueOrThrow({ where: { id: inv.id }, select: { version: true } });
    await clientInvoiceAction(actor, inv.id, "issue", { version: fresh.version });
    return { invoiceId: inv.id, issued: true, issueError: null };
  } catch (e) {
    return { invoiceId: inv.id, issued: false, issueError: e instanceof Error ? e.message : "Could not issue the invoice." };
  }
}
