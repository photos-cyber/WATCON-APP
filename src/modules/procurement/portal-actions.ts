"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { toActionError, type ActionResult } from "@/lib/errors";
import { submitPortalQuote } from "./supplier-portal";

/**
 * Public action for the supplier quote page. There is no session: the link token is the
 * credential and is re-checked inside submitPortalQuote.
 */
export async function submitPortalQuoteAction(token: string, input: unknown): Promise<ActionResult<{ number: string; revision: number }>> {
  try {
    const data = await submitPortalQuote(String(token), input);
    revalidatePath("/rate-enquiries", "layout");
    revalidatePath("/approvals", "layout");
    return { ok: true, data };
  } catch (e) {
    unstable_rethrow(e);
    return toActionError(e);
  }
}
