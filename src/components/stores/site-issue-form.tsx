"use client";

import { ImageOff, Loader2, PackageOpen, Save, Truck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Field, FormSection } from "@/components/forms/field";
import { EmptyState } from "@/components/shared/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { formatQty } from "@/lib/format";
import { cn } from "@/lib/utils";
import { issueMaterialToSiteAction } from "@/modules/stores/actions";
import type { SiteIssueRow } from "@/modules/stores/site-issue";

const QTY = /^\d{1,11}(\.\d{1,3})?$/;

/** Pick sales-order materials and issue them to the project site in one challan. */
export function SiteIssueForm({ projectId, projectName, warehouses, fromLocationId, rows }: { projectId: string; projectName: string; warehouses: { id: string; name: string }[]; fromLocationId: string | null; rows: SiteIssueRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [clientKey] = useState(() => crypto.randomUUID());
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [r.requirementId, Number(r.suggested) > 0 ? r.suggested : ""])));
  const [picked, setPicked] = useState<string[]>(() => rows.filter((r) => Number(r.suggested) > 0).map((r) => r.requirementId));
  const [head, setHead] = useState({ vehicleNo: "", driverName: "", driverPhone: "", remarks: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"draft" | "issue" | null>(null);
  // Several confirmed orders carry the same material: the user says which order this issue is for.
  const [forOrder, setForOrder] = useState<Record<string, string>>({});

  if (!rows.length) return <EmptyState icon={PackageOpen} title="Nothing to issue" description="This project has no open material requirements. They are created automatically when its sales order is approved." />;

  const lines = rows.filter((r) => picked.includes(r.requirementId)).map((r) => ({ r, q: (qty[r.requirementId] ?? "").trim() }));
  const problems = lines.filter(({ r, q }) => !QTY.test(q) || Number(q) <= 0 || Number(q) > Number(r.available));

  async function submit(issueNow: boolean) {
    if (!fromLocationId) return toast.error("No active warehouse to issue from.");
    setBusy(issueNow ? "issue" : "draft");
    const res = await callAction(issueMaterialToSiteAction, { projectId, fromLocationId, clientKey, issueNow, ...head, lines: lines.map(({ r, q }) => ({ itemBrandId: r.itemBrandId, requirementId: r.requirementId, soLineId: forOrder[r.requirementId] || null, quantity: q })) });
    setBusy(null);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    toast.success(res.data.duplicate ? `Already created as ${res.data.number}.` : issueNow ? `Challan ${res.data.number} issued — the material is now in transit to the site.` : `Draft challan ${res.data.number} saved — no stock moved yet.`);
    router.push(`/challans/${res.data.id}`);
  }

  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4 text-sm">
        <div className="flex-1">
          <p className="text-xs text-muted-foreground">Issuing to</p>
          <p className="font-semibold">{projectName} — site store</p>
        </div>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">From warehouse</span>
          <select aria-label="From warehouse" className="h-9 rounded-md border bg-card px-2 text-sm" value={fromLocationId ?? ""} onChange={(e) => router.push(`${pathname}?from=${e.target.value}`)}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-8 px-2" />
              <th className="w-12 px-2" aria-label="Image" />
              <th className="px-2 py-2 text-left font-medium">Item – brand</th>
              <th className="px-2 py-2 text-right font-medium">Required</th>
              <th className="px-2 py-2 text-right font-medium" title="Received at site, in transit, consumed or delivered">Issued</th>
              <th className="px-2 py-2 text-right font-medium">Remaining</th>
              <th className="px-2 py-2 text-right font-medium" title="Warehouse stock not reserved for other projects">Available</th>
              <th className="px-2 py-2 text-right font-medium" title="Reserved for this project at the warehouse">Reserved here</th>
              <th className="w-36 px-2 py-2 text-right font-medium">Issue now</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r, i) => {
              const on = picked.includes(r.requirementId);
              const q = qty[r.requirementId] ?? "";
              const over = on && QTY.test(q) && Number(q) > Number(r.available);
              return (
                <tr key={r.requirementId} className={cn("align-top", on && "bg-primary/[0.03]")}>
                  <td className="px-2 py-2.5">
                    <Checkbox aria-label={`Issue ${r.item.name}`} checked={on} disabled={Number(r.available) <= 0} onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, r.requirementId] : p.filter((x) => x !== r.requirementId)))} />
                  </td>
                  <td className="px-2 py-2">
                    {r.item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.item.image} alt="" className="size-10 rounded-md border bg-white object-contain" loading="lazy" />
                    ) : (
                      <span className="flex size-10 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground/60"><ImageOff className="size-4" /></span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{r.item.name}</div>
                    <div className="text-xs text-muted-foreground">{r.brand} · {r.item.code}</div>
                    {r.orders.length > 1 ? (
                      <select aria-label={`Sales order for ${r.item.name}`} className="mt-1 h-7 max-w-full rounded-md border bg-background px-1 text-xs" value={forOrder[r.requirementId] ?? ""} onChange={(e) => setForOrder((s) => ({ ...s, [r.requirementId]: e.target.value }))}>
                        <option value="">For: oldest order first</option>
                        {r.orders.map((o) => (
                          <option key={o.soLineId} value={o.soLineId}>For SO {o.number} ({formatQty(o.quantity)})</option>
                        ))}
                      </select>
                    ) : (
                      r.salesOrder && <Link href={`/sales-orders/${r.salesOrder.id}`} className="text-xs text-primary hover:underline">SO {r.salesOrder.number}</Link>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.required)} <span className="text-xs text-muted-foreground">{r.item.unit}</span></td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatQty(r.issued)}{Number(r.inTransit) > 0 && <div className="text-xs text-muted-foreground">{formatQty(r.inTransit)} in transit</div>}</td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{formatQty(r.remaining)}</td>
                  <td className={cn("px-2 py-2 text-right tabular-nums", Number(r.available) <= 0 && "text-muted-foreground")}>{formatQty(r.available)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{Number(r.reservedForProject) > 0 ? formatQty(r.reservedForProject) : "—"}</td>
                  <td className="px-2 py-2">
                    <Input aria-label={`Quantity of ${r.item.name}`} inputMode="decimal" className="text-right" disabled={!on} value={q} onChange={(e) => setQty((s) => ({ ...s, [r.requirementId]: e.target.value }))} aria-invalid={over || !!errors[`lines.${i}.quantity`]} />
                    {over && <p className="mt-1 text-right text-xs text-destructive">Only {formatQty(r.available)} available</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FormSection title="Transport (optional)">
        <Field id="si-vehicle" label="Vehicle no."><Input id="si-vehicle" className="uppercase" value={head.vehicleNo} onChange={(e) => setHead({ ...head, vehicleNo: e.target.value })} /></Field>
        <Field id="si-driver" label="Driver"><Input id="si-driver" value={head.driverName} onChange={(e) => setHead({ ...head, driverName: e.target.value })} /></Field>
        <Field id="si-phone" label="Driver phone"><Input id="si-phone" inputMode="tel" value={head.driverPhone} onChange={(e) => setHead({ ...head, driverPhone: e.target.value })} /></Field>
        <Field id="si-remarks" label="Remarks" className="sm:col-span-2"><Textarea id="si-remarks" rows={2} value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} /></Field>
      </FormSection>

      <div className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center gap-2 border-t bg-background/95 p-3 backdrop-blur sm:sticky sm:justify-end sm:rounded-xl sm:border">
        <span className="mr-auto text-sm text-muted-foreground">{lines.length} item(s) selected{problems.length ? ` · ${problems.length} need a valid quantity` : ""}</span>
        <Button variant="outline" disabled={!!busy || !lines.length || problems.length > 0} onClick={() => submit(false)} title="Draft challan: no stock moves until it is issued">
          {busy === "draft" ? <Loader2 className="animate-spin" /> : <Save />} Save draft
        </Button>
        <Button disabled={!!busy || !lines.length || problems.length > 0} onClick={() => submit(true)}>
          {busy === "issue" ? <Loader2 className="animate-spin" /> : <Truck />} Issue challan
        </Button>
      </div>
    </div>
  );
}
