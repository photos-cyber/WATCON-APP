"use client";

import { Loader2, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { TotalsPanel, safeAmounts, safeTotals, type EditableLine, type ItemBrandOpt } from "@/components/commercial/lines-editor";
import { MilestoneBuilder, type SavedTemplate } from "@/components/commercial/milestone-builder";
import { SingleSelect } from "@/components/forms/combobox";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { formatINR, taxModeFor } from "@/lib/money";
import { newId } from "@/lib/utils";
import type { MilestoneInput } from "@/modules/commercial/payment-terms";
import { createQuotationAction, updateQuotationAction } from "@/modules/sales/quotation-actions";
import type { ClientOpt, ProjectOpt } from "./cpo-form";

export type QuoteLine = EditableLine & { brand?: string };
export type QuotationFormValues = {
  projectId: string | null;
  partyId: string | null;
  subject: string;
  quoteDate: string;
  validUntil: string;
  deliveryTerms: string;
  paymentTermsText: string;
  terms: string;
  notes: string;
  lines: QuoteLine[];
  milestones: MilestoneInput[];
};

const GST = ["0", "0.25", "3", "5", "12", "18", "28"];
export const blankQuoteLine = (): QuoteLine => ({ key: newId(), itemBrandId: null, description: "", brand: "", hsnSac: "", unit: "", quantity: "", rate: "", discountPct: "0", gstRate: "18" });

/** Client quotation editor: items/services, live totals, payment milestone builder, terms. */
export function QuotationForm({ initial, quotationId, version, projects, clients, options, companyStateCode, savedTemplates, canSaveTemplate, lockProject }: { initial: QuotationFormValues; quotationId?: string; version?: number; projects: ProjectOpt[]; clients: ClientOpt[]; options: ItemBrandOpt[]; companyStateCode: string | null; savedTemplates: SavedTemplate[]; canSaveTemplate: boolean; lockProject?: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<QuotationFormValues>({ ...initial, lines: initial.lines.length ? initial.lines : [blankQuoteLine()] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (p: Partial<QuotationFormValues>) => {
    setDirty(true);
    setV((s) => ({ ...s, ...p }));
  };
  const setLine = (i: number, p: Partial<QuoteLine>) => set({ lines: v.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const client = clients.find((c) => c.id === v.partyId);
  const mode = taxModeFor(companyStateCode, client?.stateCode);
  const totals = useMemo(() => safeTotals(v.lines, mode, { roundToRupee: true }), [v.lines, mode]);
  const optMap = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const comboOptions = useMemo(() => options.map((o) => ({ value: o.id, label: `${o.itemName} — ${o.brandName}`, hint: o.itemCode })), [options]);
  const project = projects.find((p) => p.id === v.projectId);

  async function save() {
    setBusy(true);
    const payload = {
      ...v,
      validUntil: v.validUntil || null,
      lines: v.lines.map((l) => ({ itemBrandId: l.itemBrandId || null, description: l.description, brand: l.brand || null, hsnSac: l.hsnSac || null, unit: l.unit, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct || "0", gstRate: l.gstRate })),
    };
    const res = quotationId ? await callAction(updateQuotationAction, quotationId, version!, payload) : await callAction(createQuotationAction, payload);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    toast.success(quotationId ? "Quotation saved." : "Quotation created as draft — submit it for approval when ready.");
    router.push(`/quotations/${res.data!.id}`);
  }

  return (
    <form className="space-y-4 pb-24" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      <FormSection title="Quotation" description="Who it is for and how long it is valid.">
        <Field id="qt-project" label="Project" required error={errors.projectId}>
          {(lockProject || quotationId) && project ? (
            <p className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">{project.code} – {project.name}</p>
          ) : (
            <SingleSelect id="qt-project" options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))} value={v.projectId} onChange={(x) => set({ projectId: x })} allowClear={false} placeholder="Select project" invalid={!!errors.projectId} />
          )}
        </Field>
        <Field id="qt-party" label="Client" required error={errors.partyId} help={client ? `Tax: ${mode === "INTRA" ? "CGST + SGST (same state)" : "IGST (inter-state)"}` : undefined}>
          <SingleSelect id="qt-party" options={clients.map((c) => ({ value: c.id, label: c.name, hint: c.gstin ?? "Unregistered", disabled: c.status !== "ACTIVE" }))} value={v.partyId} onChange={(x) => set({ partyId: x })} allowClear={false} placeholder="Search client…" invalid={!!errors.partyId} />
          <Link href="/parties/new?type=client" className="mt-1 inline-block text-xs text-primary hover:underline">+ New client</Link>
        </Field>
        <Field id="qt-subject" label="Subject" error={errors.subject} className="sm:col-span-2">
          <Input id="qt-subject" placeholder="e.g. Supply & installation of filtration plant" value={v.subject} onChange={(e) => set({ subject: e.target.value })} />
        </Field>
        <Field id="qt-date" label="Quotation date" required error={errors.quoteDate}>
          <Input id="qt-date" type="date" value={v.quoteDate} onChange={(e) => set({ quoteDate: e.target.value })} />
        </Field>
        <Field id="qt-valid" label="Valid until" error={errors.validUntil} help="After this date the client link can no longer be accepted.">
          <Input id="qt-valid" type="date" value={v.validUntil} onChange={(e) => set({ validUntil: e.target.value })} />
        </Field>
      </FormSection>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Items & services</h2>
          <p className="text-xs text-muted-foreground">Pick a catalogue item (fills brand, unit, HSN and GST) or type a service. Totals are a preview — the server recalculates them.</p>
        </div>
        <div className="space-y-2">
          {v.lines.map((l, i) => {
            const amt = safeAmounts(l, mode);
            const err = (f: string) => errors[`lines.${i}.${f}`];
            return (
              <div key={l.key} className="rounded-xl border bg-card p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 w-5 text-xs text-muted-foreground">{i + 1}</span>
                  <div className="grid flex-1 gap-2 md:grid-cols-12">
                    <div className="md:col-span-5">
                      <SingleSelect
                        options={comboOptions}
                        value={l.itemBrandId ?? null}
                        placeholder="Catalogue item (optional)"
                        searchPlaceholder="Search item, code or brand…"
                        onChange={(x) => {
                          const o = x ? optMap.get(x) : undefined;
                          setLine(i, { itemBrandId: x, description: o ? o.itemName : l.description, brand: o ? o.brandName : l.brand, unit: o?.unit ?? l.unit, hsnSac: o?.hsnCode ?? l.hsnSac, gstRate: o?.gstRate ? String(Number(o.gstRate)) : l.gstRate })
                        }}
                      />
                      <Input aria-label={`Line ${i + 1} description`} className="mt-1" placeholder="Description / specification" value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value })} aria-invalid={!!err("description")} />
                      {err("description") && <p className="mt-1 text-xs text-destructive">{err("description")}</p>}
                    </div>
                    <Input aria-label={`Line ${i + 1} brand`} className="md:col-span-2" placeholder="Brand" value={l.brand ?? ""} onChange={(e) => setLine(i, { brand: e.target.value })} />
                    <Input aria-label={`Line ${i + 1} HSN/SAC`} className="md:col-span-2" placeholder="HSN/SAC" value={l.hsnSac ?? ""} onChange={(e) => setLine(i, { hsnSac: e.target.value })} />
                    <Input aria-label={`Line ${i + 1} unit`} className="md:col-span-1" placeholder="Unit" value={l.unit ?? ""} onChange={(e) => setLine(i, { unit: e.target.value })} aria-invalid={!!err("unit")} />
                    <div className="hidden md:col-span-2 md:block" />
                    <div className="grid grid-cols-2 gap-2 md:col-span-12 md:grid-cols-5">
                      <label className="text-xs text-muted-foreground">
                        Qty
                        <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className="text-right" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-invalid={!!err("quantity")} />
                      </label>
                      <label className="text-xs text-muted-foreground">
                        Rate ₹
                        <Input aria-label={`Line ${i + 1} rate`} inputMode="decimal" className="text-right" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} aria-invalid={!!err("rate")} />
                      </label>
                      <label className="text-xs text-muted-foreground">
                        Disc %
                        <Input aria-label={`Line ${i + 1} discount`} inputMode="decimal" className="text-right" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} />
                      </label>
                      <label className="text-xs text-muted-foreground">
                        GST
                        <select aria-label={`Line ${i + 1} GST`} className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground" value={l.gstRate} onChange={(e) => setLine(i, { gstRate: e.target.value })}>
                          {[...new Set([...GST, l.gstRate])].map((g) => (
                            <option key={g} value={g}>
                              {g}%
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="text-right text-xs text-muted-foreground">
                        Amount
                        <p className="mt-2 text-sm font-semibold text-foreground tabular-nums">{amt ? formatINR(amt.total) : "—"}</p>
                      </div>
                    </div>
                  </div>
                  <Button type="button" size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={v.lines.length === 1} onClick={() => set({ lines: v.lines.filter((_, j) => j !== i) })}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => set({ lines: [...v.lines, blankQuoteLine()] })}>
            <Plus /> Add line
          </Button>
          <TotalsPanel totals={totals} mode={mode} className="w-full sm:w-80" />
        </div>
        {errors.lines && <p className="text-sm text-destructive">{errors.lines}</p>}
      </section>

      <section className="space-y-2 rounded-xl border bg-card p-4">
        <div>
          <h2 className="text-sm font-semibold">Payment terms</h2>
          <p className="text-xs text-muted-foreground">Default 50% advance · 40% on delivery · 10% on installation — edit percentages, descriptions and events, add or remove milestones, or apply a template.</p>
        </div>
        <MilestoneBuilder total={totals?.total ?? "0"} value={v.milestones} onChange={(m) => set({ milestones: m })} savedTemplates={savedTemplates} canSaveTemplate={canSaveTemplate} error={errors.milestones} />
        <Field id="qt-pt" label="Additional payment terms (optional)" error={errors.paymentTermsText}>
          <Textarea id="qt-pt" rows={2} placeholder="e.g. Payments by RTGS; interest @18% p.a. on delayed payment." value={v.paymentTermsText} onChange={(e) => set({ paymentTermsText: e.target.value })} />
        </Field>
      </section>

      <FormSection title="Terms" description="Printed on the quotation. One clause per line prints as a numbered list.">
        <Field id="qt-del" label="Delivery terms" error={errors.deliveryTerms} className="sm:col-span-2">
          <Textarea id="qt-del" rows={2} value={v.deliveryTerms} onChange={(e) => set({ deliveryTerms: e.target.value })} />
        </Field>
        <Field id="qt-terms" label="Terms & conditions" error={errors.terms} className="sm:col-span-2">
          <Textarea id="qt-terms" rows={5} value={v.terms} onChange={(e) => set({ terms: e.target.value })} />
        </Field>
        <Field id="qt-notes" label="Internal notes (not printed)" error={errors.notes} className="sm:col-span-2">
          <Textarea id="qt-notes" rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </FormSection>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 py-3 backdrop-blur md:left-[var(--sidebar-width,0px)]">
        <div className="mx-auto flex max-w-6xl items-center justify-end gap-3">
          <span className="mr-auto text-sm text-muted-foreground">
            Total <span className="font-semibold text-foreground">{formatINR(totals?.total ?? "0")}</span>
          </span>
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} {quotationId ? "Save quotation" : "Create quotation"}
          </Button>
        </div>
      </div>
    </form>
  );
}
