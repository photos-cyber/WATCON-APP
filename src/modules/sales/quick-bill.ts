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

/**
 * "Record client payment" on a running bill (owner rule 2026-11-27: the client pays the running bill). The
 * receivable is the bill's tax invoice, so this makes sure one exists and is issued, then returns where the
 * payment should go:
 *   - with the client (SUBMITTED / DISPUTED): accepted as claimed → invoice → issue (same as the quick button);
 *   - certified, not invoiced: invoice → issue;
 *   - invoice still a draft: issue it;
 *   - already issued / part paid: nothing to do.
 * The payment then settles that invoice; anything unpaid stays outstanding and is carried into the next
 * running bill's statement ("previous outstanding").
 */
export async function prepareRaBillPayment(actor: Actor, raBillId: string) {
  requireAnyPermission(actor, ["payments.manage"], "You do not have permission to record payments.");
  const id = parseInput(uuid, raBillId);
  const bill = await db.raBill.findFirst({ where: { id, organizationId: actor.organizationId }, select: { id: true, status: true, projectId: true, partyId: true, soId: true, invoice: { select: { id: true, status: true, version: true } } } });
  if (!bill) throw new ValidationError("Running bill not found.");
  if (["DRAFT", "INTERNAL_REVIEW"].includes(bill.status)) throw new ValidationError("Submit the bill to the client first.");
  if (bill.status === "CANCELLED") throw new ValidationError("This running bill is cancelled.");
  if (bill.status === "PAID") throw new ValidationError("This running bill is already fully paid.");
  const today = startOfToday().toISOString().slice(0, 10);
  let invoiceId = bill.invoice && bill.invoice.status !== "CANCELLED" ? bill.invoice.id : null;
  if (!invoiceId) {
    if (["SUBMITTED", "DISPUTED"].includes(bill.status)) {
      const r = await acceptRaBillAndInvoice(actor, id, { issue: true });
      if (!r.issued) throw new ValidationError(`The invoice ${r.invoiceId ? "was created but " : ""}could not be issued: ${r.issueError ?? "unknown reason"}. Issue it from the invoice page, then record the payment.`);
      invoiceId = r.invoiceId;
    } else {
      invoiceId = (await createClientInvoice(actor, { source: "RA", raBillId: id, invoiceDate: today })).id;
    }
  }
  const inv = await db.clientInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true, version: true } });
  if (inv.status === "DRAFT") await clientInvoiceAction(actor, invoiceId, "issue", { version: inv.version });
  // Issuing applies any advance the client already paid; if that covered the whole invoice there is nothing left to record.
  const after = await db.clientInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true, number: true } });
  return { invoiceId, projectId: bill.projectId, partyId: bill.partyId, soId: bill.soId, paidFromAdvance: after.status === "PAID", invoiceNumber: after.number };
}
