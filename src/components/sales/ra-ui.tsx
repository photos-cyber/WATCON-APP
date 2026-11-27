"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { formatQty } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { certifyRaBillAction, createRaBillAction, updateRaBillAction } from "@/modules/sales/actions";

/** Workflow stepper for running bills: where the bill is and what comes next. */
const STEPS = [
  { key: "DRAFT", label: "Prepare bill" },
  { key: "SUBMITTED", label: "With client" },
  { key: "CLIENT_CERTIFIED", label: "Certified" },
  { key: "INVOICED", label: "Invoiced" },
  { key: "PAID", label: "Paid" },
];
const ORDER: Record<string, number> = { DRAFT: 0, INTERNAL_REVIEW: 0, SUBMITTED: 1, DISPUTED: 1, CLIENT_CERTIFIED: 2, INVOICED: 3, PARTIALLY_PAID: 3, PAID: 4 };

export function RaStepper({ status }: { status: string }) {
  if (status === "CANCELLED") return <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">This running bill is cancelled; its quantities are free to bill again.</p>;
  const at = ORDER[status] ?? 0;
  return (
    <ol className="mb-4 flex flex-wrap gap-1 text-xs sm:flex-nowrap" aria-label="Bill progress">
      {STEPS.map((s, i) => {
        const done = i < at || (i === at && status === "PAID");
        const current = i === at && status !== "PAID";
        return (
          <li key={s.key} className={cn("flex flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5", done && "border-emerald-200 bg-emerald-50 text-emerald-800", current && (status === "DISPUTED" ? "border-rose-300 bg-rose-50 font-medium text-rose-800" : "border-primary/40 bg-primary/5 font-medium text-primary"), !done && !current && "text-muted-foreground")} aria-current={current ? "step" : undefined}>
            <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]", done && "border-emerald-400 bg-emerald-500 text-white")}>{done ? <Check className="size-3" /> : i + 1}</span>
            <span>{current && status === "DISPUTED" ? "Disputed by client" : current && status === "PARTIALLY_PAID" ? "Partly paid" : s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export type RaPrefillLine = { clientPoLineId: string; lineNo: number; boqRef: string | null; description: string; unit: string; contractQty: string; prevCertifiedQty: string; billedQty: string; leftQty: string; rate: string; gstRate: string };
type Claim = { claimedQty: string; measurementRef: string; remarks: string };

const mul = (q: string, r: string) => {
  const x = Number(q) * Number(r);
  return Number.isFinite(x) ? x : 0;
};

export function RaForm({ clientPoId, raId, version, lines, initial, terms }: { clientPoId: string; raId?: string; version?: number; lines: RaPrefillLine[]; initial: { billDate: string; periodFrom: string; periodTo: string; otherDeductions: string; deductionNotes: string; remarks: string; claims: Record<string, Claim> }; terms: { retentionPct: string; advanceRecoveryPct: string } }) {
  const router = useRouter();
  const [h, setH] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (p: Partial<typeof h>) => {
    setDirty(true);
    setH((s) => ({ ...s, ...p }));
  };
  const claim = (id: string): Claim => h.claims[id] ?? { claimedQty: "", measurementRef: "", remarks: "" };
  const setClaim = (id: string, p: Partial<Claim>) => set({ claims: { ...h.claims, [id]: { ...claim(id), ...p } } });
  const preview = useMemo(() => {
    let gross = 0;
    let gst = 0;
    for (const l of lines) {
      const a = mul(claim(l.clientPoLineId).claimedQty || "0", l.rate);
      gross += a;
      gst += (a * Number(l.gstRate)) / 100;
    }
    const retention = (gross * Number(terms.retentionPct)) / 100;
    return { gross, gst, retention };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.claims, lines, terms.retentionPct]);

  async function save() {
    setBusy(true);
    const payload = { clientPoId, billDate: h.billDate, periodFrom: h.periodFrom, periodTo: h.periodTo, otherDeductions: h.otherDeductions, deductionNotes: h.deductionNotes, remarks: h.remarks, lines: lines.map((l) => ({ clientPoLineId: l.clientPoLineId, claimedQty: claim(l.clientPoLineId).claimedQty || "0", measurementRef: claim(l.clientPoLineId).measurementRef, remarks: claim(l.clientPoLineId).remarks })) };
    const res = raId ? await callAction(updateRaBillAction, raId, version!, payload) : await callAction(createRaBillAction, payload);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    toast.success(raId ? "Running bill saved." : "Running bill prepared as draft.");
    router.push(`/running-bills/${res.data.id}`);
  }

  return (
    <form className="space-y-4 pb-24" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      <FormSection title="Bill period">
        <Field id="ra-date" label="Bill date" required error={errors.billDate}><Input id="ra-date" type="date" value={h.billDate} onChange={(e) => set({ billDate: e.target.value })} /></Field>
        <Field id="ra-from" label="Work done from" required error={errors.periodFrom}><Input id="ra-from" type="date" value={h.periodFrom} onChange={(e) => set({ periodFrom: e.target.value })} /></Field>
        <Field id="ra-to" label="Work done up to" required error={errors.periodTo}><Input id="ra-to" type="date" value={h.periodTo} onChange={(e) => set({ periodTo: e.target.value })} /></Field>
      </FormSection>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Quantities claimed this bill</h2>
          <p className="text-xs text-muted-foreground">Enter only this period&apos;s quantity. You cannot claim more than what is left on the contract (contract − everything already billed or claimed).</p>
        </div>
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left font-medium">Contract item</th>
                <th className="px-2 py-2 text-right font-medium">Contract</th>
                <th className="px-2 py-2 text-right font-medium">Certified so far</th>
                <th className="px-2 py-2 text-right font-medium">Left to bill</th>
                <th className="w-28 px-2 py-2 text-right font-medium">This bill</th>
                <th className="w-36 px-2 py-2 text-left font-medium">Measurement ref</th>
                <th className="px-2 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((l, i) => {
                const c = claim(l.clientPoLineId);
                const over = c.claimedQty && Number(c.claimedQty) > Number(l.leftQty);
                const err = errors[`lines.${i}.claimedQty`];
                return (
                  <tr key={l.clientPoLineId} className="align-top">
                    <td className="px-2 py-2"><div className="font-medium">{l.lineNo}. {l.description}</div><div className="text-xs text-muted-foreground">{l.boqRef ? `${l.boqRef} · ` : ""}₹{l.rate} / {l.unit} · GST {Number(l.gstRate)}%</div></td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.contractQty)} {l.unit}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.prevCertifiedQty)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      <button type="button" className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline" disabled={Number(l.leftQty) <= 0} onClick={() => setClaim(l.clientPoLineId, { claimedQty: l.leftQty })} title="Claim everything that is left">{formatQty(l.leftQty)}</button>
                    </td>
                    <td className="px-2 py-2">
                      <Input aria-label={`Claim for line ${l.lineNo}`} inputMode="decimal" className={cn("text-right", over && "border-rose-400")} value={c.claimedQty} disabled={Number(l.leftQty) <= 0} onChange={(e) => setClaim(l.clientPoLineId, { claimedQty: e.target.value })} aria-invalid={!!(over || err)} />
                      {(over || err) && <p className="mt-1 text-right text-xs text-destructive">{err ?? `Max ${formatQty(l.leftQty)}`}</p>}
                    </td>
                    <td className="px-2 py-2"><Input aria-label={`Measurement reference for line ${l.lineNo}`} value={c.measurementRef} onChange={(e) => setClaim(l.clientPoLineId, { measurementRef: e.target.value })} placeholder="MB page" /></td>
                    <td className="px-2 py-2 text-right tabular-nums">{c.claimedQty ? formatINR(mul(c.claimedQty, l.rate).toFixed(2)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {errors.lines && <p className="text-xs text-destructive">{errors.lines}</p>}
      </section>

      <FormSection title="Deductions" description={`Retention (${Number(terms.retentionPct)}%) and advance recovery (${Number(terms.advanceRecoveryPct)}%) are worked out automatically from the contract.`}>
        <Field id="ra-other" label="Other deductions (₹)" error={errors.otherDeductions} help="e.g. material supplied by client, penalties."><Input id="ra-other" inputMode="decimal" value={h.otherDeductions} onChange={(e) => set({ otherDeductions: e.target.value })} placeholder="0" /></Field>
        <Field id="ra-dnotes" label="Deduction details" error={errors.deductionNotes}><Input id="ra-dnotes" value={h.deductionNotes} onChange={(e) => set({ deductionNotes: e.target.value })} /></Field>
        <Field id="ra-remarks" label="Remarks" error={errors.remarks} className="sm:col-span-2"><Textarea id="ra-remarks" rows={2} value={h.remarks} onChange={(e) => set({ remarks: e.target.value })} /></Field>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <span className="mr-auto text-sm text-muted-foreground">Claim <span className="font-semibold text-foreground">{formatINR(preview.gross.toFixed(2))}</span> + GST {formatINR(preview.gst.toFixed(2))} · retention ≈ {formatINR(preview.retention.toFixed(2))}</span>
        <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" disabled={busy}>{raId ? "Save" : "Save draft"}</Button>
      </div>
    </form>
  );
}

export type CertifyLine = { id: string; lineNo: number; description: string; unit: string; claimedQty: string; rate: string };

/** Record the client's certification: certified quantity per line (prefilled with the claim), reference and deductions. */
export function CertifyForm({ id, version, lines, otherDeductions, deductionNotes }: { id: string; version: number; lines: CertifyLine[]; otherDeductions: string; deductionNotes: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, l.claimedQty])));
  const [ref, setRef] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [other, setOther] = useState(otherDeductions === "0.00" ? "" : otherDeductions);
  const [notes, setNotes] = useState(deductionNotes ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const total = lines.reduce((a, l) => a + mul(qty[l.id] || "0", l.rate), 0);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}><Check /> Record client certification</Button>;
  return (
    <section className="w-full space-y-3 rounded-xl border border-primary/30 bg-card p-4">
      <h2 className="text-sm font-semibold">Client certification</h2>
      <p className="text-xs text-muted-foreground">Enter what the client certified for each line (it can be less than claimed, never more). Uncertified quantity becomes free to claim again in the next bill.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-medium">Line</th><th className="py-1 text-right font-medium">Claimed</th><th className="w-32 py-1 text-right font-medium">Certified</th><th className="py-1 text-right font-medium">Amount</th></tr></thead>
          <tbody className="divide-y">
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td className="py-1.5">{l.lineNo}. {l.description}</td>
                <td className="py-1.5 text-right tabular-nums">{formatQty(l.claimedQty)} {l.unit}</td>
                <td className="py-1.5"><Input aria-label={`Certified quantity line ${l.lineNo}`} inputMode="decimal" className="text-right" value={qty[l.id] ?? ""} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} aria-invalid={!!errors[`lines.${i}.certifiedQty`] || Number(qty[l.id]) > Number(l.claimedQty)} />{(errors[`lines.${i}.certifiedQty`] || Number(qty[l.id]) > Number(l.claimedQty)) && <p className="text-right text-xs text-destructive">{errors[`lines.${i}.certifiedQty`] ?? `Max ${formatQty(l.claimedQty)}`}</p>}</td>
                <td className="py-1.5 text-right tabular-nums">{formatINR(mul(qty[l.id] || "0", l.rate).toFixed(2))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="cert-ref" label="Client certificate / reference" required error={errors.clientCertRef}><Input id="cert-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field id="cert-date" label="Certified on" required error={errors.clientCertDate}><Input id="cert-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field id="cert-other" label="Other deductions (₹)" error={errors.otherDeductions}><Input id="cert-other" inputMode="decimal" value={other} onChange={(e) => setOther(e.target.value)} placeholder="0" /></Field>
        <Field id="cert-notes" label="Deduction details" error={errors.deductionNotes}><Input id="cert-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-sm">Certified value <span className="font-semibold">{formatINR(total.toFixed(2))}</span></span>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button
          size="sm"
          disabled={busy || !ref.trim()}
          onClick={async () => {
            setBusy(true);
            const res = await callAction(certifyRaBillAction, id, version, { clientCertRef: ref, clientCertDate: date, otherDeductions: other, deductionNotes: notes, lines: lines.map((l) => ({ lineId: l.id, certifiedQty: qty[l.id] || "0" })) });
            setBusy(false);
            if (!res.ok) {
              setErrors(res.fieldErrors ?? {});
              toast.error(res.error);
              return;
            }
            toast.success("Certification recorded. You can now create the invoice.");
            setOpen(false);
            router.refresh();
          }}
        >
          Save certification
        </Button>
      </div>
    </section>
  );
}
