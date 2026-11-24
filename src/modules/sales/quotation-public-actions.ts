"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { toActionError, type ActionResult } from "@/lib/errors";
import { acceptViaLink, rejectViaLink, requestAcceptanceCode } from "./quotation";

/**
 * Public actions for the client quotation link. No session: the 256-bit link token is the
 * credential, and acceptance additionally needs a one-time code emailed to the client's address
 * on file. IP and browser are recorded with the acceptance.
 */

async function meta() {
  const h = await headers();
  return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null, userAgent: h.get("user-agent") };
}

async function wrap<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    return toActionError(e);
  }
}

export async function requestAcceptanceCodeAction(token: string) {
  return wrap(() => requestAcceptanceCode(String(token)));
}
export async function acceptQuotationAction(token: string, input: unknown) {
  return wrap(async () => acceptViaLink(String(token), input, await meta()));
}
export async function rejectQuotationAction(token: string, input: unknown) {
  return wrap(async () => {
    await rejectViaLink(String(token), input, await meta());
    return { rejected: true };
  });
}
