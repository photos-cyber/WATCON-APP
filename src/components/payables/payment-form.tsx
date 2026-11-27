"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { SingleSelect } from "@/components/forms/combobox";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { formatDate } from "@/lib/format";
import { addMoney, cmpMoney, formatINR, subMoney } from "@/lib/money";
import { cn, newId } from "@/lib/utils";
import { createPaymentAction } from "@/modules/payables/actions";

export type OpenDoc = { id: string; number: string; ref: string | null; date: string; dueDate: string | null; net: string; outstanding: string; project: string | null };
type PartyOpt = { id: string; name: string; status: string };
type ProjectOpt = { id: string; code: string; name: string };

const MODES = [
  ["BANK_TRANSFER", "Bank transfer"],
  ["UPI", "UPI"],
  ["CHEQUE", "Cheque"],
  ["CASH", "Cash"],
  ["CARD", "Card"],
  ["OTHER", "Other"],
] as const;

const isAmount = (s: string) => /^\d{1,14}(\.\d{1,2})?$/.test(s.trim());

/**
 * Supplier payment / client receipt. The party and project are chosen first (the page reloads
 * with them in the URL so the list of open bills / invoices comes from the server); amounts can
 * be split by hand or auto-allocated oldest-due first. Anything left over is kept as an advance.
 */
export function PaymentForm({ direction, partyId, projectId, parties, projects, openDocs, preselect, lockProject, today, po = null, so = null }: { direction: "OUT" | "IN"; partyId: string | null; projectId: string | null; parties: PartyOpt[]; projects: ProjectOpt[]; openDocs: OpenDoc[]; preselect: string | null; lockProject: boolean; today: string; po?: { id: string; number: string; generalStock: boolean } | null; so?: { id: string; number: string } | null }) {
  const router = useRouter();
  const out = direction === "OUT";
  const pre = openDocs.find((d) => d.id === preselect);
  const [idempotencyKey] = useState(() => newId());
  const [v, setV] = useState({ paymentDate: today, mode: "BANK_TRANSFER", reference: "", bankAccount: "", amount: pre?.outstanding ?? "", tdsAmount: "", remarks: "" });
  const [alloc, setAllocRaw] = useState<Record<string, string>>(pre ? { [pre.id]: pre.outstanding } : {});
  /** Until the user edits allocations by hand, the preselected document follows the amount typed (capped at its outstanding). */
  const [allocTouched, setAllocTouched] = useState(false);
  const setAlloc: typeof setAllocRaw = (next) => {
    setAllocTouched(true);
    setAllocRaw(next);
  };
  const followAmount = (amount: string, tds: string) => {
    if (allocTouched || !pre) return;
    if (!isAmount(amount || "0") || !isAmount(tds || "0")) return;
    const g = addMoney(amount || "0", tds || "0");
    setAllocRaw({ [pre.id]: cmpMoney(g, pre.outstanding) >= 0 ? pre.outstanding : g });
  };
  /** Client receipts: settle invoices now, or keep the whole amount as an advance. */
  const [settle, setSettle] = useState<"invoices" | "advance">(openDocs.length || pre ? "invoices" : "advance");
  const [proof, setProof] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (p: Partial<typeof v>) => {
    setDirty(true);
    setV((s) => ({ ...s, ...p }));
  };
  const nav = (p: Record<string, string | null>) => {
    const qs = new URLSearchParams({ direction });
    const next = { partyId, projectId, poId: po?.id ?? null, soId: so?.id ?? null, ...p };
    for (const [k, val] of Object.entries(next)) if (val) qs.set(k, val);
    if ("projectId" in p || !lockProject) qs.set("pick", "1");
    router.replace(`/payments/new?${qs}`);
  };

  const gross = isAmount(v.amount || "0") && isAmount(v.tdsAmount || "0") ? addMoney(v.amount || "0", v.tdsAmount || "0") : null;
  const allocated = useMemo(() => {
    try {
      return addMoney(...Object.values(alloc).filter((a) => a.trim()));
    } catch {
      return null;
    }
  }, [alloc]);
  const advance = gross && allocated ? subMoney(gross, allocated) : null;
  const over = advance !== null && cmpMoney(advance, "0") < 0;

  function autoAllocate() {
    if (!gross) return toast.error("Enter the amount first.");
    let left = gross;
    const next: Record<string, string> = {};
    for (const d of openDocs) {
      if (cmpMoney(left, "0") <= 0) break;
      const take = cmpMoney(left, d.outstanding) >= 0 ? d.outstanding : left;
      next[d.id] = take;
      left = subMoney(left, take);
    }
    setDirty(true);
    setAlloc(next);
  }

  async function save() {
    setBusy(true);
    const allocations = settle === "advance" ? [] : Object.entries(alloc)
      .filter(([, a]) => a.trim() && Number(a) > 0)
      .map(([documentId, amount]) => ({ documentId, amount: amount.trim() }));
    let fd: FormData | null = null;
    if (proof) {
      fd = new FormData();
      fd.set("file", proof);
    }
    const res = await callAction(createPaymentAction, { direction, partyId, projectId, poId: po?.id ?? null, soId: so?.id ?? null, ...v, tdsAmount: out ? "" : v.tdsAmount, idempotencyKey, allocations }, fd);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    toast.success(out ? "Payment recorded." : "Receipt recorded.");
    router.push(`/payments/${res.data.id}`);
  }

  return (
    <form
      className="space-y-4 pb-24"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <FormSection title={out ? "1. Who are you paying?" : "1. Who paid you?"} description="A payment belongs to one project and settles that project's documents only.">
        {po && <p className="text-sm sm:col-span-2">Against purchase order <span className="font-medium">{po.number}</span>{po.generalStock ? " — general stock (not charged to a project)" : ""}. Anything not set against its bills stays as an advance on this PO.</p>}
        {so && <p className="text-sm sm:col-span-2">Against sales order <span className="font-medium">{so.number}</span>. Anything not set against its invoices stays as an advance on this order and is offered against its next invoice.</p>}
        <Field id="pay-project" label="Project" required={!po?.generalStock} error={errors.projectId}>
          <SingleSelect id="pay-project" options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))} value={projectId} disabled={lockProject} onChange={(x) => nav({ projectId: x })} placeholder={po?.generalStock ? "General stock" : "Select project"} />
        </Field>
        <Field id="pay-party" label={out ? "Supplier" : "Client"} required error={errors.partyId}>
          <SingleSelect id="pay-party" options={parties.filter((p) => p.status === "ACTIVE" || p.id === partyId).map((p) => ({ value: p.id, label: p.name }))} value={partyId} onChange={(x) => nav({ partyId: x })} placeholder={out ? "Select supplier" : "Select client"} />
        </Field>
      </FormSection>

      {partyId && (projectId || po) && (
        <>
          <FormSection title="2. Payment details">
            <Field id="pay-date" label="Date" required error={errors.paymentDate}>
              <Input id="pay-date" type="date" value={v.paymentDate} onChange={(e) => set({ paymentDate: e.target.value })} />
            </Field>
            <Field id="pay-mode" label="Mode" required error={errors.mode}>
              <select id="pay-mode" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={v.mode} onChange={(e) => set({ mode: e.target.value })}>
                {MODES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="pay-ref" label={v.mode === "CHEQUE" ? "Cheque number" : "UTR / transaction reference"} error={errors.reference}>
              <Input id="pay-ref" value={v.reference} onChange={(e) => set({ reference: e.target.value })} />
            </Field>

            <Field id="pay-amount" label={out ? "Amount paid ₹" : "Amount received ₹"} required error={errors.amount}>
              <Input id="pay-amount" inputMode="decimal" className="text-right text-base font-semibold" value={v.amount} onChange={(e) => { set({ amount: e.target.value }); followAmount(e.target.value, v.tdsAmount); }} aria-invalid={!!errors.amount} />
            </Field>
            {!out && (
              <Field id="pay-tds" label="TDS deducted by client ₹" error={errors.tdsAmount} help="Counts towards settling the invoice; claim it against Form 26AS.">
                <Input id="pay-tds" inputMode="decimal" className="text-right" value={v.tdsAmount} onChange={(e) => { set({ tdsAmount: e.target.value }); followAmount(v.amount, e.target.value); }} />
              </Field>
            )}
          </FormSection>

          {!out && (
            <div role="radiogroup" aria-label="Settlement" className="flex flex-wrap gap-2">
              {([["invoices", "Settle invoices"], ["advance", "Keep as advance (no invoice yet)"]] as const).map(([k, l]) => (
                <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", settle === k && "border-primary bg-primary/5 font-medium")}>
                  <input type="radio" name="settle" className="accent-primary" checked={settle === k} onChange={() => { setDirty(true); setSettle(k); }} /> {l}
                </label>
              ))}
            </div>
          )}

          {(out || settle === "invoices") && (
          <section className="rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">3. {out ? "Which bills does this pay?" : "Which invoices does this settle?"}</h2>
                <p className="text-xs text-muted-foreground">Oldest due first. Leave everything unticked to record an advance.</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={autoAllocate} disabled={!openDocs.length}>
                <Sparkles /> Auto-allocate
              </Button>
            </div>
            {openDocs.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">{out ? "No approved, unpaid bills for this supplier on this project. The whole amount will be kept as an advance." : "No issued, unpaid invoices for this client on this project. The whole amount will be kept as an advance."}</p>
            ) : (
              <ul className="divide-y">
                {openDocs.map((d) => {
                  const checked = alloc[d.id] !== undefined;
                  const overdue = d.dueDate && d.dueDate.slice(0, 10) < today;
                  return (
                    <li key={d.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3", checked && "bg-primary/5")}>
                      <Checkbox
                        aria-label={`Settle ${d.number}`}
                        checked={checked}
                        onCheckedChange={(c) => {
                          setDirty(true);
                          setAlloc((s) => {
                            const n = { ...s };
                            if (c === true) n[d.id] = d.outstanding;
                            else delete n[d.id];
                            return n;
                          });
                        }}
                      />
                      <div className="min-w-48 flex-1">
                        <div className="font-medium">
                          {d.number}
                          {d.ref ? <span className="ml-1 text-xs font-normal text-muted-foreground">inv {d.ref}</span> : null}
                        </div>
                        <div className={cn("text-xs text-muted-foreground", overdue && "text-rose-700")}>
                          {formatDate(d.date)} · due {formatDate(d.dueDate)}
                          {overdue ? " · overdue" : ""} · outstanding {formatINR(d.outstanding)}
                        </div>
                      </div>
                      <Input
                        aria-label={`Amount for ${d.number}`}
                        inputMode="decimal"
                        className="w-36 text-right"
                        disabled={!checked}
                        value={alloc[d.id] ?? ""}
                        onChange={(e) => {
                          setDirty(true);
                          setAlloc((s) => ({ ...s, [d.id]: e.target.value }));
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="space-y-1 border-t px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total {out ? "paid" : "received"}{!out && v.tdsAmount ? " incl. TDS" : ""}</span>
                <span className="tabular-nums">{formatINR(gross)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Allocated</span>
                <span className="tabular-nums">{formatINR(allocated)}</span>
              </div>
              <div className={cn("flex justify-between font-semibold", over ? "text-destructive" : "")}>
                <span>{over ? "Allocated more than the amount" : "Kept as advance"}</span>
                <span className="tabular-nums">{formatINR(advance)}</span>
              </div>
              {errors.allocations && <p className="text-xs text-destructive">{errors.allocations}</p>}
            </div>
          </section>
          )}
          {!out && settle === "advance" && <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">The whole {formatINR(gross)} is kept as a client advance. Set it against invoices later from the receipt (“Allocate advance”), or recover it on running bills.</p>}

          <FormSection title="Remarks & proof">
            <Field id="pay-remarks" label="Remarks" className="sm:col-span-2">
              <Textarea id="pay-remarks" rows={2} value={v.remarks} onChange={(e) => set({ remarks: e.target.value })} />
            </Field>
            <details className="sm:col-span-2">
              <summary className="cursor-pointer text-sm text-primary">More details (bank account)</summary>
              <div className="mt-3">
                <Field id="pay-bank" label="Bank account" error={errors.bankAccount}>
                  <Input id="pay-bank" value={v.bankAccount} placeholder="e.g. HDFC current a/c …1234" onChange={(e) => set({ bankAccount: e.target.value })} />
                </Field>
              </div>
            </details>
            <Field id="pay-proof" label="Supporting proof (optional)" className="sm:col-span-2" help="Bank advice, UTR screenshot or cheque photo — saved with the payment.">
              <Input id="pay-proof" type="file" accept="image/*,application/pdf" onChange={(e) => { setDirty(true); setProof(e.target.files?.[0] ?? null); }} />
            </Field>
          </FormSection>
        </>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !partyId || (!projectId && !po) || over}>
          {busy && <Loader2 className="animate-spin" />}
          {out ? "Record payment" : "Record receipt"}
        </Button>
      </div>
    </form>
  );
}
