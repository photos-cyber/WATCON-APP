"use client";

import { Ban, CheckCircle2, Copy, FileCheck2, Link2, Loader2, Mail, Pencil, RotateCcw, Send, ShoppingBag, ThumbsDown, ThumbsUp, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocActions, type DocActionDef } from "@/components/commercial/doc-actions";
import { PdfButtons } from "@/components/documents/pdf-buttons";
import { Field } from "@/components/forms/field";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { whatsappLink } from "@/lib/whatsapp";
import { convertQuotationAction, duplicateQuotationAction, emailQuotationAction, quotationActionAction, recordAcceptanceAction } from "@/modules/sales/quotation-actions";

type Can = { edit: boolean; submit: boolean; approve: boolean; share: boolean; markSent: boolean; revise: boolean; recordAcceptance: boolean; recordRejection: boolean; convert: boolean; duplicate: boolean; cancel: boolean };

export function QuotationActions({ id, version, can, link, number, clientName, clientEmail, clientPhone, totalLabel, validUntil }: { id: string; version: number; can: Can; link: string | null; number: string; clientName: string; clientEmail: string | null; clientPhone: string | null; totalLabel: string; validUntil: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [accept, setAccept] = useState(false);
  const [email, setEmail] = useState(false);

  const defs: DocActionDef[] = [];
  if (can.submit) defs.push({ key: "submit", label: "Submit for approval", icon: Send, variant: "default", confirm: { title: "Submit this quotation for approval?", description: "An approver checks rates, totals and payment terms before it goes to the client." }, success: "Submitted for approval." });
  if (can.approve) {
    defs.push({ key: "approve", label: "Approve", icon: ThumbsUp, variant: "default", confirm: { title: "Approve this quotation?", description: "It can then be shared with the client." }, success: "Quotation approved." });
    defs.push({ key: "reject_approval", label: "Return for correction", icon: ThumbsDown, confirm: { title: "Return the quotation?", description: "It goes back to draft with your note.", noteLabel: "What needs correcting", noteRequired: true }, success: "Returned to draft." });
  }
  if (can.markSent) defs.push({ key: "mark_sent", label: "Mark as sent", icon: Send, confirm: { title: "Mark as sent to the client?", description: "Records that you shared it (the app does not send messages by itself).", noteLabel: "Sent via (e.g. WhatsApp)", input: true }, success: "Marked as sent." });
  if (can.recordRejection) defs.push({ key: "client_rejected", label: "Client declined", icon: XCircle, confirm: { title: "Record that the client declined?", description: "Keep the reason for follow-up. You can revise and resend later.", noteLabel: "Client's reason", noteRequired: true }, success: "Recorded." });
  if (can.revise) defs.push({ key: "revise", label: "Revise", icon: RotateCcw, confirm: { title: "Open a new revision?", description: "The current version is kept in the version history; the quotation returns to draft and needs approval again.", noteLabel: "Reason for revision", noteRequired: true }, success: "Revision opened — edit and resubmit." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this quotation?", description: "It can no longer be accepted.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Quotation cancelled." });

  const message = link ? `Dear ${clientName},\n\nPlease find our quotation ${number} for ${totalLabel}${validUntil ? `, valid until ${validUntil}` : ""}.\n\nView, download and accept it here:\n${link}\n\nThank you.` : "";

  async function run(key: "duplicate" | "convert") {
    setBusy(key);
    const res = key === "duplicate" ? await callAction(duplicateQuotationAction, id) : await callAction(convertQuotationAction, id);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    if (key === "duplicate") {
      toast.success("Copy created as a new draft.");
      router.push(`/quotations/${(res.data as { id: string }).id}`);
    } else {
      const d = res.data as { soId: string; created: boolean };
      toast.success(d.created ? "Sales order created from the accepted quotation — review and submit it for approval." : "This quotation was already converted — opening its sales order.");
      router.push(`/sales-orders/${d.soId}`);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can.edit && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/quotations/${id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      )}
      <DocActions actions={defs} run={(key, note) => callAction(quotationActionAction, id, key as never, { version, note, via: key === "mark_sent" ? note : null })} />
      {can.recordAcceptance && (
        <Button size="sm" variant="outline" onClick={() => setAccept(true)}>
          <FileCheck2 /> Record acceptance
        </Button>
      )}
      {can.convert && (
        <Button size="sm" onClick={() => run("convert")} disabled={!!busy}>
          {busy === "convert" ? <Loader2 className="animate-spin" /> : <ShoppingBag />} Convert to sales order
        </Button>
      )}
      {can.duplicate && (
        <Button size="sm" variant="ghost" onClick={() => run("duplicate")} disabled={!!busy}>
          {busy === "duplicate" ? <Loader2 className="animate-spin" /> : <Copy />} Duplicate
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <PdfButtons href={`/api/documents/pdf?type=client_quotation&id=${id}`} />
        {can.share && link && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  toast.success("Client link copied.");
                } catch {
                  toast.error(`Copy failed — the link is: ${link}`);
                }
              }}
            >
              <Link2 /> Copy client link
            </Button>
            <Button asChild size="sm" variant="outline" title="Opens WhatsApp with a prefilled message and the secure link">
              <a href={whatsappLink(message, clientPhone)} target="_blank" rel="noopener noreferrer">
                <WhatsAppIcon className="size-4" /> WhatsApp
              </a>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEmail(true)}>
              <Mail /> Email
            </Button>
          </>
        )}
      </div>
      <AcceptanceDialog open={accept} onOpenChange={setAccept} id={id} version={version} onDone={() => router.refresh()} />
      <EmailDialog open={email} onOpenChange={setEmail} id={id} defaultTo={clientEmail ?? ""} onDone={() => router.refresh()} />
    </div>
  );
}

function AcceptanceDialog({ open, onOpenChange, id, version, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; id: string; version: number; onDone: () => void }) {
  const [v, setV] = useState({ acceptedByName: "", acceptedByRole: "", acceptedByEmail: "", note: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const res = await callAction(recordAcceptanceAction, id, version, v);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      return toast.error(res.error);
    }
    toast.success("Acceptance recorded. Attach the signed copy / email under Documents, then convert to a sales order.");
    onOpenChange(false);
    onDone();
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record client acceptance</DialogTitle>
          <DialogDescription>Use this when the client accepted outside the link — a signed and stamped copy, an email or a PO letter. Attach that evidence under “Documents”. The accepted version is frozen.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="ac-name" label="Accepted by" required error={errors.acceptedByName}>
            <Input id="ac-name" value={v.acceptedByName} onChange={(e) => setV({ ...v, acceptedByName: e.target.value })} />
          </Field>
          <Field id="ac-role" label="Designation" error={errors.acceptedByRole}>
            <Input id="ac-role" value={v.acceptedByRole} onChange={(e) => setV({ ...v, acceptedByRole: e.target.value })} />
          </Field>
          <Field id="ac-email" label="Their email" error={errors.acceptedByEmail} className="sm:col-span-2">
            <Input id="ac-email" type="email" value={v.acceptedByEmail} onChange={(e) => setV({ ...v, acceptedByEmail: e.target.value })} />
          </Field>
          <Field id="ac-note" label="How was it accepted?" required error={errors.note} className="sm:col-span-2" help="e.g. Signed & stamped copy received by email on 23 Nov 2026">
            <Textarea id="ac-note" rows={3} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Record acceptance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmailDialog({ open, onOpenChange, id, defaultTo, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; id: string; defaultTo: string; onDone: () => void }) {
  const [to, setTo] = useState(defaultTo);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    const res = await callAction(emailQuotationAction, id, { to, message });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    const d = res.data as { delivered: boolean; reason?: string };
    if (!d.delivered) return toast.error(`Not sent. ${d.reason ?? ""} Use WhatsApp or copy the link instead.`);
    toast.success(`Email accepted by the mail server for ${to}.`);
    onOpenChange(false);
    onDone();
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Email the quotation</DialogTitle>
          <DialogDescription>Sends the secure link (the client can view, download and accept). Success is shown only when the mail server accepts the email.</DialogDescription>
        </DialogHeader>
        <Field id="em-to" label="To" required>
          <Input id="em-to" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field id="em-msg" label="Message (optional)" help="Leave empty for the standard message.">
          <Textarea id="em-msg" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={busy || !to}>
            {busy ? <Loader2 className="animate-spin" /> : <Mail />} Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
