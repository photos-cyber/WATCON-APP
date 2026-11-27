"use client";

import { Ban, Link2, Loader2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocActions } from "@/components/commercial/doc-actions";
import { RequestChangeButton } from "@/components/commercial/request-change";
import { Field } from "@/components/forms/field";
import { FormDialog } from "@/components/shared/dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/call-action";
import { formatDate } from "@/lib/format";
import { cmpMoney, formatINR } from "@/lib/money";
import { allocatePaymentAction, cancelPaymentAction, refundClientAdvanceAction, reverseAllocationAction } from "@/modules/payables/actions";
import type { OpenDoc } from "./payment-form";

export function PaymentActions({ id, version, can }: { id: string; version: number; can: { cancel: boolean; requestChange?: boolean } }) {
  if (!can.cancel) return can.requestChange ? <RequestChangeButton kind="payment" id={id} /> : null;
  return (
    <DocActions
      actions={[{ key: "cancel", label: "Cancel payment", icon: Ban, variant: "ghost", confirm: { title: "Cancel this payment?", description: "Use this for a bounced cheque or a wrong entry. All its allocations are reversed and the bills / invoices become payable again.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Payment cancelled." }]}
      run={(_k, note) => callAction(cancelPaymentAction, id, version, note ?? "")}
    />
  );
}

export function AllocateAdvance({ paymentId, unallocated, docs, direction }: { paymentId: string; unallocated: string; docs: OpenDoc[]; direction: "OUT" | "IN" }) {
  const router = useRouter();
  const [docId, setDocId] = useState<string>(docs[0]?.id ?? "");
  const doc = docs.find((d) => d.id === docId);
  const suggested = doc ? (cmpMoney(doc.outstanding, unallocated) < 0 ? doc.outstanding : unallocated) : "";
  const [amount, setAmount] = useState(suggested);
  const [busy, setBusy] = useState(false);
  return (
    <FormDialog
      title={`Allocate the advance (${formatINR(unallocated)})`}
      description={direction === "OUT" ? "Apply the unallocated part of this payment to an approved bill of the same supplier and project." : "Apply the unallocated part of this receipt to an issued invoice of the same client and project."}
      trigger={
        <Button size="sm" disabled={!docs.length} title={docs.length ? undefined : "Nothing open to allocate to"}>
          <Link2 /> Allocate advance
        </Button>
      }
    >
      {(close) => (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const res = await callAction(allocatePaymentAction, paymentId, { documentId: docId, amount });
            setBusy(false);
            if (!res.ok) return void toast.error(res.error);
            toast.success("Allocated.");
            close();
            router.refresh();
          }}
        >
          <Field id="alloc-doc" label={direction === "OUT" ? "Bill" : "Invoice"} required>
            <select
              id="alloc-doc"
              className="h-9 w-full rounded-md border bg-card px-2 text-sm"
              value={docId}
              onChange={(e) => {
                setDocId(e.target.value);
                const d = docs.find((x) => x.id === e.target.value);
                if (d) setAmount(cmpMoney(d.outstanding, unallocated) < 0 ? d.outstanding : unallocated);
              }}
            >
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.number}
                  {d.ref ? ` (inv ${d.ref})` : ""} · due {formatDate(d.dueDate)} · {formatINR(d.outstanding)} outstanding
                </option>
              ))}
            </select>
          </Field>
          <Field id="alloc-amt" label="Amount ₹" required>
            <Input id="alloc-amt" inputMode="decimal" className="text-right" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !docId}>
              {busy && <Loader2 className="animate-spin" />}
              Allocate
            </Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}

export function ReverseAllocation({ allocationId, label }: { allocationId: string; label: string }) {
  return (
    <DocActions
      actions={[{ key: "reverse", label: "Reverse", icon: Undo2, variant: "ghost", confirm: { title: `Reverse the allocation to ${label}?`, description: "The amount goes back to this payment as an advance and the document becomes payable again. The history is kept.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Allocation reversed." }]}
      run={(_k, note) => callAction(reverseAllocationAction, allocationId, note ?? "")}
    />
  );
}

/** Authorised refund of part of a client's unallocated advance (approver right; recorded as a refund payment). */
export function RefundAdvance({ receiptId, unallocated, today }: { receiptId: string; unallocated: string; today: string }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [v, setV] = useState({ amount: unallocated, paymentDate: today, mode: "BANK_TRANSFER", reference: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return (
    <FormDialog
      title="Refund client advance"
      description={`Pay back part of the ${formatINR(unallocated)} advance still held on this receipt. Needs an approver other than the person who recorded the receipt.`}
      trigger={
        <Button size="sm" variant="outline">
          <Undo2 /> Refund advance
        </Button>
      }
    >
      {(close) => (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const res = await callAction(refundClientAdvanceAction, receiptId, { ...v, idempotencyKey: key });
            setBusy(false);
            if (!res.ok) {
              setErrors(res.fieldErrors ?? {});
              toast.error(res.error);
              return;
            }
            toast.success("Refund recorded.");
            close();
            router.refresh();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="rf-amt" label="Amount ₹" required error={errors.amount}><Input id="rf-amt" inputMode="decimal" className="text-right" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
            <Field id="rf-date" label="Date" required error={errors.paymentDate}><Input id="rf-date" type="date" value={v.paymentDate} onChange={(e) => setV({ ...v, paymentDate: e.target.value })} /></Field>
            <Field id="rf-mode" label="Mode" required>
              <select id="rf-mode" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>
                {[["BANK_TRANSFER", "Bank transfer"], ["UPI", "UPI"], ["CHEQUE", "Cheque"], ["CASH", "Cash"], ["OTHER", "Other"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Field>
            <Field id="rf-ref" label="Reference" error={errors.reference}><Input id="rf-ref" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
          </div>
          <Field id="rf-reason" label="Reason" required error={errors.reason}><Input id="rf-reason" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={busy || cmpMoney(v.amount || "0", "0") <= 0}>{busy && <Loader2 className="animate-spin" />} Record refund</Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}
