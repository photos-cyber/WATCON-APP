"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { LinesEditor, TotalsPanel, emptyLine, safeTotals, type EditableLine, type ItemBrandOpt } from "@/components/commercial/lines-editor";
import { SingleSelect } from "@/components/forms/combobox";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { taxModeFor } from "@/lib/money";
import { createPoAction, updatePoAction } from "@/modules/procurement/actions";

export type PartyOpt = { id: string; code: string; name: string; gstin: string | null; stateCode: string | null; paymentTermsDays: number | null; status: string };
export type ProjectOpt = { id: string; code: string; name: string };
export type LocOpt = { id: string; name: string; type: string; projectId: string | null; status: string };

export type PoFormValues = {
  projectId: string | null;
  partyId: string | null;
  deliveryLocationId: string | null;
  deliveryAddress: string;
  orderDate: string;
  expectedDate: string;
  paymentTerms: string;
  advanceAmount: string;
  terms: string;
  internalRemarks: string;
  charges: string;
  chargesGstRate: string;
  roundToRupee: boolean;
  rfqId: string | null;
  prId: string | null;
  lines: EditableLine[];
};

export function PoForm({ initial, poId, version, amendment, lockProject = false, suppliers, projects, locations, options, companyStateCode, defaultTerms }: { initial: PoFormValues; poId?: string; version?: number; amendment?: number; lockProject?: boolean; suppliers: PartyOpt[]; projects: ProjectOpt[]; locations: LocOpt[]; options: ItemBrandOpt[]; companyStateCode: string | null; defaultTerms: string | null }) {
  const router = useRouter();
  const siteOf = (pid: string | null) => locations.find((l) => l.type === "SITE" && l.status === "ACTIVE" && l.projectId === pid)?.id ?? null;
  const [v, setV] = useState<PoFormValues>({ ...initial, deliveryLocationId: initial.deliveryLocationId ?? siteOf(initial.projectId), terms: initial.terms || defaultTerms || "", lines: initial.lines.length ? initial.lines : [emptyLine()] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (patch: Partial<PoFormValues>) => {
    setDirty(true);
    setV((s) => ({ ...s, ...patch }));
  };
  const supplier = suppliers.find((s) => s.id === v.partyId);
  const mode = taxModeFor(companyStateCode, supplier?.stateCode);
  const totals = useMemo(() => safeTotals(v.lines, mode, { charges: v.charges, chargesGstRate: v.chargesGstRate, roundToRupee: v.roundToRupee }), [v.lines, mode, v.charges, v.chargesGstRate, v.roundToRupee]);
  const locs = locations.filter((l) => l.status === "ACTIVE" && (l.type === "WAREHOUSE" || (l.type === "SITE" && l.projectId === v.projectId)));

  async function save(finalize = false) {
    setBusy(true);
    const payload = {
      ...v,
      lines: v.lines.map((l) => ({ id: l.id ?? null, itemBrandId: l.itemBrandId, description: l.description, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, prLineId: l.links?.prLineId ?? null, quotationLineId: l.links?.quotationLineId ?? null })),
    };
    const res = poId ? await callAction(updatePoAction, poId, version!, payload, { finalize }) : await callAction(createPoAction, payload, { finalize });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    if (finalize && res.data.finalizeError) toast.warning(`Saved as draft, but not finalized: ${res.data.finalizeError}`);
    else toast.success(res.data.finalized ? "Purchase order finalized — share it with the supplier." : poId ? "Purchase order saved." : "Purchase order saved as draft.");
    router.push(`/purchase-orders/${res.data.id}`);
  }

  return (
    <form
      className="space-y-4 pb-24"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {amendment ? <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Amendment {amendment}: received and billed quantities are protected — a line cannot go below them. Finalize the amended order again when done.</p> : null}
      <FormSection title="Project & supplier" description="Delivery defaults to the project's site store. Leave the project empty for general stock or a combined order (delivered to the main warehouse).">
        <Field id="po-project" label="Project" error={errors.projectId}>
          {(lockProject || amendment) && projects.find((p) => p.id === v.projectId) ? (
            <p className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">
              {projects.find((p) => p.id === v.projectId)!.code} – {projects.find((p) => p.id === v.projectId)!.name}
            </p>
          ) : (
            <SingleSelect id="po-project" options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))} value={v.projectId} onChange={(x) => set({ projectId: x, deliveryLocationId: siteOf(x) })} placeholder="General stock (no project)" invalid={!!errors.projectId} />
          )}
        </Field>
        <Field id="po-party" label="Supplier" required error={errors.partyId} help={supplier ? `Tax: ${mode === "INTRA" ? "CGST + SGST (same state)" : "IGST (inter-state)"}` : undefined}>
          <SingleSelect id="po-party" options={suppliers.map((s) => ({ value: s.id, label: s.name, hint: s.gstin ?? "Unregistered", disabled: s.status !== "ACTIVE" }))} value={v.partyId} onChange={(x) => set({ partyId: x })} allowClear={false} disabled={!!amendment} placeholder="Select supplier" invalid={!!errors.partyId} />
          <Link href="/parties/new?type=supplier&returnTo=/purchase-orders/new" className="mt-1 inline-block text-xs text-primary hover:underline">
            + New supplier
          </Link>
        </Field>
        <Field id="po-loc" label="Deliver to" error={errors.deliveryLocationId} help="Site deliveries are received into the site store, not the warehouse.">
          <SingleSelect id="po-loc" options={locs.map((l) => ({ value: l.id, label: l.name, hint: l.type === "SITE" ? "Site store" : "Warehouse" }))} value={v.deliveryLocationId} onChange={(x) => set({ deliveryLocationId: x })} placeholder={v.projectId ? "Project site store" : "Select the project first"} />
        </Field>
        <Field id="po-addr" label="Delivery address / instructions" error={errors.deliveryAddress}>
          <Input id="po-addr" value={v.deliveryAddress} onChange={(e) => set({ deliveryAddress: e.target.value })} />
        </Field>
        <Field id="po-date" label="Order date" required error={errors.orderDate}>
          <Input id="po-date" type="date" value={v.orderDate} onChange={(e) => set({ orderDate: e.target.value })} />
        </Field>
        <Field id="po-exp" label="Expected delivery" error={errors.expectedDate}>
          <Input id="po-exp" type="date" value={v.expectedDate} onChange={(e) => set({ expectedDate: e.target.value })} />
        </Field>
      </FormSection>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Items</h2>
        <LinesEditor lines={v.lines} onChange={(lines) => set({ lines })} options={options} mode={mode} errors={errors} lockItems={!!amendment} />
      </section>

      <FormSection title="Charges & terms">
        <Field id="po-chg" label="Freight / other charges (₹)" error={errors.charges}>
          <Input id="po-chg" inputMode="decimal" value={v.charges} onChange={(e) => set({ charges: e.target.value })} />
        </Field>
        <Field id="po-chg-gst" label="GST on charges %" error={errors.chargesGstRate}>
          <Input id="po-chg-gst" inputMode="decimal" value={v.chargesGstRate} onChange={(e) => set({ chargesGstRate: e.target.value })} />
        </Field>
        <Field id="po-pay" label="Payment terms" error={errors.paymentTerms} help={supplier?.paymentTermsDays != null ? `Supplier default: ${supplier.paymentTermsDays} days` : undefined}>
          <Input id="po-pay" value={v.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} />
        </Field>
        <Field id="po-adv" label="Advance payable (₹)" error={errors.advanceAmount}>
          <Input id="po-adv" inputMode="decimal" value={v.advanceAmount} onChange={(e) => set({ advanceAmount: e.target.value })} />
        </Field>
        <details className="sm:col-span-2" open={!!(errors.terms || errors.internalRemarks)}>
          <summary className="cursor-pointer text-sm text-primary">Terms & conditions, internal remarks, rounding</summary>
          <div className="mt-3 grid gap-4">
        <Field id="po-terms" label="Terms & conditions (printed)" error={errors.terms} className="sm:col-span-2">
          <Textarea id="po-terms" rows={4} value={v.terms} onChange={(e) => set({ terms: e.target.value })} />
        </Field>
        <Field id="po-int" label="Internal remarks (not printed)" error={errors.internalRemarks} className="sm:col-span-2">
          <Textarea id="po-int" rows={2} value={v.internalRemarks} onChange={(e) => set({ internalRemarks: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={v.roundToRupee} onCheckedChange={(x) => set({ roundToRupee: x === true })} /> Round total to the nearest rupee
        </label>
          </div>
        </details>
      </FormSection>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-end sm:justify-between sm:rounded-xl sm:border">
        <TotalsPanel totals={totals} mode={mode} className="w-full sm:w-72" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Cancel
          </Button>
          <Button type="submit" variant="outline" disabled={busy}>
            Save draft
          </Button>
          <Button type="button" disabled={busy} onClick={() => save(true)} title="Saves and finalizes the PO in one step — then share it with the supplier.">
            {busy && <Loader2 className="animate-spin" />}
            Save &amp; finalize PO
          </Button>
        </div>
      </div>
    </form>
  );
}
