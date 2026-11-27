"use server";

import { runAction } from "@/lib/actions";
import { requestChange } from "./change-request";

export async function requestChangeAction(input: unknown) {
  return runAction(async (a) => requestChange(a, input));
}
