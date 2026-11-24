"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/call-action";
import { formatDate, formatQty } from "@/lib/format";
import { submitPortalQuoteAction } from "@/modules/procurement/portal-actions";

type Line = { id: string; name: string; unit: string; quantity: string; requestedBrand: string | null; requestedBrandId: string | null; acceptableBrands: string | null; specifications: string | null; brands: { id: string; name: string }[] };
type CurrentLine = { rfqLineId: string | null; itemBrandId: string; quantity: string; rate: string; discountPct: string; gstRate: string; leadTimeDays: string; remarks: string; paymentTerms: string };
type Current = { number: string; revision: number; submittedAt: string; supplierRef: string; validUntil: string; deliveryDays: string; freight: string; freightGstRate: string; paymentTerms: string; advancePct: string; creditDays: string; warranty: string; remarks: string; lines: CurrentLine[] };
type Entry = { enabled: boolean; itemBrandId: string; quantity: string; rate: string; discountPct: string; gstRate: string; leadTimeDays: string; remarks: string; paymentTerms: string };

const GST = ["0", "5", "12", "18", "28"];
const label = "mb-1 block text-xs font-medium text-muted-foreground";
const select = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function PortalQuoteForm({ token, lines, current }: { token: string; lines: Line[]; current: Current | null }) {
  const router = useRouter();
  const [head, setHead] = useState({
    supplierRef: current?.supplierRef ?? "",
    validUntil: current?.validUntil ?? "",
    deliveryDays: current?.deliveryDays ?? "",
    freight: current?.freight ?? "0",
    freightGstRate: current?.freightGstRate ?? "18",
    paymentTerms: current?.paymentTerms ?? "",
    advancePct: current?.advancePct ?? "",
    creditDays: current?.creditDays ?? "",
    warranty: current?.warranty ?? "",
    remarks: current?.remarks ?? "",
  });
  const [entries, setEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(
      lines.map((l) => {
        const prev = current?.lines.find((c) => c.rfqLineId === l.id);
        const brand = prev?.itemBrandId ?? l.requestedBrandId ?? (l.brands.length === 1 ? l.brands[0]!.id : "");
        return [l.id, prev ? { enabled: true, ...prev, itemBrandId: brand } : { enabled: !current, itemBrandId: brand, quantity: l.quantity, rate: "", discountPct: "0", gstRate: "18", leadTimeDays: "", remarks: "", paymentTerms: "" }];
      }),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const chosen = lines.filter((l) => entries[l.id]?.enabled);
    if (!chosen.length) return toast.error("Tick at least one item you can supply.");
    setBusy(true);
    const res = await callAction(submitPortalQuoteAction, token, { ...head, lines: chosen.map((l) => ({ ...entries[l.id], rfqLineId: l.id })) });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setDone(`${res.data.number}${res.data.revision > 1 ? ` (revision ${res.data.revision})` : ""}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
    router.refresh();
  }

  if (done) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
        <h2 className="mt-2 text-lg font-semibold">Thank you — your quotation was received</h2>
        <p className="mt-1 text-sm text-muted-foreground">Reference {done}. You can open this link again to revise it until the order is awarded.</p>
        <Button className="mt-4" variant="outline" onClick={() => setDone(null)}>
          Revise my quotation
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {current && (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          You already sent quotation {current.number}
          {current.revision > 1 ? ` (revision ${current.revision})` : ""} on {formatDate(current.submittedAt.slice(0, 10))}. Submitting again replaces it with a revised quotation.
        </p>
      )}

      <div className="space-y-3">
        <h2 className="font-semibold">Your rates</h2>
        {lines.map((l) => {
          const x = entries[l.id]!;
          const update = (p: Partial<Entry>) => setEntries((s) => ({ ...s, [l.id]: { ...s[l.id]!, ...p } }));
          return (
            <div key={l.id} className="rounded-xl border bg-card p-4">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 size-4" checked={x.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
                <span>
                  <span className="font-medium">{l.name}</span>
                  <span className="block text-sm text-muted-foreground">
                    Qty {formatQty(l.quantity)} {l.unit}
                    {l.requestedBrand ? ` · brand: ${l.requestedBrand}` : " · any brand"}
                    {l.acceptableBrands ? ` · also OK: ${l.acceptableBrands}` : ""}
                  </span>
                  {l.specifications && <span className="block text-xs text-muted-foreground">{l.specifications}</span>}
                </span>
              </label>
              {x.enabled ? (
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-6">
                  <label className="col-span-2 block">
                    <span className={label}>Brand you offer *</span>
                    <select required className={select} value={x.itemBrandId} onChange={(e) => update({ itemBrandId: e.target.value })}>
                      <option value="">Select brand</option>
                      {l.brands.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={label}>Qty</span>
                    <Input inputMode="decimal" value={x.quantity} onChange={(e) => update({ quantity: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className={label}>Rate ₹ / {l.unit} *</span>
                    <Input inputMode="decimal" required placeholder="before GST" value={x.rate} onChange={(e) => update({ rate: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className={label}>Discount %</span>
                    <Input inputMode="decimal" value={x.discountPct} onChange={(e) => update({ discountPct: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className={label}>GST</span>
                    <select className={select} value={x.gstRate} onChange={(e) => update({ gstRate: e.target.value })}>
                      {[...new Set([...GST, x.gstRate])].map((g) => (
                        <option key={g} value={g}>
                          {g}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="col-span-2 block sm:col-span-2">
                    <span className={label}>Delivery (days)</span>
                    <Input inputMode="numeric" value={x.leadTimeDays} onChange={(e) => update({ leadTimeDays: e.target.value })} />
                  </label>
                  <label className="col-span-2 block sm:col-span-6">
                    <span className={label}>Payment terms for this item (only if different)</span>
                    <Input value={x.paymentTerms} onChange={(e) => update({ paymentTerms: e.target.value })} />
                  </label>
                  <label className="col-span-2 block sm:col-span-4">
                    <span className={label}>Notes (make, model, other brand…)</span>
                    <Input value={x.remarks} onChange={(e) => update({ remarks: e.target.value })} />
                  </label>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Not quoting for this item.</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 font-semibold">Terms</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className={label}>Your quotation no.</span>
            <Input value={head.supplierRef} onChange={(e) => setHead({ ...head, supplierRef: e.target.value })} />
          </label>
          <label className="block">
            <span className={label}>Valid until</span>
            <Input type="date" value={head.validUntil} onChange={(e) => setHead({ ...head, validUntil: e.target.value })} />
          </label>
          <label className="block">
            <span className={label}>Delivery in (days)</span>
            <Input inputMode="numeric" value={head.deliveryDays} onChange={(e) => setHead({ ...head, deliveryDays: e.target.value })} />
          </label>
          <label className="block">
            <span className={label}>Freight / transport ₹ (total)</span>
            <Input inputMode="decimal" value={head.freight} onChange={(e) => setHead({ ...head, freight: e.target.value })} />
          </label>
          <label className="block">
            <span className={label}>GST on freight</span>
            <select className={select} value={head.freightGstRate} onChange={(e) => setHead({ ...head, freightGstRate: e.target.value })}>
              {GST.map((g) => (
                <option key={g} value={g}>
                  {g}%
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Advance %</span>
            <Input inputMode="decimal" placeholder="e.g. 30" value={head.advancePct} onChange={(e) => setHead({ ...head, advancePct: e.target.value })} />
          </label>
          <label className="block">
            <span className={label}>Credit days</span>
            <Input inputMode="numeric" placeholder="e.g. 30" value={head.creditDays} onChange={(e) => setHead({ ...head, creditDays: e.target.value })} />
          </label>
          <label className="block">
            <span className={label}>Warranty</span>
            <Input placeholder="e.g. 12 months" value={head.warranty} onChange={(e) => setHead({ ...head, warranty: e.target.value })} />
          </label>
          <label className="block sm:col-span-2 lg:col-span-3">
            <span className={label}>Other payment terms</span>
            <Input value={head.paymentTerms} onChange={(e) => setHead({ ...head, paymentTerms: e.target.value })} />
          </label>
          <label className="block sm:col-span-2 lg:col-span-3">
            <span className={label}>Other remarks</span>
            <Input value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} />
          </label>
        </div>
      </div>

      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {current ? "Submit revised quotation" : "Submit quotation"}
      </Button>
    </form>
  );
}
