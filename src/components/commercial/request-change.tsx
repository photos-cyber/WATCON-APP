"use client";

import { MessageSquareWarning } from "lucide-react";
import { DocActions } from "@/components/commercial/doc-actions";
import { callAction } from "@/lib/call-action";
import { requestChangeAction } from "@/modules/commercial/change-request-actions";
import type { ChangeRequestKind } from "@/modules/commercial/change-request";

/**
 * Finalized documents can only be amended / cancelled / reversed by the Super Admin. Everyone else
 * uses this button: the reason goes to the Super Admin as a notification and into the audit trail.
 */
export function RequestChangeButton({ kind, id, label = "Request change" }: { kind: ChangeRequestKind; id: string; label?: string }) {
  return (
    <DocActions
      actions={[
        {
          key: "request",
          label,
          icon: MessageSquareWarning,
          variant: "ghost",
          confirm: {
            title: "Ask the Super Admin for a change",
            description: "This document is final. Say what must change (amend, cancel or reverse) and why — the Super Admin is notified and makes the change.",
            noteLabel: "What needs to change and why",
            noteRequired: true,
            confirmLabel: "Send request",
          },
          success: "Request sent to the Super Admin.",
        },
      ]}
      run={(_key, note) => callAction(requestChangeAction, { kind, id, change: "OTHER", reason: note ?? "" })}
    />
  );
}
