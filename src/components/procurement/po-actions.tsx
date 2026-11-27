"use client";

import { Ban, CheckCircle2, FilePen, HandCoins, Lock, PackageCheck, Pencil, ReceiptText, Send, ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-react";import Link from "next/link";
import { DocActions, type DocActionDef } from "@/components/commercial/doc-actions";
import { RequestChangeButton } from "@/components/commercial/request-change";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/call-action";
import { poActionAction } from "@/modules/procurement/actions";

type Can = { edit: boolean; submit: boolean; finalize?: boolean; finalizeApproves?: boolean; approve: boolean; approveBlockedReason: string | null; send: boolean; acknowledge: boolean; amend: boolean; cancel: boolean; close: boolean; receive: boolean; bill: boolean; pay?: boolean; requestChange?: boolean };

/**
 * Main PO actions: Finalize (one step — no approval wait), Receive material, Record supplier bill,
 * Record supplier payment. PDF / share sit next to these (DocShare). Changes to a finalized PO are
 * made by the Super Admin; others use "Request change".
 */
export function PoActions({ id, version, can, partyId, projectId }: { id: string; version: number; can: Can; partyId: string; projectId: string | null }) {
  const defs: DocActionDef[] = [];
  if (can.finalize || can.submit) {
    defs.push({ key: "finalize", label: "Finalize PO", icon: ShieldCheck, variant: "default", confirm: { title: "Finalize this purchase order?", description: "It becomes final now. Share it with the supplier, then receive material against it. After this, only the Super Admin can amend or cancel it." }, success: "Purchase order finalized." });
  }
  if (can.approve) {
    defs.push({ key: "approve", label: "Finalize PO", icon: ThumbsUp, variant: "default", confirm: { title: "Finalize this purchase order?", description: "It was waiting under the old approval step. Finalizing lets you share it and receive material." }, success: "Purchase order finalized." });
    defs.push({ key: "reject", label: "Return for changes", icon: ThumbsDown, confirm: { title: "Return this purchase order for changes?", description: "It goes back to draft so it can be edited.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Returned for changes." });
  }
  if (can.send) defs.push({ key: "send", label: "Mark sent", icon: Send, confirm: { title: "Mark as sent to the supplier?", description: "Share the PDF by email or WhatsApp first. This records that it was sent — the app does not send it for you.", noteLabel: "Sent via (e.g. email, WhatsApp)", input: true }, success: "Marked as sent." });
  if (can.acknowledge) defs.push({ key: "acknowledge", label: "Supplier acknowledged", icon: CheckCircle2, confirm: { title: "Record supplier acknowledgement", description: "Enter the supplier's confirmation reference (email, order no.).", noteLabel: "Acknowledgement reference", input: true }, success: "Acknowledgement recorded." });
  if (can.amend) defs.push({ key: "amend", label: "Amend", icon: FilePen, confirm: { title: "Open an amendment?", description: "The current version is saved to the revision history; edit the PO and finalize it again. Received and billed quantities are kept.", noteLabel: "Reason for amendment", noteRequired: true }, success: "Amendment opened — edit and finalize again." });
  if (can.close) defs.push({ key: "close", label: "Short-close", icon: Lock, confirm: { title: "Short-close this purchase order?", description: "No further deliveries will be received. Unreceived quantity is released back to planning.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Purchase order closed." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this purchase order?", description: "This cannot be undone. Planned quantities become orderable again.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Purchase order cancelled." });
  return (
    <>
      {can.edit && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/purchase-orders/${id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      )}
      {can.receive && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/site-receipts/new?poId=${id}`}>
            <PackageCheck /> Receive material
          </Link>
        </Button>
      )}
      {can.bill && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/supplier-bills/new?poId=${id}`}>
            <ReceiptText /> Record supplier bill
          </Link>
        </Button>
      )}
      {can.pay && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/payments/new?direction=OUT&poId=${id}&partyId=${partyId}${projectId ? `&projectId=${projectId}` : ""}`}>
            <HandCoins /> Record supplier payment
          </Link>
        </Button>
      )}
      <DocActions actions={defs} run={(key, note) => callAction(poActionAction, id, key as never, { version, note, via: key === "send" ? note : null })} />
      {can.requestChange && <RequestChangeButton kind="purchase_order" id={id} />}
    </>
  );
}
