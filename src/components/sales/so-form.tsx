"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { TotalsPanel, safeAmounts, safeTotals, type EditableLine, type ItemBrandOpt } from "@/components/commercial/lines-editor";
import { SingleSelect } from "@/components/forms/combobox";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { formatQty } from "@/lib/format";
import { formatINR, taxModeFor } from "@/lib/money";
import { cn, newId } from "@/lib/utils";
import { MilestoneBuilder } from "@/components/commercial/milestone-builder";
import { Checkbox } from "@/components/ui/checkbox";
import type { MilestoneInput } from "@/modules/commercial/payment-terms";
import { createSalesOrderAction, requestSoAmendmentAction, updateSalesOrderAction } from "@/modules/sales/actions";
import type { ClientOpt, ProjectOpt } from "./cpo-form";

export type SoLineKind = "MATERIAL" | "SERVICE" | "INSTALLATION";
export type SoLine = EditableLine & { clientPoLineId?: string | null; floor?: string; kind?: SoLineKind | null };
const KIND_LABEL: Record<SoLineKind, string> = { MATERIAL: "Material", SERVICE: "Service", INSTALLATION: "Installation" };
/** Material lines (with an item – brand) drive material planning; services / installation never do. */
const kindOf = (l: SoLine): SoLineKind => l.kind ?? (l.itemBrandId ? "MATERIAL" : "SERVICE");
export type CpoOpt = { id: string; label: string; hint: string; projectId: string; partyId: string };

export type SoFormValues = {
  projectId: string | null;
  partyId: string | null;
  clientPoId: string | null;
  orderDate: string;
  deliveryDate: string;
  deliveryAddress: string;
  deliverySchedule: string;
  billingSchedule: string;
  paymentTerms: string;
  notes: string;
  lines: SoLine[];
  /** Payment schedule (create only; edit it later from the order's billing panel). */
  milestones?: MilestoneInput[];
};

const GST = ["0", "0.25", "3", "5", "12", "18", "28"];
const blank = (): SoLine => ({ key: newId(), itemBrandId: null, description: "", unit: "", quantity: "", rate: "", discountPct: "0", gstRate: "18" });
const n = (s: string | undefined | null) => (s === undefined || s === null || s === "" ? "" : String(Number(s)));

/**
 * Sales-order editor. mode "create" / "edit" for drafts; mode "amend" edits a copy of an approved
 * order and submits it as an amendment request (with a required reason and a change preview).
 */
export function SoForm({ mode, initial, soId, version, projects, clients, clientPos, options, companyStateCode, lockProject, original }: { mode: "create" | "edit" | "amend"; initial: SoFormValues; soId?: string; version?: number; projects: ProjectOpt[]; clients: ClientOpt[]; clientPos: CpoOpt[]; options: ItemBrandOpt[]; companyStateCode: string | null; lockProject?: boolean; original?: SoLine[] }) {
  const router = useRouter();
  const [v, setV] = useState<SoFormValues>({ ...initial, lines: initial.lines.length ? initial.lines : [blank()] });
  const [reason, setReason] = useState("");
  const [useSchedule, setUseSchedule] = useState((initial.milestones?.length ?? 0) > 0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (p: Partial<SoFormValues>) => {
    setDirty(true);
    setV((s) => ({ ...s, ...p }));
  };
  const setLine = (i: number, p: Partial<SoLine>) => set({ lines: v.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const client = clients.find((c) => c.id === v.partyId);
  const taxMode = taxModeFor(companyStateCode, client?.stateCode);
  const totals = useMemo(() => safeTotals(v.lines, taxMode), [v.lines, taxMode]);
  const optMap = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const project = projects.find((p) => p.id === v.projectId);
  const amend = mode === "amend";
  const headerLocked = amend;
  const cpoChoices = clientPos.filter((c) => (!v.projectId || c.projectId === v.projectId) && (!v.partyId || c.partyId === v.partyId));
  const origMap = new Map((original ?? []).map((l) => [l.id, l]));
  const diff = amend ? computeDiff(original ?? [], v.lines, optMap) : [];

  async function save(confirm = false) {
    setBusy(true);
    const lines = v.lines.map((l) => ({ id: l.id ?? null, clientPoLineId: l.clientPoLineId ?? null, itemBrandId: kindOf(l) === "MATERIAL" ? l.itemBrandId || null : null, kind: kindOf(l), description: l.description || null, hsnSac: l.hsnSac || null, unit: l.unit || null, quantity: l.quantity, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate }));
    const header = { deliveryDate: v.deliveryDate, deliveryAddress: v.deliveryAddress, deliverySchedule: v.deliverySchedule, billingSchedule: v.billingSchedule, paymentTerms: v.paymentTerms, notes: v.notes, lines };
    const base = { ...v, milestones: undefined };
    const schedule = initial.milestones !== undefined ? (useSchedule ? (v.milestones ?? []) : []) : undefined;
    const res = amend ? await callAction(requestSoAmendmentAction, soId!, { reason, ...header }) : soId ? await callAction(updateSalesOrderAction, soId, version!, { ...base, ...header }, { confirm }) : await callAction(createSalesOrderAction, { ...base, ...header, milestones: schedule }, { confirm });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    const d = res.data as { confirmed?: boolean; confirmError?: string | null } | undefined;
    if (confirm && d?.confirmError) toast.warning(`Saved as draft, but not confirmed: ${d.confirmError}`);
    else toast.success(amend ? "Amendment request sent to Super Admin for approval." : d?.confirmed ? "Sales order confirmed — material planning updated." : soId ? "Sales order saved." : "Sales order saved as draft — confirm the order when ready.");
    router.push(`/sales-orders/${amend ? soId : res.data!.id}${amend ? "#amendments" : ""}`);
  }

  return (
    <form className="space-y-4 pb-24" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      {amend && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This order is approved and locked. Edit the copy below and give a reason — a Super Admin must approve the request before anything changes. Lines already delivered or invoiced cannot go below those quantities.
        </div>
      )}
      <FormSection title="Order" description={amend ? "Project, client and contract cannot change in an amendment." : "Pick the project and client. Linking the client's PO is optional — when linked, quantities stay within the contract."}>
        <Field id="so-project" label="Project" required error={errors.projectId}>
          {(lockProject || headerLocked || mode === "edit") && project ? (
            <p className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">{project.code} – {project.name}</p>
          ) : (
            <SingleSelect id="so-project" options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))} value={v.projectId} onChange={(x) => set({ projectId: x, clientPoId: null })} allowClear={false} placeholder="Select project" invalid={!!errors.projectId} />
          )}
        </Field>
        <Field id="so-party" label="Client" required error={errors.partyId} help={client ? `Tax: ${taxMode === "INTRA" ? "CGST + SGST (same state)" : "IGST (inter-state)"}` : undefined}>
          <SingleSelect id="so-party" options={clients.map((c) => ({ value: c.id, label: c.name, hint: c.gstin ?? "Unregistered", disabled: c.status !== "ACTIVE" }))} value={v.partyId} onChange={(x) => set({ partyId: x, clientPoId: null })} allowClear={false} disabled={headerLocked} placeholder="Select client" invalid={!!errors.partyId} />
          {!headerLocked && <Link href="/parties/new?type=client" className="mt-1 inline-block text-xs text-primary hover:underline">+ New client</Link>}
        </Field>
        <Field id="so-cpo" label="Client PO (optional)" error={errors.clientPoId} help={v.clientPoId && !initial.clientPoId ? "Tip: open the client PO and use “Sales order” to copy all its open lines." : undefined}>
          <SingleSelect id="so-cpo" options={cpoChoices.map((c) => ({ value: c.id, label: c.label, hint: c.hint }))} value={v.clientPoId} onChange={(x) => set({ clientPoId: x })} disabled={headerLocked} placeholder={cpoChoices.length ? "Not linked" : "No active client PO"} />
        </Field>
        <Field id="so-date" label="Order date" required error={errors.orderDate}>
          <Input id="so-date" type="date" value={v.orderDate} disabled={headerLocked} onChange={(e) => set({ orderDate: e.target.value })} />
        </Field>
        <Field id="so-del" label="Deliver by" error={errors.deliveryDate} help="Becomes the 'required by' date for material planning.">
          <Input id="so-del" type="date" value={v.deliveryDate} onChange={(e) => set({ deliveryDate: e.target.value })} />
        </Field>
        <Field id="so-addr" label="Delivery address" error={errors.deliveryAddress}>
          <Input id="so-addr" value={v.deliveryAddress} onChange={(e) => set({ deliveryAddress: e.target.value })} />
        </Field>
      </FormSection>

      <section className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">What is being sold</h2>
          <p className="text-xs text-muted-foreground">Material lines need an item – brand: when the order is approved they become material requirements automatically (no re-entry). Service and installation lines are billed but never planned or purchased.</p>
        </div>
        <div className="space-y-2 md:hidden">
          {v.lines.map((l, i) => <MobileLine key={l.key} l={l} i={i} setLine={setLine} options={options} optMap={optMap} errors={errors} orig={l.id ? origMap.get(l.id) : undefined} amend={amend} onRemove={() => set({ lines: v.lines.filter((_, j) => j !== i) })} canRemove={v.lines.length > 1 && !(l.floor && Number(l.floor) > 0)} taxMode={taxMode} />)}
        </div>
        <div className="hidden overflow-x-auto rounded-xl border bg-card md:block">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2 text-left font-medium">#</th>
                <th className="px-2 py-2 text-left font-medium">Item – brand or description</th>
                <th className="w-20 px-2 py-2 text-left font-medium">Unit</th>
                <th className="w-28 px-2 py-2 text-right font-medium">Qty</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Rate ₹</th>
                <th className="w-20 px-2 py-2 text-right font-medium">Disc %</th>
                <th className="w-24 px-2 py-2 text-right font-medium">GST %</th>
                <th className="w-32 px-2 py-2 text-right font-medium">Amount</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {v.lines.map((l, i) => {
                const o = l.id ? origMap.get(l.id) : undefined;
                const changed = (k: keyof SoLine) => amend && (!o || n(o[k] as string) !== n(l[k] as string));
                const amt = safeAmounts(l, taxMode);
                const err = (f: string) => errors[`lines.${i}.${f}`];
                return (
                  <tr key={l.key} className={cn("align-top", amend && !o && "bg-emerald-50/60")}>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-2">
                      <div className="flex gap-1">
                        <KindSelect l={l} i={i} setLine={setLine} />
                        <div className="min-w-0 flex-1">
                          <SingleSelect options={options.map((x) => ({ value: x.id, label: `${x.itemName} — ${x.brandName}`, hint: `${x.itemCode} · stock ${formatQty(x.currentQty)} ${x.unit}` }))} value={kindOf(l) === "MATERIAL" ? (l.itemBrandId ?? null) : null} disabled={!!(l.floor && Number(l.floor) > 0) || kindOf(l) !== "MATERIAL"} placeholder={kindOf(l) === "MATERIAL" ? "Pick the material" : "No stock item (service)"} searchPlaceholder="Search item, code or brand…" onChange={(x) => { const ob = x ? optMap.get(x) : undefined; setLine(i, { itemBrandId: x, kind: x ? "MATERIAL" : l.kind, unit: ob?.unit ?? l.unit, hsnSac: ob?.hsnCode ?? l.hsnSac, gstRate: ob?.gstRate ? n(ob.gstRate) : l.gstRate, description: l.description || (ob ? `${ob.itemName} – ${ob.brandName}` : "") }); }} />
                        </div>
                      </div>
                      <Input aria-label={`Line ${i + 1} description`} className="mt-1 h-8 text-xs" placeholder="Description (required for services)" value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value })} aria-invalid={!!err("description")} />
                      {(err("description") || err("itemBrandId")) && <p className="mt-1 text-xs text-destructive">{err("description") ?? err("itemBrandId")}</p>}
                      {l.note && <p className="mt-1 text-xs text-muted-foreground">{l.note}</p>}
                    </td>
                    <td className="px-2 py-2"><Input aria-label={`Line ${i + 1} unit`} value={l.unit ?? ""} onChange={(e) => setLine(i, { unit: e.target.value })} aria-invalid={!!err("unit")} /></td>
                    <td className="px-2 py-2">
                      <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className={cn("text-right", changed("quantity") && "border-amber-400 bg-amber-50")} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-invalid={!!err("quantity")} />
                      {amend && o && changed("quantity") && <p className="mt-1 text-right text-[11px] text-muted-foreground">was {formatQty(o.quantity)}</p>}
                      {err("quantity") && <p className="mt-1 text-right text-xs text-destructive">{err("quantity")}</p>}
                    </td>
                    <td className="px-2 py-2">
                      <Input aria-label={`Line ${i + 1} rate`} inputMode="decimal" className={cn("text-right", changed("rate") && "border-amber-400 bg-amber-50")} value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} aria-invalid={!!err("rate")} />
                      {amend && o && changed("rate") && <p className="mt-1 text-right text-[11px] text-muted-foreground">was ₹{n(o.rate)}</p>}
                    </td>
                    <td className="px-2 py-2"><Input aria-label={`Line ${i + 1} discount`} inputMode="decimal" className="text-right" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} /></td>
                    <td className="px-2 py-2">
                      <select aria-label={`Line ${i + 1} GST`} className="h-9 w-full rounded-md border bg-card px-2 text-right text-sm" value={n(l.gstRate) || "0"} onChange={(e) => setLine(i, { gstRate: e.target.value })}>
                        {GST.map((g) => <option key={g} value={g}>{g}%</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{amt ? formatINR(amt.total) : "—"}</td>
                    <td className="px-1 py-2">
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={v.lines.length <= 1 || !!(l.floor && Number(l.floor) > 0)} onClick={() => set({ lines: v.lines.filter((_, j) => j !== i) })}><Trash2 /></Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {errors.lines && <p className="text-xs text-destructive">{errors.lines}</p>}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Button type="button" size="sm" variant="outline" onClick={() => set({ lines: [...v.lines, blank()] })}><Plus /> Add line</Button>
          <TotalsPanel totals={totals} mode={taxMode} className="w-full max-w-xs rounded-xl border bg-card p-3" />
        </div>
      </section>

      {mode === "create" && initial.milestones !== undefined && (
        <section className="space-y-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Payment milestones</h2>
              <p className="text-xs text-muted-foreground">Default 50% advance · 40% on delivery · 10% on installation — edit freely. Untick to invoice by delivered quantity instead.</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={useSchedule} onCheckedChange={(c) => { setDirty(true); setUseSchedule(c === true); }} /> Bill by payment schedule
            </label>
          </div>
          {useSchedule && <MilestoneBuilder total={totals?.total ?? "0"} value={v.milestones ?? []} onChange={(m) => set({ milestones: m })} error={errors.milestones} />}
        </section>
      )}

      <FormSection title="Schedules & terms">
        <Field id="so-dsched" label="Delivery schedule" error={errors.deliverySchedule}><Textarea id="so-dsched" rows={2} value={v.deliverySchedule} onChange={(e) => set({ deliverySchedule: e.target.value })} placeholder="e.g. 50% by 15 Dec, balance by 31 Jan" /></Field>
        <Field id="so-bsched" label="Billing schedule" error={errors.billingSchedule}><Textarea id="so-bsched" rows={2} value={v.billingSchedule} onChange={(e) => set({ billingSchedule: e.target.value })} /></Field>
        <Field id="so-pay" label="Payment terms" error={errors.paymentTerms} help={client?.paymentTermsDays != null ? `Client default: ${client.paymentTermsDays} days` : undefined}><Input id="so-pay" value={v.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} /></Field>
        <Field id="so-notes" label="Notes" error={errors.notes}><Textarea id="so-notes" rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </FormSection>

      {amend && (
        <section className="space-y-3 rounded-xl border border-amber-200 bg-card p-4">
          <h2 className="text-sm font-semibold">Change preview</h2>
          {diff.length ? (
            <ul className="space-y-1 text-sm">
              {diff.map((d, i) => <li key={i} className={cn("rounded-md px-2 py-1", d.kind === "added" ? "bg-emerald-50 text-emerald-900" : d.kind === "removed" ? "bg-rose-50 text-rose-900" : "bg-amber-50 text-amber-900")}>{d.text}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No line changes yet.</p>
          )}
          <Field id="so-reason" label="Reason for the change" required error={errors.reason} help="The Super Admin sees this with the change preview.">
            <Textarea id="so-reason" rows={2} value={reason} onChange={(e) => { setDirty(true); setReason(e.target.value); }} placeholder="e.g. Client increased the cement quantity by email dated …" />
          </Field>
        </section>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        {totals && <span className="mr-auto text-sm text-muted-foreground">Total <span className="font-semibold text-foreground">{formatINR(totals.total)}</span></span>}
        <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
        <Button type={amend ? "submit" : "button"} variant={amend ? "default" : "outline"} disabled={busy || (amend && reason.trim().length < 5)} onClick={amend ? undefined : () => save(false)}>{amend ? "Send amendment request" : "Save draft"}</Button>
        {!amend && <Button type="button" disabled={busy} onClick={() => save(true)} title="Saves and confirms the order: it is locked and material planning starts.">Save &amp; confirm order</Button>}
      </div>
    </form>
  );
}

function MobileLine({ l, i, setLine, options, optMap, errors, orig, amend, onRemove, canRemove, taxMode }: { l: SoLine; i: number; setLine: (i: number, p: Partial<SoLine>) => void; options: ItemBrandOpt[]; optMap: Map<string, ItemBrandOpt>; errors: Record<string, string>; orig?: SoLine; amend: boolean; onRemove: () => void; canRemove: boolean; taxMode: "INTRA" | "INTER" }) {
  const amt = safeAmounts(l, taxMode);
  return (
    <div className={cn("space-y-2 rounded-xl border bg-card p-3", amend && !orig && "border-emerald-300")}>
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Line {i + 1}</span><Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={!canRemove} onClick={onRemove}><Trash2 /></Button></div>
      <KindSelect l={l} i={i} setLine={setLine} />
      <SingleSelect options={options.map((x) => ({ value: x.id, label: `${x.itemName} — ${x.brandName}`, hint: x.itemCode }))} value={kindOf(l) === "MATERIAL" ? (l.itemBrandId ?? null) : null} disabled={kindOf(l) !== "MATERIAL"} placeholder={kindOf(l) === "MATERIAL" ? "Pick the material" : "No stock item (service)"} onChange={(x) => { const ob = x ? optMap.get(x) : undefined; setLine(i, { itemBrandId: x, kind: x ? "MATERIAL" : l.kind, unit: ob?.unit ?? l.unit, description: l.description || (ob ? `${ob.itemName} – ${ob.brandName}` : "") }); }} />
      <Input aria-label={`Line ${i + 1} description`} placeholder="Description" value={l.description ?? ""} onChange={(e) => setLine(i, { description: e.target.value })} />
      <div className="grid grid-cols-3 gap-2">
        <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" placeholder="Qty" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
        <Input aria-label={`Line ${i + 1} unit`} placeholder="Unit" value={l.unit ?? ""} onChange={(e) => setLine(i, { unit: e.target.value })} />
        <Input aria-label={`Line ${i + 1} rate`} inputMode="decimal" placeholder="Rate ₹" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Disc %
          <Input aria-label={`Line ${i + 1} discount`} inputMode="decimal" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          GST %
          <select aria-label={`Line ${i + 1} GST`} className="h-9 w-full rounded-md border bg-card px-2 text-sm text-foreground" value={n(l.gstRate) || "0"} onChange={(e) => setLine(i, { gstRate: e.target.value })}>
            {GST.map((g) => <option key={g} value={g}>{g}%</option>)}
          </select>
        </label>
      </div>
      {orig && amend && (n(orig.quantity) !== n(l.quantity) || n(orig.rate) !== n(l.rate)) && <p className="text-xs text-amber-800">was {formatQty(orig.quantity)} @ ₹{n(orig.rate)}</p>}
      {l.note && <p className="text-xs text-muted-foreground">{l.note}</p>}
      {(errors[`lines.${i}.quantity`] || errors[`lines.${i}.description`]) && <p className="text-xs text-destructive">{errors[`lines.${i}.quantity`] ?? errors[`lines.${i}.description`]}</p>}
      <p className="text-right text-sm tabular-nums">{amt ? formatINR(amt.total) : "—"}</p>
    </div>
  );
}

function KindSelect({ l, i, setLine }: { l: SoLine; i: number; setLine: (i: number, p: Partial<SoLine>) => void }) {
  const locked = !!(l.floor && Number(l.floor) > 0);
  return (
    <select aria-label={`Line ${i + 1} type`} disabled={locked} className="h-9 shrink-0 rounded-md border bg-card px-2 text-sm" value={kindOf(l)} onChange={(e) => { const k = e.target.value as SoLineKind; setLine(i, k === "MATERIAL" ? { kind: k } : { kind: k, itemBrandId: null }); }}>
      {(Object.keys(KIND_LABEL) as SoLineKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
    </select>
  );
}

type Diff = { kind: "added" | "removed" | "changed"; text: string };

function label(l: { itemBrandId?: string | null; description?: string | null }, optMap: Map<string, ItemBrandOpt>) {
  const o = l.itemBrandId ? optMap.get(l.itemBrandId) : undefined;
  return l.description || (o ? `${o.itemName} – ${o.brandName}` : "Line");
}

export function computeDiff(before: { id?: string | null; itemBrandId?: string | null; description?: string | null; quantity: string; rate: string; gstRate: string; unit?: string | null }[], after: { id?: string | null; itemBrandId?: string | null; description?: string | null; quantity: string; rate: string; gstRate: string; unit?: string | null }[], optMap: Map<string, ItemBrandOpt> = new Map()): Diff[] {
  const out: Diff[] = [];
  const afterIds = new Set(after.map((l) => l.id).filter(Boolean));
  for (const b of before) if (b.id && !afterIds.has(b.id)) out.push({ kind: "removed", text: `Removed: ${label(b, optMap)} (${formatQty(b.quantity)} ${b.unit ?? ""})` });
  for (const a of after) {
    const b = a.id ? before.find((x) => x.id === a.id) : undefined;
    if (!b) {
      out.push({ kind: "added", text: `Added: ${label(a, optMap)} — ${formatQty(a.quantity || "0")} ${a.unit ?? ""} @ ₹${n(a.rate) || "0"}` });
      continue;
    }
    const parts: string[] = [];
    if (n(b.quantity) !== n(a.quantity)) parts.push(`qty ${formatQty(b.quantity)} → ${formatQty(a.quantity || "0")}`);
    if (n(b.rate) !== n(a.rate)) parts.push(`rate ₹${n(b.rate)} → ₹${n(a.rate) || "0"}`);
    if (n(b.gstRate) !== n(a.gstRate)) parts.push(`GST ${n(b.gstRate)}% → ${n(a.gstRate)}%`);
    if ((b.itemBrandId ?? null) !== (a.itemBrandId ?? null) || (b.description ?? "") !== (a.description ?? "")) parts.push(`item/description changed`);
    if (parts.length) out.push({ kind: "changed", text: `${label(a, optMap)}: ${parts.join(", ")}` });
  }
  return out;
}
