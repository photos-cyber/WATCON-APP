"use client";

import { Ban, CheckCircle2, Pencil, ShieldAlert, ThumbsDown, ThumbsUp, Wallet } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { DocActions, type DocActionDef } from "@/components/commercial/doc-actions";
import { requestChangeDef, withRequestChange } from "@/components/commercial/request-change";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/call-action";
import { billActionAction } from "@/modules/payables/actions";

type Can = { edit: boolean; submit: boolean; approve: boolean; override: boolean; approveBlockedReason: string | null; cancel: boolean; pay: boolean; note: boolean; requestChange?: boolean };

export function BillActions({ id, version, can, hasExceptions, projectId }: { id: string; version: number; can: Can; hasExceptions: boolean; projectId: string | null }) {
  const defs: DocActionDef[] = [];
  const pending = can.approve; // held for match differences (or left from the old approval step)
  if (can.submit) defs.push({ key: "submit", label: "Save & finalize", icon: CheckCircle2, variant: "default", confirm: { title: "Finalize this supplier bill?", description: "If it matches the PO and receipts it is ready to pay at once. If quantities or rates differ, it is held so the difference can be checked." }, success: "Bill processed." });
  if (pending && !hasExceptions) defs.push({ key: "approve", label: "Finalize", icon: ThumbsUp, variant: "default", confirm: { title: "Finalize this bill for payment?", description: "The billed quantities are recorded against the purchase order and receipts, and the bill can then be paid." }, success: "Bill finalized — ready to pay." });
  if (can.override && hasExceptions) defs.push({ key: "override", label: "Accept despite differences", icon: ShieldAlert, variant: "default", confirm: { title: "Accept the bill despite the differences?", description: "The bill does not match the purchase order / receipts. Your reason is kept in the audit history.", noteLabel: "Reason", noteRequired: true }, success: "Bill accepted with override." });
  if (pending) defs.push({ key: "reject", label: "Return for correction", icon: ThumbsDown, confirm: { title: "Return this bill for correction?", description: "It goes back to draft so quantities or rates can be fixed.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Bill returned for correction." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel bill", icon: Ban, variant: "ghost", confirm: { title: "Cancel this bill?", description: "Use this for a wrong or duplicate entry. Billed quantities are released back to the PO / receipts.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Bill cancelled." });
  return (
    <>
      {can.pay && (
        <Button asChild size="sm">
          <Link href={`/payments/new?direction=OUT&billId=${id}${projectId ? `&projectId=${projectId}` : ""}`}>
            <Wallet /> Record payment
          </Link>
        </Button>
      )}
      {can.edit && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/supplier-bills/${id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      )}
      <DocActions
        actions={can.requestChange ? [...defs, requestChangeDef()] : defs}
        moreLinks={can.note ? [{ label: "Credit / debit note", href: `/notes/new?billId=${id}` }] : []}
        run={withRequestChange("supplier_bill", id, (key, note) => callAction(billActionAction, id, (key === "override" ? (can.approve ? "approve" : "submit") : key) as never, { version, note, override: key === "override" }))}
        onDone={(key, res) => {
          const d = (res as { data?: { approved?: boolean; exceptions?: string[] } }).data;
          if (key === "submit" && d && d.approved === false) toast.warning(`Held for checking: ${(d.exceptions ?? []).join(" ")}`);
        }}
      />
      {pending && hasExceptions && !can.override && <span className="text-xs text-amber-700">This bill differs from the PO / receipts. Correct it, or ask a user allowed to accept differences.</span>}
    </>
  );
}
