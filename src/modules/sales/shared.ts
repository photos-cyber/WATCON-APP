import "server-only";
import { z } from "zod";
import type { Tx } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { SCALE, addQty, divRound, fromUnits, toUnits } from "@/lib/money";
import type { Actor } from "@/lib/permissions/definitions";
import { dateString, uuid } from "@/lib/validations/common";
import { dec3 } from "@/modules/commercial/core";

export const optDate = z.union([dateString, z.literal(""), z.null()]).optional().transform((v) => (v ? v : null));
export const optId = uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null));

/** RA bills that count as certified (their certified quantity is final). */
export const RA_CERTIFIED = ["CLIENT_CERTIFIED", "INVOICED", "PARTIALLY_PAID", "PAID"] as const;

export async function loadClient(tx: Tx, actor: Actor, partyId: string) {
  const party = await tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } });
  if (!party || !party.isClient) throw new ValidationError("Choose a client.", { partyId: "Not a client." });
  if (party.status !== "ACTIVE") throw new ValidationError("This client is inactive.", { partyId: "Inactive client." });
  return party;
}

/** rate × (1 − discount%) at 4 dp: the net unit rate a running bill or invoice line is charged at. */
export function netRate(rate: string, discountPct: string) {
  const r = toUnits(rate, SCALE.rate);
  const d = toUnits(discountPct || "0", SCALE.pct);
  const hundred = toUnits("100", SCALE.pct);
  return fromUnits(divRound(r * (hundred - d), hundred), SCALE.rate, { trim: true });
}

/**
 * Quantity of each client-PO line already committed to billing:
 *   running bills (certified qty once certified, otherwise the claimed qty; cancelled excluded)
 * + invoice lines not raised from a running bill (direct contract invoices and supply invoices).
 * Every billing path checks against this single ceiling.
 */
export async function cpoLineBilled(tx: Tx, clientPoId: string, opts: { excludeRaBillId?: string; excludeInvoiceId?: string } = {}) {
  const ra = await tx.raBillLine.findMany({
    where: { raBill: { clientPoId, status: { not: "CANCELLED" }, ...(opts.excludeRaBillId ? { id: { not: opts.excludeRaBillId } } : {}) } },
    select: { clientPoLineId: true, claimedQty: true, certifiedQty: true, raBill: { select: { status: true } } },
  });
  const inv = await tx.invoiceLine.findMany({
    where: { clientPoLine: { clientPoId }, invoice: { status: { not: "CANCELLED" }, raBillId: null, ...(opts.excludeInvoiceId ? { id: { not: opts.excludeInvoiceId } } : {}) } },
    select: { clientPoLineId: true, quantity: true },
  });
  // Sales-order running bills of orders linked to this client PO consume the same contract quantity.
  const soRa = await tx.raBillLine.findMany({
    where: { soLine: { clientPoLine: { clientPoId } }, raBill: { soId: { not: null }, status: { not: "CANCELLED" }, ...(opts.excludeRaBillId ? { id: { not: opts.excludeRaBillId } } : {}) } },
    select: { claimedQty: true, certifiedQty: true, raBill: { select: { status: true } }, soLine: { select: { clientPoLineId: true } } },
  });
  const map = new Map<string, string>();
  const bump = (k: string, q: string) => map.set(k, addQty(map.get(k) ?? "0", q));
  for (const l of ra) if (l.clientPoLineId) bump(l.clientPoLineId, (RA_CERTIFIED as readonly string[]).includes(l.raBill.status) ? dec3(l.certifiedQty) : dec3(l.claimedQty));
  for (const l of soRa) if (l.soLine?.clientPoLineId) bump(l.soLine.clientPoLineId, (RA_CERTIFIED as readonly string[]).includes(l.raBill.status) ? dec3(l.certifiedQty) : dec3(l.claimedQty));
  for (const l of inv) if (l.clientPoLineId) bump(l.clientPoLineId, dec3(l.quantity));
  return map;
}

/** Serialises everything that consumes a client PO's quantities (running bills, invoices, sales orders). */
export async function lockClientPo(tx: Tx, clientPoId: string) {
  await tx.$queryRaw`SELECT id FROM client_pos WHERE id = ${clientPoId}::uuid FOR UPDATE`;
}
