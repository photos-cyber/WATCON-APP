"use client";

import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/call-action";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { BUILT_IN_TEMPLATES, computeMilestones, TRIGGERS, TRIGGER_KEYS, validateSchedule, type MilestoneInput, type Trigger } from "@/modules/commercial/payment-terms";
import { savePaymentTemplateAction } from "@/modules/sales/quotation-actions";

export type SavedTemplate = { id: string; name: string; milestones: MilestoneInput[] };

const COLORS = ["bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-teal-500", "bg-orange-500", "bg-indigo-500"];
const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

/**
 * Payment milestone builder: templates, percentage or fixed-amount rows, trigger events, due dates /
 * net days, reorder, live amounts against `total` and a visual breakdown. Uses the same engine as
 * the server, so the preview and the saved amounts always agree.
 */
export function MilestoneBuilder({ total, value, onChange, savedTemplates = [], canSaveTemplate = false, requireFull = true, error }: { total: string; value: MilestoneInput[]; onChange: (v: MilestoneInput[]) => void; savedTemplates?: SavedTemplate[]; canSaveTemplate?: boolean; requireFull?: boolean; error?: string }) {
  const [templateName, setTemplateName] = useState("");
  const safeTotal = /^\d+(\.\d{1,2})?$/.test(total) ? total : "0";
  const computed = useMemo(() => {
    try {
      return computeMilestones(safeTotal, value);
    } catch {
      return null;
    }
  }, [safeTotal, value]);
  const problems = useMemo(() => {
    try {
      return validateSchedule(safeTotal, value, { requireFull });
    } catch {
      return ["Check the numbers entered."];
    }
  }, [safeTotal, value, requireFull]);
  const set = (i: number, p: Partial<MilestoneInput>) => onChange(value.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const templates = [...BUILT_IN_TEMPLATES.map((t) => ({ id: `builtin:${t.key}`, name: t.name, milestones: t.milestones })), ...savedTemplates.map((t) => ({ ...t, id: `saved:${t.id}`, name: `${t.name} (saved)` }))];

  async function saveTemplate() {
    if (!templateName.trim()) return toast.error("Name the template first.");
    const res = await callAction(savePaymentTemplateAction, { name: templateName, milestones: value });
    if (!res.ok) return toast.error(res.error);
    toast.success(`Template “${res.data.name}” saved for everyone in the company.`);
    setTemplateName("");
  }

  const pctUsed = computed ? Number(computed.percentSum || "0") : 0;
  const remaining = computed ? Number(safeTotal) - Number(computed.amountSum) : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Apply a payment template" className="h-9 min-w-64 rounded-md border bg-background px-2 text-sm" value="" onChange={(e) => {
          const t = templates.find((x) => x.id === e.target.value);
          if (t) onChange(t.milestones.map((m) => ({ ...m })));
        }}>
          <option value="">Apply a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, { label: "", basis: "PERCENT", value: "", trigger: "CUSTOM" }])}>
          <Plus /> Add milestone
        </Button>
      </div>

      {/* Visual breakdown */}
      <div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Payment schedule breakdown">
          {computed?.rows.map((r, i) => {
            const w = Number(safeTotal) > 0 ? (Number(r.amount) / Number(safeTotal)) * 100 : 0;
            return w > 0 ? <div key={i} className={cn(COLORS[i % COLORS.length], "h-full")} style={{ width: `${Math.min(w, 100)}%` }} title={`${r.label}: ${formatINR(r.amount)}`} /> : null;
          })}
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Total <span className="font-medium text-foreground">{formatINR(safeTotal)}</span>
          </span>
          <span className={cn(Math.abs(remaining) > 0.001 && "font-medium text-amber-600")}>
            Allocated {formatINR(computed?.amountSum ?? "0")} ({pctUsed.toFixed(pctUsed % 1 ? 2 : 0)}%){Math.abs(remaining) > 0.001 ? ` · ${remaining > 0 ? "unallocated" : "over by"} ${formatINR(Math.abs(remaining).toFixed(2))}` : ""}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {value.map((m, i) => {
          const row = computed?.rows[i];
          return (
            <div key={i} className="rounded-lg border bg-card p-3">
              <div className="flex flex-wrap items-start gap-2">
                <span className={cn("mt-2.5 size-2.5 shrink-0 rounded-full", COLORS[i % COLORS.length])} />
                <div className="min-w-48 flex-1">
                  <Input aria-label={`Milestone ${i + 1} description`} placeholder="e.g. Advance with order" value={m.label} onChange={(e) => set(i, { label: e.target.value })} />
                </div>
                <div className="flex w-full items-center gap-1 sm:w-auto">
                  <select aria-label={`Milestone ${i + 1} basis`} className={cn(sel, "w-20")} value={m.basis} onChange={(e) => set(i, { basis: e.target.value as MilestoneInput["basis"], value: "" })}>
                    <option value="PERCENT">%</option>
                    <option value="AMOUNT">₹</option>
                  </select>
                  <Input aria-label={`Milestone ${i + 1} ${m.basis === "PERCENT" ? "percentage" : "amount"}`} inputMode="decimal" className="w-28 text-right" value={m.value} onChange={(e) => set(i, { value: e.target.value })} />
                </div>
                <div className="w-32 pt-2 text-right text-sm font-semibold tabular-nums">{row ? formatINR(row.amount) : "—"}</div>
                <div className="flex gap-1">
                  <Button type="button" size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="Remove milestone" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <select aria-label={`Milestone ${i + 1} trigger`} className={sel} value={m.trigger} onChange={(e) => set(i, { trigger: e.target.value as Trigger })}>
                  {TRIGGER_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {TRIGGERS[k]}
                    </option>
                  ))}
                </select>
                {m.trigger === "ON_DATE" && <Input aria-label={`Milestone ${i + 1} due date`} type="date" value={m.dueDate ?? ""} onChange={(e) => set(i, { dueDate: e.target.value || null })} />}
                {m.trigger === "NET_DAYS" && <Input aria-label={`Milestone ${i + 1} days`} inputMode="numeric" placeholder="Days after invoice" value={m.days ?? ""} onChange={(e) => set(i, { days: e.target.value === "" ? null : Number(e.target.value) })} />}
                <Input aria-label={`Milestone ${i + 1} note`} className={cn(m.trigger !== "ON_DATE" && m.trigger !== "NET_DAYS" && "sm:col-span-2")} placeholder="Note (optional), e.g. against proforma" value={m.note ?? ""} onChange={(e) => set(i, { note: e.target.value || null })} />
              </div>
            </div>
          );
        })}
        {!value.length && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">No payment milestones. Apply a template or add one.</p>}
      </div>

      {(problems.length > 0 || error) && (
        <ul className="list-inside list-disc rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {[...new Set([...(error ? [error] : []), ...problems])].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {canSaveTemplate && value.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Template name" className="h-8 w-64" placeholder="Save this schedule as a template…" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
          <Button type="button" size="sm" variant="outline" onClick={saveTemplate} disabled={problems.length > 0}>
            <Save /> Save template
          </Button>
        </div>
      )}
    </div>
  );
}
