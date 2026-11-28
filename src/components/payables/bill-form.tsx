"use client";

import { AlertTriangle, CheckCircle2, FileText, Loader2, Wrench } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { LinesEditor, TotalsPanel, emptyLine, safeTotals, type EditableLine } from "@/components/commercial/lines-editor";
import { SingleSelect } from "@/components/forms/combobox";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { GSTIN_RE, TDS_SECTIONS } from "@/lib/gst";
import { formatINR, pctOf, subMoney, taxModeFor, type TaxMode } from "@/lib/money";
import { cn } from "@/lib/utils";
import { billPrefillAction, createBillAction, updateBillAction } from "@/modules/payables/actions";
import { matchBill, type GrnLineRef, type MatchMode, type PoLineRef } from "@/modules/payables/match";
import { linesFromPrefill, refsFromPrefill } from "./bill-prefill";

export type BillPoOption = { id: string; number: string; supplier: string; projectId: string | null; project: string | null; total: string; orderDate: string };
export type BillPartyOpt = { id: string; name: string; code: string; gstin: string | null; stateCode: string | null; paymentTermsDays: number | null; tdsSection: string | null; tdsRate: string | null; status: string };
export type BillProjectOpt = { id: string; code: string; name: string };

/** Live counters from the PO for the match preview (same shape the server uses). */
export type MatchRefs = { poNumber: string; poTaxMode: TaxMode; mode: MatchMode; rateTolerancePct: string; poLines: PoLineRef[]; grnLines: GrnLineRef[] };

export type BillFormValues = {
  kind: "PO" | "DIRECT";
  poId: string | null;
  projectId: string | null;
  partyId: string | null;
  supplierInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  supplierGstin: string;
  charges: string;
  chargesGstRate: string;
  roundToRupee: boolean;
  tdsSection: string;
  tdsRate: string;
  remarks: string;
  lines: EditableLine[];
};


export function BillForm({ initial, initialRefs, billId, version, pos, suppliers, projects, companyStateCode, lockProject }: { initial: BillFormValues; initialRefs: MatchRefs | null; billId?: string; version?: number; pos: BillPoOption[]; suppliers: BillPartyOpt[]; projects: BillProjectOpt[]; companyStateCode: string | null; lockProject?: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<BillFormValues>({ ...initial, lines: initial.lines.length ? initial.lines : [emptyLine()] });
  const [refs, setRefs] = useState<MatchRefs | null>(initialRefs);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadingPo, setLoadingPo] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (patch: Partial<BillFormValues>) => {
    setDirty(true);
    setV((s) => ({ ...s, ...patch }));
  };

  const party = suppliers.find((s) => s.id === v.partyId);
  const gstinState = GSTIN_RE.test(v.supplierGstin.trim().toUpperCase()) ? v.supplierGstin.trim().slice(0, 2) : null;
  const mode = taxModeFor(companyStateCode, gstinState ?? party?.stateCode);
  const totals = useMemo(() => safeTotals(v.lines, mode, { charges: v.charges, chargesGstRate: v.chargesGstRate, roundToRupee: v.roundToRupee }), [v.lines, mode, v.charges, v.chargesGstRate, v.roundToRupee]);
  const tds = totals && v.tdsSection && Number(v.tdsRate) > 0 ? safe(() => pctOf(totals.taxable, v.tdsRate)) : null;
  const net = totals ? subMoney(totals.total, tds ?? "0") : null;

  const match = useMemo(() => {
    if (v.kind === "DIRECT" || !refs) return null;
    try {
      return matchBill({
        mode: refs.mode,
        rateTolerancePct: refs.rateTolerancePct,
        billTaxMode: mode,
        poTaxMode: refs.poTaxMode,
        supplierGstin: v.supplierGstin || null,
        partyGstin: party?.gstin ?? null,
        hasPo: true,
        lines: v.lines.map((l, i) => ({ lineNo: i + 1, description: l.description || `Line ${i + 1}`, quantity: l.quantity || "0", rate: l.rate || "0", poLineId: l.links?.poLineId ?? null, grnLineId: l.links?.grnLineId ?? null })),
        poLines: refs.poLines,
        grnLines: refs.grnLines,
      });
    } catch {
      return null;
    }
  }, [v.kind, v.lines, v.supplierGstin, refs, mode, party?.gstin]);

  async function pickPo(poId: string | null) {
    if (!poId) {
      set({ poId: null, lines: [emptyLine()] });
      setRefs(null);
      return;
    }
    setLoadingPo(true);
    const res = await callAction(billPrefillAction, poId);
    setLoadingPo(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const p = res.data;
    const lines = linesFromPrefill(p);
    if (!lines.length) toast.info(`Everything on ${p.po.number} has already been billed${p.mode === "THREE_WAY" ? " or is not yet received at site" : ""}.`);
    set({ poId, projectId: p.project?.id ?? null, partyId: p.party.id, supplierGstin: p.party.gstin ?? "", tdsSection: p.party.tdsSection ?? "", tdsRate: p.party.tdsRate ?? "", lines: lines.length ? lines : [emptyLine()] });
    setRefs(refsFromPrefill(p));
  }

  async function save(finalize = false) {
    setBusy(true);
    const payload = {
      poId: v.kind === "PO" ? v.poId : null,
      projectId: v.projectId,
      partyId: v.partyId,
      supplierInvoiceNo: v.supplierInvoiceNo,
      invoiceDate: v.invoiceDate,
      dueDate: v.dueDate,
      supplierGstin: v.supplierGstin,
      charges: v.charges,
      chargesGstRate: v.chargesGstRate,
      roundToRupee: v.roundToRupee,
      tdsSection: v.tdsSection,
      tdsRate: v.tdsRate,
      remarks: v.remarks,
      lines: v.lines.map((l) => ({ description: l.description, hsnCode: l.hsnSac, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, poLineId: v.kind === "PO" ? (l.links?.poLineId ?? null) : null, grnLineId: v.kind === "PO" ? (l.links?.grnLineId ?? null) : null, itemBrandId: l.links?.itemBrandId ?? null })),
    };
    const res = billId ? await callAction(updateBillAction, billId, version!, payload, { finalize }) : await callAction(createBillAction, payload, { finalize });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    const d = res.data as { finalized?: boolean; held?: string[] | null; finalizeError?: string | null };
    if (!finalize) toast.success(billId ? "Bill saved." : "Bill saved as draft — attach the supplier's invoice and finalize it.");
    else if (d.finalizeError) toast.warning(`Saved as draft, not finalized: ${d.finalizeError}`);
    else if (d.held) toast.warning(`Saved and held for checking: ${d.held.join(" ")}`);
    else toast.success("Bill finalized — ready to pay. Attach the supplier's invoice on the bill page.");
    router.push(`/supplier-bills/${res.data.id}`);
  }

  const poChoices = pos.filter((p) => !lockProject || !v.projectId || p.projectId === v.projectId);

  return (
    <form
      className="space-y-4 pb-24"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <FormSection title="1. What is this bill for?" description="Bills against a purchase order are checked automatically against what was ordered and received.">
        <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
          {(
            [
              { k: "PO", icon: FileText, title: "Against a purchase order", text: "Material or work ordered on a PO. Lines are filled in from the site receipts." },
              { k: "DIRECT", icon: Wrench, title: "Without a purchase order", text: "Services, transport, hire charges or other expenses for a project." },
            ] as const
          ).map((o) => (
            <button
              key={o.k}
              type="button"
              disabled={!!billId && v.kind !== o.k}
              onClick={() => {
                if (v.kind === o.k) return;
                set({ kind: o.k, poId: null, lines: [emptyLine()] });
                setRefs(null);
              }}
              className={cn("flex gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-50", v.kind === o.k ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50")}
              aria-pressed={v.kind === o.k}
            >
              <o.icon className="mt-0.5 size-5 shrink-0 text-primary" />
              <span>
                <span className="block font-medium">{o.title}</span>
                <span className="block text-xs text-muted-foreground">{o.text}</span>
              </span>
            </button>
          ))}
        </div>
        {v.kind === "PO" ? (
          <Field id="bill-po" label="Purchase order" required error={errors.poId} help={poChoices.length ? "Only approved POs with something left to bill are listed." : "No approved purchase orders are waiting for a bill."} className="sm:col-span-2">
            <div className="flex items-center gap-2">
              <SingleSelect id="bill-po" options={poChoices.map((p) => ({ value: p.id, label: `${p.number} · ${p.supplier}`, hint: `${p.project ?? ""} · ${formatINR(p.total)}` }))} value={v.poId} onChange={(x) => void pickPo(x)} placeholder="Search PO number or supplier" />
              {loadingPo && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </div>
          </Field>
        ) : (
          <>
            <Field id="bill-project" label="Project" required error={errors.projectId}>
              <SingleSelect id="bill-project" options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))} value={v.projectId} onChange={(x) => set({ projectId: x })} disabled={lockProject} placeholder="Select project" />
            </Field>
            <Field id="bill-party" label="Supplier" required error={errors.partyId}>
              <SingleSelect
                id="bill-party"
                options={suppliers.filter((s) => s.status === "ACTIVE" || s.id === v.partyId).map((s) => ({ value: s.id, label: s.name, hint: s.gstin ?? "Unregistered" }))}
                value={v.partyId}
                onChange={(x) => {
                  const s = suppliers.find((p) => p.id === x);
                  set({ partyId: x, supplierGstin: s?.gstin ?? "", tdsSection: s?.tdsSection ?? "", tdsRate: s?.tdsRate ?? "" });
                }}
                placeholder="Select supplier"
              />
            </Field>
          </>
        )}
        {v.kind === "PO" && v.poId && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Supplier: <span className="font-medium text-foreground">{party?.name ?? "—"}</span> · Project: <span className="font-medium text-foreground">{projects.find((p) => p.id === v.projectId)?.code ?? "—"}</span>
          </p>
        )}
      </FormSection>

      <FormSection title="2. Supplier's invoice" description="Copy these from the supplier's tax invoice. Attach the scanned invoice after saving.">
        <Field id="bill-inv" label="Supplier invoice number" required error={errors.supplierInvoiceNo} help="We check this against earlier bills from the same supplier to stop duplicates.">
          <Input id="bill-inv" value={v.supplierInvoiceNo} onChange={(e) => set({ supplierInvoiceNo: e.target.value })} aria-invalid={!!errors.supplierInvoiceNo} />
        </Field>
        <Field id="bill-date" label="Invoice date" required error={errors.invoiceDate}>
          <Input id="bill-date" type="date" value={v.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} />
        </Field>
        <Field id="bill-due" label="Due date" error={errors.dueDate} help={party?.paymentTermsDays != null ? `Leave blank to use the supplier's ${party.paymentTermsDays}-day terms.` : undefined}>
          <Input id="bill-due" type="date" value={v.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
        </Field>
        <Field id="bill-gstin" label="Supplier GSTIN on the invoice" error={errors.supplierGstin} help={`Tax: ${mode === "INTRA" ? "CGST + SGST (same state)" : "IGST (other state)"}`}>
          <Input id="bill-gstin" value={v.supplierGstin} onChange={(e) => set({ supplierGstin: e.target.value.toUpperCase() })} maxLength={15} className="font-mono uppercase" />
        </Field>
        <Field id="bill-tds" label="TDS section" error={errors.tdsSection} help="Tax deducted at source, if applicable.">
          <select id="bill-tds" className="h-9 w-full rounded-md border bg-card px-2 text-sm" value={v.tdsSection} onChange={(e) => set({ tdsSection: e.target.value })}>
            <option value="">No TDS</option>
            {TDS_SECTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field id="bill-tdsrate" label="TDS rate %" error={errors.tdsRate}>
          <Input id="bill-tdsrate" inputMode="decimal" value={v.tdsRate} disabled={!v.tdsSection} onChange={(e) => set({ tdsRate: e.target.value })} />
        </Field>
      </FormSection>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">3. Lines</h2>
          <p className="text-xs text-muted-foreground">{v.kind === "PO" ? "Adjust quantities and rates to exactly what the supplier invoiced. Remove lines that are not on this invoice." : "Describe each charge on the invoice."}</p>
        </div>
        <LinesEditor lines={v.lines} onChange={(lines) => set({ lines })} variant="text" mode={mode} errors={errors} allowAdd={v.kind === "DIRECT" || !v.poId} />
      </section>

      {match && <MatchPreview result={match} refs={refs!} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <FormSection title="Freight & remarks">
          <Field id="bill-charges" label="Freight / other charges ₹" error={errors.charges}>
            <Input id="bill-charges" inputMode="decimal" value={v.charges} onChange={(e) => set({ charges: e.target.value })} />
          </Field>
          <Field id="bill-chgst" label="GST on charges %">
            <Input id="bill-chgst" inputMode="decimal" value={v.chargesGstRate} onChange={(e) => set({ chargesGstRate: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox checked={v.roundToRupee} onCheckedChange={(c) => set({ roundToRupee: c === true })} /> Round the total to the nearest rupee (as on the invoice)
          </label>
          <Field id="bill-remarks" label="Remarks" className="sm:col-span-2">
            <Textarea id="bill-remarks" rows={2} value={v.remarks} onChange={(e) => set({ remarks: e.target.value })} />
          </Field>
        </FormSection>
        <div className="rounded-xl border bg-card p-4">
          <TotalsPanel totals={totals} mode={mode} />
          {totals && (
            <div className="mt-2 space-y-1 border-t pt-2 text-sm">
              {tds && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Less TDS ({v.tdsSection} @ {v.tdsRate}%)</span>
                  <span className="tabular-nums">−{formatINR(tds)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold">
                <span>Net payable to supplier</span>
                <span className="tabular-nums">{formatINR(net)}</span>
              </div>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Final amounts are recalculated on the server when you save.</p>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void save(false)}>
          Save draft
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          Save &amp; finalize
        </Button>
      </div>
    </form>
  );
}

function safe<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

export function MatchPreview({ result, refs }: { result: ReturnType<typeof matchBill>; refs: MatchRefs }) {
  const ok = result.exceptions.length === 0;
  return (
    <div role="status" className={cn("rounded-xl border p-4", ok ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60")}>
      <div className="flex items-center gap-2 font-medium">
        {ok ? <CheckCircle2 className="size-5 text-emerald-600" /> : <AlertTriangle className="size-5 text-amber-600" />}
        {ok ? `Matches ${refs.poNumber}` : `${result.exceptions.length} difference${result.exceptions.length > 1 ? "s" : ""} from ${refs.poNumber}`}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Checked {refs.mode === "THREE_WAY" ? "against the quantity received and accepted at site (3-way match)" : "against the quantity ordered (2-way match)"}
        {Number(refs.rateTolerancePct) ? `, rate tolerance ${Number(refs.rateTolerancePct)}%` : ""}.
        {!ok && " You can still save it; an approver must reject it or approve with an override and a reason."}
      </p>
      {!ok && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {result.exceptions.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
