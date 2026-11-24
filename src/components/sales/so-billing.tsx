"use client";

import { CheckCircle2, Loader2, Pencil, Receipt } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { MilestoneBuilder, type SavedTemplate } from "@/components/commercial/milestone-builder";
import { DocStatusBadge, Section } from "@/components/commercial/ui";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/call-action";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { DEFAULT_CLIENT_MILESTONES, toInput, type MilestoneInput } from "@/modules/commercial/payment-terms";
import { createMilestoneInvoiceAction, markMilestoneAchievedAction, setSoMilestonesAction } from "@/modules/sales/quotation-actions";

export type BillingMilestone = { id: string; label: string; basis: string; percent: string | null; amount: string; trigger: string; triggerLabel: string; dueDate: string | null; days: number | null; note: string | null; achievedAt: string | null; eligible: string; eligibleReason: string; billed: string; received: string; billable: string; documentKind: string; state: string; invoices: { id: string; number: string; kind: string; status: string; total: string; received: string }[] };
export type Billing = { contractValue: string; eligible: string; invoiced: string; proformaBilled: string; received: string; remainingToInvoice: string; outstanding: string; advanceAvailable: string; advanceDocument: string; milestones: BillingMilestone[]; can: { editSchedule: boolean; invoice: boolean; markAchieved: boolean } };

const COLORS = ["bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-teal-500"];
const EVENT_TRIGGERS = ["ON_INSTALLATION", "ON_COMPLETION", "CUSTOM", "ON_DELIVERY", "NET_DAYS"];

/** Sales order payment schedule: contract → eligible → invoiced → received, per milestone. */
export function SoBilling({ soId, billing, today, savedTemplates }: { soId: string; billing: Billing; today: string; savedTemplates: SavedTemplate[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [schedule, setSchedule] = useState<MilestoneInput[]>(billing.milestones.length ? billing.milestones.map((m) => toInput(m)) : DEFAULT_CLIENT_MILESTONES.map((m) => ({ ...m })));
  const [busy, setBusy] = useState<string | null>(null);
  const [raise, setRaise] = useState<BillingMilestone | null>(null);
  const b = billing;
  const pctOf = (v: string) => (Number(b.contractValue) > 0 ? Math.min(100, (Number(v) / Number(b.contractValue)) * 100) : 0);

  async function saveSchedule() {
    setBusy("schedule");
    const res = await callAction(setSoMilestonesAction, soId, { milestones: schedule });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Payment schedule saved.");
    setEditing(false);
    router.refresh();
  }
  async function achieved(m: BillingMilestone) {
    const note = window.prompt(`Confirm “${m.label}” has been reached (this allows billing — it is not a payment). Note (optional):`, "");
    if (note === null) return;
    setBusy(m.id);
    const res = await callAction(markMilestoneAchievedAction, m.id, note || null);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Milestone confirmed — it can be invoiced now.");
    router.refresh();
  }

  const cards: [string, string, string?][] = [
    ["Contract value", b.contractValue],
    ["Eligible to invoice", b.eligible, "What the schedule allows today"],
    ["Invoiced (tax)", b.invoiced, b.proformaBilled !== "0.00" ? `+ ${formatINR(b.proformaBilled)} advance requested` : undefined],
    ["Received", b.received],
    ["Remaining to invoice", b.remainingToInvoice],
    ["Outstanding", b.outstanding, "Issued, not yet received"],
  ];

  return (
    <Section
      title="Payment schedule & billing"
      id="billing"
      actions={b.can.editSchedule && !editing && (
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil /> {b.milestones.length ? "Edit schedule" : "Add payment schedule"}
        </Button>
      )}
    >
      {editing ? (
        <div className="space-y-3">
          <MilestoneBuilder total={b.contractValue} value={schedule} onChange={setSchedule} savedTemplates={savedTemplates} canSaveTemplate />
          <div className="flex gap-2">
            <Button onClick={saveSchedule} disabled={busy === "schedule"}>
              {busy === "schedule" && <Loader2 className="animate-spin" />} Save schedule
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : !b.milestones.length ? (
        <p className="text-sm text-muted-foreground">No payment schedule — this order is invoiced by delivered quantity. Add a schedule (e.g. 50% advance / 40% delivery / 10% installation) to bill by milestones instead.</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {cards.map(([label, value, hint]) => (
              <div key={label} className="rounded-lg border p-2.5">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-sm font-semibold tabular-nums">{formatINR(value)}</p>
                {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
              </div>
            ))}
          </div>
          <div className="space-y-1">
            {[["Eligible", b.eligible, "bg-amber-400"], ["Invoiced", b.invoiced, "bg-sky-500"], ["Received", b.received, "bg-emerald-500"]].map(([label, value, color]) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="w-16 text-muted-foreground">{label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full", color)} style={{ width: `${pctOf(value!)}%` }} />
                </div>
                <span className="w-10 text-right tabular-nums">{Math.round(pctOf(value!))}%</span>
              </div>
            ))}
          </div>
          {b.advanceAvailable !== "0.00" && <p className="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">Advance received and not yet adjusted: <span className="font-semibold">{formatINR(b.advanceAvailable)}</span>. Adjust it on the next tax invoice so GST is charged on the full supply value.</p>}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Milestone</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Eligible</th>
                  <th className="px-3 py-2 text-right font-medium">Billed</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {b.milestones.map((m, i) => (
                  <tr key={m.id} className="align-top">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2 font-medium">
                        <span className={cn("size-2.5 rounded-full", COLORS[i % COLORS.length])} />
                        {m.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {m.basis === "PERCENT" && m.percent ? `${m.percent}% · ` : ""}
                        {m.triggerLabel}
                        {m.dueDate ? ` · ${m.dueDate}` : ""}
                        {m.days !== null ? ` · ${m.days} days` : ""} · {m.documentKind === "PROFORMA" ? "billed as proforma" : "billed as tax invoice"}
                      </span>
                      {m.invoices.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {m.invoices.map((inv) => (
                            <Link key={inv.id} href={`/client-invoices/${inv.id}`} className="rounded border px-1.5 text-xs text-primary hover:underline">
                              {inv.number} · {formatINR(inv.total)}
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatINR(m.amount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatINR(m.eligible)}
                      <span className="block text-[11px] text-muted-foreground">{m.eligibleReason}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatINR(m.billed)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatINR(m.received)}</td>
                    <td className="px-3 py-2">
                      <DocStatusBadge status={m.state} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {b.can.invoice && m.billable !== "0.00" && (
                          <Button size="sm" onClick={() => setRaise(m)}>
                            <Receipt /> {m.documentKind === "PROFORMA" ? "Raise advance request" : "Raise invoice"}
                          </Button>
                        )}
                        {b.can.markAchieved && !m.achievedAt && EVENT_TRIGGERS.includes(m.trigger) && m.eligible !== m.amount && (
                          <Button size="sm" variant="ghost" onClick={() => achieved(m)} disabled={busy === m.id}>
                            {busy === m.id ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Confirm reached
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">A milestone being due never means it is paid — “Received” counts only receipts allocated to its invoices. {b.advanceDocument === "PROFORMA" ? "Advance milestones are billed as proforma / advance requests (not tax invoices), per Settings → Commercial." : "Advance milestones are billed as tax invoices, per Settings → Commercial."}</p>
        </div>
      )}
      {raise && <RaiseInvoiceDialog m={raise} today={today} advanceAvailable={b.advanceAvailable} onClose={() => setRaise(null)} onDone={(id) => router.push(`/client-invoices/${id}`)} />}
    </Section>
  );
}

function RaiseInvoiceDialog({ m, today, advanceAvailable, onClose, onDone }: { m: BillingMilestone; today: string; advanceAvailable: string; onClose: () => void; onDone: (id: string) => void }) {
  const proforma = m.documentKind === "PROFORMA";
  const [v, setV] = useState({ amount: m.billable, adjustAdvance: proforma ? "0" : Number(advanceAvailable) > 0 ? advanceAvailable : "0", invoiceDate: today, dueDate: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const gross = (Number(v.amount || 0) + Number(v.adjustAdvance || 0)).toFixed(2);
  async function save() {
    setBusy(true);
    const res = await callAction(createMilestoneInvoiceAction, { milestoneId: m.id, ...v, dueDate: v.dueDate || null });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      return toast.error(res.error);
    }
    toast.success(`${proforma ? "Advance request" : "Invoice"} drafted — review and issue it.`);
    onDone(res.data.id);
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{proforma ? "Advance request (proforma)" : "Milestone tax invoice"} — {m.label}</DialogTitle>
          <DialogDescription>{proforma ? "A proforma asks the client for the advance. It is not a tax invoice; GST is charged on the tax invoice for the supply, where this advance will be adjusted." : `Up to ${formatINR(m.billable)} can be billed now (${m.eligibleReason.toLowerCase()}).`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="mi-amt" label="Amount to collect (incl. GST)" required error={errors.amount} help={`Max ${formatINR(m.billable)}`}>
            <Input id="mi-amt" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
          </Field>
          {!proforma && (
            <Field id="mi-adv" label="Less advance received" error={errors.adjustAdvance} help={`Available ${formatINR(advanceAvailable)} — invoiced with GST, then deducted.`}>
              <Input id="mi-adv" inputMode="decimal" value={v.adjustAdvance} onChange={(e) => setV({ ...v, adjustAdvance: e.target.value })} />
            </Field>
          )}
          <Field id="mi-date" label="Date" required error={errors.invoiceDate}>
            <Input id="mi-date" type="date" value={v.invoiceDate} onChange={(e) => setV({ ...v, invoiceDate: e.target.value })} />
          </Field>
          <Field id="mi-due" label="Due date" error={errors.dueDate} help={m.trigger === "NET_DAYS" && m.days !== null ? `Default: ${m.days} days` : "Default: client credit days"}>
            <Input id="mi-due" type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} />
          </Field>
        </div>
        {!proforma && Number(v.adjustAdvance) > 0 && <p className="rounded-md bg-muted px-3 py-2 text-sm">Invoice value {formatINR(gross)} (GST on the full supply) − advance {formatINR(Number(v.adjustAdvance).toFixed(2))} = <span className="font-semibold">{formatINR(Number(v.amount || 0).toFixed(2))} to collect</span></p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Draft {proforma ? "advance request" : "invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
