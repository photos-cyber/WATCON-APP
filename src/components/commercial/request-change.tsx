"use client";

import { MessageSquareWarning } from "lucide-react";
import { DocActions, type ActionResultLike, type DocActionDef } from "@/components/commercial/doc-actions";
import { callAction } from "@/lib/call-action";
import { requestChangeAction } from "@/modules/commercial/change-request-actions";
import type { ChangeRequestKind } from "@/modules/commercial/change-request";

export const REQUEST_CHANGE_KEY = "__request_change";

/**
 * Fallback for users who lack the permission to amend / cancel / reverse a finalized document
 * themselves (Admins do it directly): the reason goes to the Super Admin as a notification and into
 * the audit trail.
 * Added to a document's own action list so it sits in that document's single "More" menu.
 */
export const requestChangeDef = (label = "Request change"): DocActionDef => ({
  key: REQUEST_CHANGE_KEY,
  label,
  icon: MessageSquareWarning,
  variant: "ghost",
  more: true,
  confirm: {
    title: "Ask the Super Admin for a change",
    description: "This document is final. Say what must change (amend, cancel or reverse) and why — the Super Admin is notified and makes the change.",
    noteLabel: "What needs to change and why",
    noteRequired: true,
    confirmLabel: "Send request",
  },
  success: "Request sent to the Super Admin.",
});

/** Wraps a document's `run` so the "Request change" entry goes to the change-request action. */
export function withRequestChange(kind: ChangeRequestKind, id: string, run: (key: string, note: string | null) => Promise<ActionResultLike>) {
  return (key: string, note: string | null): Promise<ActionResultLike> => (key === REQUEST_CHANGE_KEY ? callAction(requestChangeAction, { kind, id, change: "OTHER", reason: note ?? "" }) : run(key, note));
}

/** Stand-alone variant for pages with no other document actions. */
export function RequestChangeButton({ kind, id, label = "Request change" }: { kind: ChangeRequestKind; id: string; label?: string }) {
  return <DocActions actions={[requestChangeDef(label)]} run={withRequestChange(kind, id, async () => ({ ok: true }))} />;
}
