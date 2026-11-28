"use client";

import { Ban, CheckCircle2, HandCoins, FilePen, FileText, Gavel, Lock, Pencil, ReceiptIndianRupee, RotateCcw, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocActions, type DocActionDef, type MoreLink } from "@/components/commercial/doc-actions";
import { requestChangeDef, withRequestChange } from "@/components/commercial/request-change";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/call-action";
import { acceptRaBillAndInvoiceAction, prepareRaBillPaymentAction, clientInvoiceActionAction, clientPoActionAction, raBillActionAction, salesOrderActionAction, setMilestoneStatusAction } from "@/modules/sales/actions";

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
  if (can.submit) defs.push({ key: "submit", label: "Finalize", icon: CheckCircle2, variant: "default", confirm: { title: "Finalize this client PO?", description: "It becomes the active contract: sales orders, running bills and invoices can be raised against it. It can still be amended later from this page (with a reason)." }, success: "Client PO is now active." });
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
      <DocActions
        actions={can.requestChange ? [...defs, requestChangeDef()] : defs}
        moreLinks={[...(can.raBill ? [{ label: "Running bill (legacy client PO)", href: `/running-bills/new?clientPoId=${id}` }] : []), ...(can.invoice ? [{ label: "Invoice", href: `/client-invoices/new?clientPoId=${id}` }] : [])]}
        run={withRequestChange("client_po", id, (key, note) => callAction(clientPoActionAction, id, key as never, { version, note }))}
      />
    </>
  );
}

type SoCan = { edit: boolean; submit: boolean; approve: boolean; approveBlockedReason: string | null; close: boolean; cancel: boolean; deliver: boolean; invoice: boolean; planning: boolean };

export function SoActions({ id, version, projectId, partyId, can, more = [] }: { id: string; version: number; projectId: string; partyId: string; can: SoCan; more?: MoreLink[] }) {
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
      <DocActions
        actions={defs}
        moreLinks={[
          ...more,
          ...(can.planning ? [{ label: "Material planning", href: `/projects/${projectId}?tab=planning` }] : []),
          ...(can.deliver ? [{ label: "Deliver to client (challan)", href: `/challans/new?type=CLIENT_DELIVERY&soId=${id}&projectId=${projectId}&partyId=${partyId}` }] : []),
          ...(can.invoice ? [{ label: "Invoice by delivery", href: `/client-invoices/new?soId=${id}` }] : []),
        ]}
        run={(key, note) => callAction(salesOrderActionAction, id, key as never, { version, note })}
      />
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
      <DocActions
        actions={[...quick, ...defs, ...(can.requestChange ? [requestChangeDef()] : [])]}
        run={withRequestChange("ra_bill", id, (key, note) => (key === "accept" ? callAction(acceptRaBillAndInvoiceAction, id, { clientCertRef: note, issue: true }) : callAction(raBillActionAction, id, key as never, { version, note })))}
        onDone={(key, res) => {
          if (key !== "accept") return;
          const d = (res as { data?: { invoiceId: string; issueError: string | null } }).data;
          if (d?.issueError) toast.warning(`Invoice created as draft, not issued: ${d.issueError}`);
          if (d?.invoiceId) router.push(`/client-invoices/${d.invoiceId}`);
        }}
      />
    </>
  );
}

export function InvoiceActions({ id, version, partyId, projectId, can, more = [] }: { id: string; version: number; partyId: string; projectId?: string; can: { issue: boolean; cancel: boolean; receive: boolean; requestChange?: boolean }; more?: MoreLink[] }) {
  const defs: DocActionDef[] = [];
  if (can.issue) defs.push({ key: "issue", label: "Issue invoice", icon: CheckCircle2, variant: "default", confirm: { title: "Issue this invoice?", description: "The invoice number is allocated now and the invoice can no longer be edited." }, success: "Invoice issued." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this invoice?", description: "Quantities return to the running bill / sales order so they can be invoiced again.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Invoice cancelled." });
  return (
    <>
      {can.receive && <LinkButton href={`/payments/new?direction=IN&partyId=${partyId}&invoiceId=${id}${projectId ? `&projectId=${projectId}` : ""}`} icon={ReceiptIndianRupee}>Record client payment</LinkButton>}
      <DocActions actions={can.requestChange ? [...defs, requestChangeDef()] : defs} moreLinks={more} run={withRequestChange("client_invoice", id, (key, note) => callAction(clientInvoiceActionAction, id, key as never, { version, note }))} />
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

/**
 * "Record client payment" on a running bill. The bill's tax invoice is created / issued behind the scenes
 * (when not done yet), then the payment form opens set to settle it; anything unpaid is carried into the
 * next running bill.
 */
export function RaBillPayButton({ id, label = "Record client payment" }: { id: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await callAction(prepareRaBillPaymentAction, id);
        if (!r.ok) {
          setBusy(false);
          toast.error(r.error);
          return;
        }
        const d = (r as { data: { invoiceId: string; projectId: string; partyId: string; soId: string | null } }).data;
        const qs = new URLSearchParams({ direction: "IN", projectId: d.projectId, partyId: d.partyId, invoiceId: d.invoiceId });
        if (d.soId) qs.set("soId", d.soId);
        router.push(`/payments/new?${qs}`);
      }}
    >
      <HandCoins /> {busy ? "Preparing…" : label}
    </Button>
  );
}
