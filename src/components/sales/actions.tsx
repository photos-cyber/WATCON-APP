"use client";

import { Ban, CheckCircle2, FilePen, FileText, Gavel, Lock, Pencil, ReceiptIndianRupee, RotateCcw, ScrollText, Send, ThumbsDown, ThumbsUp, Truck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DocActions, type DocActionDef } from "@/components/commercial/doc-actions";
import { RequestChangeButton } from "@/components/commercial/request-change";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/call-action";
import { acceptRaBillAndInvoiceAction, clientInvoiceActionAction, clientPoActionAction, raBillActionAction, salesOrderActionAction, setMilestoneStatusAction } from "@/modules/sales/actions";

const LinkButton = ({ href, icon: Icon, children }: { href: string; icon?: typeof Pencil; children: React.ReactNode }) => (
  <Button asChild size="sm" variant="outline">
    <Link href={href}>
      {Icon && <Icon />} {children}
    </Link>
  </Button>
);

type CpoCan = { edit: boolean; submit: boolean; approve: boolean; approveBlockedReason: string | null; amend: boolean; close: boolean; cancel: boolean; salesOrder: boolean; raBill: boolean; invoice: boolean; requestChange?: boolean };

export function CpoActions({ id, version, can }: { id: string; version: number; can: CpoCan }) {
  const defs: DocActionDef[] = [];
  if (can.submit) defs.push({ key: "submit", label: "Finalize", icon: CheckCircle2, variant: "default", confirm: { title: "Finalize this client PO?", description: "It becomes the active contract: sales orders, running bills and invoices can be raised against it. After this, only the Super Admin can amend it." }, success: "Client PO is now active." });
  if (can.approve) {
    defs.push({ key: "approve", label: "Finalize", icon: ThumbsUp, variant: "default", confirm: { title: "Finalize this client PO?", description: "It becomes the active contract." }, success: "Client PO is now active." });
    defs.push({ key: "reject", label: "Return for changes", icon: ThumbsDown, confirm: { title: "Return this client PO for changes?", description: "It goes back for correction.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Returned for changes." });
  }
  if (can.amend) {
    defs.push({ key: "variation", label: "Variation", icon: FilePen, confirm: { title: "Record a variation?", description: "Use this when the client changes scope or quantities. The current contract is saved to history; edit it and finalize again.", noteLabel: "What changed (client's variation reference)", noteRequired: true }, success: "Variation opened — edit and finalize." });
    defs.push({ key: "amend", label: "Amend", icon: FilePen, confirm: { title: "Amend this client PO?", description: "For corrections that are not a scope change. The current version is saved to history; edit it and finalize again.", noteLabel: "Reason", noteRequired: true }, success: "Amendment opened — edit and finalize." });
  }
  if (can.close) defs.push({ key: "close", label: "Close", icon: Lock, confirm: { title: "Close this contract?", description: "No further orders, bills or invoices can be raised against it.", noteLabel: "Reason", noteRequired: true }, success: "Contract closed." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this client PO?", description: "Only possible while nothing has been ordered or billed against it.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Client PO cancelled." });
  return (
    <>
      {can.edit && <LinkButton href={`/client-pos/${id}/edit`} icon={Pencil}>Edit</LinkButton>}
      {can.salesOrder && <LinkButton href={`/sales-orders/new?clientPoId=${id}`} icon={FileText}>Sales order</LinkButton>}
      {can.raBill && <LinkButton href={`/running-bills/new?clientPoId=${id}`} icon={ScrollText}>Running bill</LinkButton>}
      {can.invoice && <LinkButton href={`/client-invoices/new?clientPoId=${id}`} icon={ReceiptIndianRupee}>Invoice</LinkButton>}
      <DocActions actions={defs} run={(key, note) => callAction(clientPoActionAction, id, key as never, { version, note })} />
      {can.requestChange && <RequestChangeButton kind="client_po" id={id} />}
    </>
  );
}

type SoCan = { edit: boolean; submit: boolean; approve: boolean; approveBlockedReason: string | null; close: boolean; cancel: boolean; deliver: boolean; invoice: boolean; planning: boolean };

export function SoActions({ id, version, projectId, partyId, can }: { id: string; version: number; projectId: string; partyId: string; can: SoCan }) {
  const defs: DocActionDef[] = [];
  const confirmSo = { title: "Confirm this sales order?", description: "It is locked once confirmed: material planning starts from its lines straight away. Any later change needs an amendment approved by the Super Admin." };
  if (can.submit) defs.push({ key: "submit", label: "Confirm order", icon: CheckCircle2, variant: "default", confirm: confirmSo, success: "Sales order confirmed — material planning updated." });
  if (can.approve) {
    defs.push({ key: "approve", label: "Confirm order", icon: ThumbsUp, variant: "default", confirm: confirmSo, success: "Sales order confirmed — material planning updated." });
    defs.push({ key: "reject", label: "Return for changes", icon: ThumbsDown, confirm: { title: "Return this sales order for changes?", description: "It goes back for correction.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Returned for changes." });
  }
  if (can.close) defs.push({ key: "close", label: "Close", icon: Lock, confirm: { title: "Close this sales order?", description: "No further deliveries. Material requirements drop to what was actually delivered.", noteLabel: "Reason", noteRequired: true }, success: "Sales order closed." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this sales order?", description: "Only possible before anything is delivered or invoiced. Its material requirements are cancelled.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Sales order cancelled." });
  return (
    <>
      {can.edit && <LinkButton href={`/sales-orders/${id}/edit`} icon={Pencil}>Edit</LinkButton>}
      {can.planning && <LinkButton href={`/projects/${projectId}?tab=planning`}>Material planning</LinkButton>}
      {can.deliver && <LinkButton href={`/challans/new?type=CLIENT_DELIVERY&soId=${id}&projectId=${projectId}&partyId=${partyId}`} icon={Truck}>Deliver</LinkButton>}
      {can.invoice && <LinkButton href={`/client-invoices/new?soId=${id}`} icon={ReceiptIndianRupee}>Invoice</LinkButton>}
      <DocActions actions={defs} run={(key, note) => callAction(salesOrderActionAction, id, key as never, { version, note })} />
    </>
  );
}

type RaCan = { edit: boolean; submitReview: boolean; approve: boolean; approveBlockedReason: string | null; returnForCorrection: boolean; dispute: boolean; resubmit: boolean; cancel: boolean; invoice: boolean; requestChange?: boolean; acceptAndInvoice?: boolean };

export function RaActions({ id, version, can }: { id: string; version: number; can: RaCan }) {
  const router = useRouter();
  const defs: DocActionDef[] = [];
  const quick: DocActionDef[] = can.acceptAndInvoice
    ? [{ key: "accept", label: "Client accepted — invoice now", icon: CheckCircle2, variant: "default", confirm: { title: "Client accepted the bill as submitted?", description: "Every line is certified at the claimed quantity, the invoice is created and issued in one step. If the client cut any quantity, use “Record certification” instead.", noteLabel: "Client reference (optional, e.g. email of 12 Nov)", input: true, confirmLabel: "Certify & issue invoice" }, success: "Certified and invoiced." }]
    : [];
  const submitToClient = { title: "Submit this bill to the client?", description: "Share the PDF with the client, then record their certification (or certify as claimed) to create the invoice." };
  if (can.submitReview) defs.push({ key: "submit_review", label: "Submit to client", icon: Send, variant: "default", confirm: submitToClient, success: "Bill submitted to client." });
  if (can.approve) defs.push({ key: "approve", label: "Submit to client", icon: ThumbsUp, variant: "default", confirm: submitToClient, success: "Bill submitted to client." });
  if (can.returnForCorrection) defs.push({ key: "return", label: "Return for correction", icon: RotateCcw, confirm: { title: "Return for correction?", description: "It goes back to draft.", noteLabel: "What needs correcting", noteRequired: true }, success: "Returned to draft." });
  if (can.dispute) defs.push({ key: "dispute", label: "Client disputes", icon: Gavel, confirm: { title: "Record a client dispute?", description: "Note the client's objection. You can resubmit or certify later.", noteLabel: "Client's objection", noteRequired: true }, success: "Dispute recorded." });
  if (can.resubmit) defs.push({ key: "resubmit", label: "Resubmit to client", icon: Send, success: "Resubmitted." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this running bill?", description: "Its claimed quantities are released.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Running bill cancelled." });
  return (
    <>
      {can.edit && <LinkButton href={`/running-bills/${id}/edit`} icon={Pencil}>Edit</LinkButton>}
      {can.invoice && <LinkButton href={`/client-invoices/new?raBillId=${id}`} icon={ReceiptIndianRupee}>Create invoice</LinkButton>}
      {quick.length > 0 && (
        <DocActions
          actions={quick}
          run={(_k, note) => callAction(acceptRaBillAndInvoiceAction, id, { clientCertRef: note, issue: true })}
          onDone={(_k, res) => {
            const d = (res as { data?: { invoiceId: string; issueError: string | null } }).data;
            if (d?.issueError) toast.warning(`Invoice created as draft, not issued: ${d.issueError}`);
            if (d?.invoiceId) router.push(`/client-invoices/${d.invoiceId}`);
          }}
        />
      )}
      <DocActions actions={defs} run={(key, note) => callAction(raBillActionAction, id, key as never, { version, note })} />
      {can.requestChange && <RequestChangeButton kind="ra_bill" id={id} />}
    </>
  );
}

export function InvoiceActions({ id, version, partyId, projectId, can }: { id: string; version: number; partyId: string; projectId?: string; can: { issue: boolean; cancel: boolean; receive: boolean; requestChange?: boolean } }) {
  const defs: DocActionDef[] = [];
  if (can.issue) defs.push({ key: "issue", label: "Issue invoice", icon: CheckCircle2, variant: "default", confirm: { title: "Issue this invoice?", description: "The invoice number is allocated now and the invoice can no longer be edited." }, success: "Invoice issued." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this invoice?", description: "Quantities return to the running bill / sales order so they can be invoiced again.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Invoice cancelled." });
  return (
    <>
      {can.receive && <LinkButton href={`/payments/new?direction=IN&partyId=${partyId}&invoiceId=${id}${projectId ? `&projectId=${projectId}` : ""}`} icon={ReceiptIndianRupee}>Record client payment</LinkButton>}
      <DocActions actions={defs} run={(key, note) => callAction(clientInvoiceActionAction, id, key as never, { version, note })} />
      {can.requestChange && <RequestChangeButton kind="client_invoice" id={id} />}
    </>
  );
}

export function MilestoneStatusSelect({ id, status, disabled }: { id: string; status: string; disabled?: boolean }) {
  const router = useRouter();
  return (
    <select
      aria-label="Milestone status"
      className="h-8 rounded-md border bg-card px-2 text-xs"
      value={status}
      disabled={disabled}
      onChange={async (e) => {
        const res = await callAction(setMilestoneStatusAction, id, e.target.value as "PENDING");
        if (!res.ok) toast.error(res.error);
        else {
          toast.success("Milestone updated.");
          router.refresh();
        }
      }}
    >
      <option value="PENDING">Pending</option>
      <option value="BILLED">Billed</option>
      <option value="RECEIVED">Received</option>
    </select>
  );
}
