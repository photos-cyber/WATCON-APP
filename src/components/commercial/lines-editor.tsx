"use client";

import { Plus, Trash2 } from "lucide-react";
import { SingleSelect } from "@/components/forms/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatQty } from "@/lib/format";
import { documentTotals, formatINR, lineAmounts, type DocTotals, type LineAmounts, type TaxMode } from "@/lib/money";
import { cn, newId } from "@/lib/utils";

export type ItemBrandOpt = { id: string; itemId: string; itemCode: string; itemName: string; brandName: string; unit: string; currentQty: string; hsnCode: string | null; gstRate: string | null; lastRate: string | null };

export type EditableLine = {
  key: string;
  id?: string | null;
  itemBrandId?: string | null;
  description?: string;
  hsnSac?: string;
  unit?: string;
  quantity: string;
  rate: string;
  discountPct: string;
  gstRate: string;
  /** Read-only context shown under the line (e.g. "Received 8 · Billed 0"). */
  note?: string;
  /** Hidden link fields passed through to the server (prLineId, poLineId …). */
  links?: Record<string, string | null>;
};

export const emptyLine = (gstRate = "18"): EditableLine => ({ key: newId(), itemBrandId: null, description: "", quantity: "", rate: "", discountPct: "0", gstRate, links: {} });

const GST = ["0", "0.25", "3", "5", "12", "18", "28"];

export function safeAmounts(l: EditableLine, mode: TaxMode): LineAmounts | null {
  try {
    if (!l.quantity || !l.rate) return null;
    return lineAmounts({ qty: l.quantity, rate: l.rate, discountPct: l.discountPct || "0", gstRate: l.gstRate || "0" }, mode);
  } catch {
    return null;
  }
}

export function safeTotals(lines: EditableLine[], mode: TaxMode, opts: { charges?: string; chargesGstRate?: string; roundToRupee?: boolean } = {}): DocTotals | null {
  try {
    const amounts = lines.map((l) => safeAmounts(l, mode)).filter(Boolean) as LineAmounts[];
    return documentTotals(amounts, { mode, charges: opts.charges || "0", chargesGstRate: opts.chargesGstRate || "0", roundToRupee: opts.roundToRupee });
  } catch {
    return null;
  }
}

/**
 * Multi-line editor for commercial documents. `variant="item"` picks an item–brand per line;
 * `variant="text"` uses free-text work items (BOQ / services). Totals are a preview only — the
 * server recomputes and stores its own figures.
 */
export function LinesEditor({ lines, onChange, variant = "item", options = [], mode, priced = true, errors = {}, allowAdd = true, lockItems = false, onPick }: { lines: EditableLine[]; onChange: (l: EditableLine[]) => void; variant?: "item" | "text"; options?: ItemBrandOpt[]; mode: TaxMode; priced?: boolean; errors?: Record<string, string>; allowAdd?: boolean; lockItems?: boolean; onPick?: (line: EditableLine, opt: ItemBrandOpt) => EditableLine }) {
  const optMap = new Map(options.map((o) => [o.id, o]));
  const set = (i: number, patch: Partial<EditableLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const err = (i: number, f: string) => errors[`lines.${i}.${f}`];
  const comboOptions = options.map((o) => ({ value: o.id, label: `${o.itemName} — ${o.brandName}`, hint: `${o.itemCode} · stock ${formatQty(o.currentQty)} ${o.unit}` }));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2 text-left font-medium">#</th>
              <th className="px-2 py-2 text-left font-medium">{variant === "item" ? "Item – brand" : "Description / BOQ item"}</th>
              {variant === "text" && <th className="w-24 px-2 py-2 text-left font-medium">HSN/SAC</th>}
              {variant === "text" && <th className="w-20 px-2 py-2 text-left font-medium">Unit</th>}
              <th className="w-28 px-2 py-2 text-right font-medium">Qty</th>
              {priced && <th className="w-32 px-2 py-2 text-right font-medium">Rate ₹</th>}
              {priced && <th className="w-20 px-2 py-2 text-right font-medium">Disc %</th>}
              {priced && <th className="w-24 px-2 py-2 text-right font-medium">GST %</th>}
              {priced && <th className="w-32 px-2 py-2 text-right font-medium">Amount</th>}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((l, i) => {
              const opt = l.itemBrandId ? optMap.get(l.itemBrandId) : undefined;
              const amt = priced ? safeAmounts(l, mode) : null;
              return (
                <tr key={l.key} className="align-top">
                  <td className="px-2 py-2 text-xs text-muted-foreground">{i + 1}</td>
                  <td className="px-2 py-2">
                    {variant === "item" ? (
                      <SingleSelect
                        ariaLabel={`Line ${i + 1} item and brand`}
                        options={comboOptions}
                        value={l.itemBrandId ?? null}
                        disabled={lockItems && !!l.id}
                        allowClear={false}
                        invalid={!!err(i, "itemBrandId")}
                        placeholder="Select item – brand"
                        searchPlaceholder="Search item, code or brand…"
                        onChange={(v) => {
                          const o = v ? optMap.get(v) : undefined;
                          let next: EditableLine = { ...l, itemBrandId: v, unit: o?.unit, hsnSac: o?.hsnCode ?? "", gstRate: o?.gstRate ?? l.gstRate, rate: l.rate || o?.lastRate || "" };
                          if (o && onPick) next = onPick(next, o);
                          set(i, next);
                        }}
                      />
                    ) : (
                      <Input aria-label={`Line ${i + 1} description`} value={l.description ?? ""} onChange={(e) => set(i, { description: e.target.value })} aria-invalid={!!err(i, "description")} />
                    )}
                    {variant === "item" && (
                      <Input aria-label={`Line ${i + 1} specification`} className="mt-1 h-7 text-xs" placeholder="Specification / remarks (optional)" value={l.description ?? ""} onChange={(e) => set(i, { description: e.target.value })} />
                    )}
                    {(err(i, "itemBrandId") || err(i, "description")) && <p className="mt-1 text-xs text-destructive">{err(i, "itemBrandId") ?? err(i, "description")}</p>}
                    {l.note && <p className="mt-1 text-xs text-muted-foreground">{l.note}</p>}
                  </td>
                  {variant === "text" && (
                    <td className="px-2 py-2">
                      <Input aria-label={`Line ${i + 1} HSN/SAC`} value={l.hsnSac ?? ""} onChange={(e) => set(i, { hsnSac: e.target.value })} />
                    </td>
                  )}
                  {variant === "text" && (
                    <td className="px-2 py-2">
                      <Input aria-label={`Line ${i + 1} unit`} value={l.unit ?? ""} onChange={(e) => set(i, { unit: e.target.value })} aria-invalid={!!err(i, "unit")} />
                    </td>
                  )}
                  <td className="px-2 py-2">
                    <Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className="text-right" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-invalid={!!err(i, "quantity")} />
                    {opt && <p className="mt-1 text-right text-[11px] text-muted-foreground">{opt.unit}</p>}
                    {err(i, "quantity") && <p className="mt-1 text-right text-xs text-destructive">{err(i, "quantity")}</p>}
                  </td>
                  {priced && (
                    <td className="px-2 py-2">
                      <Input aria-label={`Line ${i + 1} rate`} inputMode="decimal" className="text-right" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} aria-invalid={!!err(i, "rate")} />
                      {opt?.lastRate && <p className="mt-1 text-right text-[11px] text-muted-foreground">last ₹{opt.lastRate}</p>}
                      {err(i, "rate") && <p className="mt-1 text-right text-xs text-destructive">{err(i, "rate")}</p>}
                    </td>
                  )}
                  {priced && (
                    <td className="px-2 py-2">
                      <Input aria-label={`Line ${i + 1} discount`} inputMode="decimal" className="text-right" value={l.discountPct} onChange={(e) => set(i, { discountPct: e.target.value })} aria-invalid={!!err(i, "discountPct")} />
                    </td>
                  )}
                  {priced && (
                    <td className="px-2 py-2">
                      <select aria-label={`Line ${i + 1} GST`} className="h-9 w-full rounded-md border bg-card px-2 text-right text-sm" value={l.gstRate} onChange={(e) => set(i, { gstRate: e.target.value })}>
                        {GST.map((g) => (
                          <option key={g} value={g}>
                            {g}%
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  {priced && <td className="px-2 py-2 text-right tabular-nums">{amt ? formatINR(amt.total) : "—"}</td>}
                  <td className="px-1 py-2">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 1 || (lockItems && !!l.id)} onClick={() => onChange(lines.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {allowAdd && (
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...lines, emptyLine()])}>
          <Plus /> Add line
        </Button>
      )}
      {errors.lines && <p className="text-xs text-destructive">{errors.lines}</p>}
    </div>
  );
}

/** Sticky totals panel (preview). */
export function TotalsPanel({ totals, mode, className }: { totals: DocTotals | null; mode: TaxMode; className?: string }) {
  if (!totals) return null;
  const row = (label: string, value: string, strong = false) => (
    <div className={cn("flex justify-between gap-6", strong && "border-t pt-1.5 text-base font-semibold")}>
      <span className={strong ? "" : "text-muted-foreground"}>{label}</span>
      <span className="tabular-nums">{formatINR(value)}</span>
    </div>
  );
  return (
    <div className={cn("space-y-1 text-sm", className)}>
      {row("Taxable value", totals.taxable)}
      {totals.discount !== "0.00" && row("incl. discount", `-${totals.discount}`)}
      {totals.charges !== "0.00" && row("Freight / charges", totals.charges)}
      {mode === "INTRA" ? (
        <>
          {row("CGST", totals.cgst)}
          {row("SGST", totals.sgst)}
        </>
      ) : (
        row("IGST", totals.igst)
      )}
      {totals.roundOff !== "0.00" && row("Round off", totals.roundOff)}
      {row("Total", totals.total, true)}
    </div>
  );
}
