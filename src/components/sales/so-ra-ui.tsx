"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { formatQty } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { generateSoRunningBillAction } from "@/modules/sales/actions";

export type SoBillLine = { soLineId: string; lineNo: number; kind: "MATERIAL" | "SERVICE" | "INSTALLATION"; description: string; unit: string; contractQty: string; delivered: string; billed: string; billable: string; rate: string; gstRate: string };
export type SoStatementView = { previousValue: string; previousBilled: string; previousOutstanding: string; receivedToDate: string; advanceAvailable: string; hasFinal: boolean; finalShortageCredit?: string; finalShortageNote?: string | null };

const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const KIND: Record<SoBillLine["kind"], string> = { MATERIAL: "Material", SERVICE: "Service", INSTALLATION: "Installation" };

/**
 * Generate / refresh a cumulative running bill for a sales order. Material defaults to everything
 * delivered and not yet billed; services / installation default to 0 (the rest on a final bill).
 * The server re-derives every figure and enforces the contract and delivery limits.
 */
export function SoRunningBillForm({ soId, lines, statement, initial, draftNumber }: { soId: string; lines: SoBillLine[]; statement: SoStatementView; initial?: { isFinal: boolean; retentionPct: string; advanceRecovery: string; otherDeductions: string; deductionNotes: string; remarks: string; claims: Record<string, string> }; draftNumber?: string | null }) {
  const router = useRouter();
  const [isFinal, setFinal] = useState(initial?.isFinal ?? false);
  const [claims, setClaims] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.soLineId, initial?.claims[l.soLineId] ?? (l.kind === "MATERIAL" ? l.billable : "0")])));
  const [v, setV] = useState({ retentionPct: initial?.retentionPct ?? "0", advanceRecovery: initial?.advanceRecovery ?? "", otherDeductions: initial?.otherDeductions ?? "", deductionNotes: initial?.deductionNotes ?? "", remarks: initial?.remarks ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const value = (l: SoBillLine) => (QTY.test(claims[l.soLineId] ?? "") ? Number(claims[l.soLineId]) * Number(l.rate) : 0);
  const current = lines.reduce((a, l) => a + value(l), 0);
  const bad = lines.filter((l) => !QTY.test(claims[l.soLineId] ?? "0") || Number(claims[l.soLineId]) > Number(l.billable));

  async function submit() {
    setBusy(true);
    const res = await callAction(generateSoRunningBillAction, { soId, isFinal, ...v, lines: lines.map((l) => ({ soLineId: l.soLineId, claimedQty: claims[l.soLineId] || "0" })) });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    toast.success(res.data.consolidated ? `Draft ${res.data.number} refreshed with everything unbilled so far.` : `Running bill ${res.data.number} prepared as a draft.`);
    router.push(`/running-bills/${res.data.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 text-sm md:grid-cols-4">
        <Stat label="Previous material value" value={formatINR(statement.previousValue)} />
        <Stat label="New material value (this bill)" value={formatINR(current.toFixed(2))} strong />
        <Stat label="Cumulative value" value={formatINR((Number(statement.previousValue) + current).toFixed(2))} />
        <Stat label="Previous outstanding" value={formatINR(statement.previousOutstanding)} />
        <Stat label="Previously billed" value={formatINR(statement.previousBilled)} />
        <Stat label="Received to date" value={formatINR(statement.receivedToDate)} />
        <Stat label="Advance to recover" value={formatINR(statement.advanceAvailable)} />
      </dl>
      {draftNumber && <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">Draft {draftNumber} already exists — saving refreshes it (one draft per sales order), so nothing is billed twice.</p>}

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Item</th>
              <th className="px-2 py-2 text-right font-medium">Order qty</th>
              <th className="px-2 py-2 text-right font-medium" title="Sent on dispatched site challans (less shortage / damage), direct deliveries to site, or delivered to the client">Dispatched</th>
              <th className="px-2 py-2 text-right font-medium">Billed before</th>
              <th className="px-2 py-2 text-right font-medium">Can bill now</th>
              <th className="w-32 px-2 py-2 text-right font-medium">This bill</th>
              <th className="px-2 py-2 text-right font-medium">Rate</th>
              <th className="px-2 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((l, i) => {
              const q = claims[l.soLineId] ?? "";
              const over = QTY.test(q) && Number(q) > Number(l.billable);
              return (
                <tr key={l.soLineId} className="align-top">
                  <td className="px-2 py-2">
                    <div className="font-medium">{l.lineNo}. {l.description}</div>
                    <div className="text-xs text-muted-foreground">{KIND[l.kind]} · GST {Number(l.gstRate)}%</div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.contractQty)} <span className="text-xs text-muted-foreground">{l.unit}</span></td>
                  <td className="px-2 py-2 text-right tabular-nums">{l.kind === "MATERIAL" ? formatQty(l.delivered) : "—"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(l.billed)}</td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{formatQty(l.billable)}</td>
                  <td className="px-2 py-2">
                    <Input aria-label={`Bill quantity for ${l.description}`} inputMode="decimal" className={cn("text-right", over && "border-destructive")} value={q} onChange={(e) => setClaims((c) => ({ ...c, [l.soLineId]: e.target.value }))} aria-invalid={over || !!errors[`lines.${i}.claimedQty`]} />
                    {(over || errors[`lines.${i}.claimedQty`]) && <p className="mt-1 text-right text-xs text-destructive">{errors[`lines.${i}.claimedQty`] ?? `Max ${formatQty(l.billable)}`}</p>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatINR(l.rate)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatINR(value(l).toFixed(2))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {errors.lines && <p className="text-sm text-destructive">{errors.lines}</p>}

      <FormSection title="Deductions & notes" description="Retention, advance recovery and other deductions reduce this bill's net amount. Advance recovery is automatic when left empty.">
        <Field id="so-ra-ret" label="Retention %" error={errors.retentionPct}><Input id="so-ra-ret" inputMode="decimal" value={v.retentionPct} onChange={(e) => setV({ ...v, retentionPct: e.target.value })} /></Field>
        <Field id="so-ra-adv" label="Advance recovery ₹" error={errors.advanceRecovery} help={`Up to ${formatINR(statement.advanceAvailable)}. Empty = automatic.`}><Input id="so-ra-adv" inputMode="decimal" placeholder="Automatic" value={v.advanceRecovery} onChange={(e) => setV({ ...v, advanceRecovery: e.target.value })} /></Field>
        <Field id="so-ra-oth" label="Other deductions ₹" error={errors.otherDeductions}><Input id="so-ra-oth" inputMode="decimal" value={v.otherDeductions} onChange={(e) => setV({ ...v, otherDeductions: e.target.value })} /></Field>
        <Field id="so-ra-dn" label="Deduction notes"><Input id="so-ra-dn" value={v.deductionNotes} onChange={(e) => setV({ ...v, deductionNotes: e.target.value })} /></Field>
        <Field id="so-ra-rem" label="Remarks" className="sm:col-span-2"><Textarea id="so-ra-rem" rows={2} value={v.remarks} onChange={(e) => setV({ ...v, remarks: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox checked={isFinal} onCheckedChange={(c) => { const f = c === true; setFinal(f); if (f) setClaims(Object.fromEntries(lines.map((l) => [l.soLineId, l.billable]))); }} />
          Final bill — bills everything still billable (incl. services / installation) and recovers the remaining advance. No further bills after it.
        </label>
        {isFinal && Number(statement.finalShortageCredit ?? 0) > 0 && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:col-span-2 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            A GST credit note of about {formatINR(statement.finalShortageCredit!)} will be raised and applied automatically when this final bill is invoiced (material billed earlier that never fully reached the site). {statement.finalShortageNote}
          </p>
        )}
      </FormSection>

      <div className="flex justify-end">
        <Button disabled={busy || bad.length > 0 || current <= 0} onClick={submit}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} {draftNumber ? "Refresh draft bill" : "Prepare running bill"}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", strong ? "text-base font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}
