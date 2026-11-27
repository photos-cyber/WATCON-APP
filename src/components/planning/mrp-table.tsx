"use client";

import { ClipboardList, History, ImageOff, MessageSquareQuote, MoreHorizontal, PackageSearch, Pencil, ShoppingCart, SlidersHorizontal, Truck, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocStatusBadge, ToneBadge } from "@/components/commercial/ui";
import { MultiSelect, SingleSelect } from "@/components/forms/combobox";
import { Field } from "@/components/forms/field";
import { ReserveStockButton, type LocationOpt, type PositionOpt, type ProjectOpt } from "@/components/inventory/location-ui";
import { FormDialog } from "@/components/shared/dialogs";
import { EmptyState } from "@/components/shared/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { formatDate, formatQty, PRIORITY_LABELS } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createPoFromPlanningAction, createPrFromMrpAction, createRfqFromPlanningAction, saveRequirementAction, setGeneralPurchaseQtyAction, setPlanningAttributesAction, setRequirementStatusAction } from "@/modules/procurement/actions";
import type { MrpRow } from "@/modules/planning/service";

const num = "px-2 py-2 text-right tabular-nums whitespace-nowrap";
const FLAG_LABEL: Record<string, { label: string; tone: "bad" | "warn" }> = { DAMAGED: { label: "Damaged / rejected", tone: "bad" }, BELOW_REORDER: { label: "At / below minimum", tone: "warn" }, DUE_SOON: { label: "Due ≤ 7 days", tone: "warn" }, OVERDUE: { label: "Requirement overdue", tone: "bad" } };
const z = (v: string | null) => (!v || Number(v) === 0 ? <span className="text-muted-foreground/50">—</span> : formatQty(v));
const pos = (v: string | null | undefined) => !!v && Number(v) > 0;
const onOrder = (r: MrpRow) => String(Number(r.poPipeline) + Number(r.openPr) + Number(r.openRfq));

export type Caps = { canManage: boolean; canReserve: boolean; canRaisePr: boolean; canRfq: boolean; canPo: boolean; canTransfer: boolean; canPlanStock: boolean };
export type SupplierOpt = { id: string; name: string; code: string };
type Mode = "project" | "general" | "all";

export function MrpTable({ rows, caps, projects, positions, locations, suppliers, mode, showProject }: { rows: MrpRow[]; caps: Caps; projects: ProjectOpt[]; positions: PositionOpt[]; locations: LocationOpt[]; suppliers: SupplierOpt[]; mode: Mode; showProject: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState(false);
  const [dialog, setDialog] = useState<"po" | "rfq" | null>(null);
  const canSelect = caps.canPo || caps.canRfq || caps.canRaisePr;
  const orderable = rows.filter((r) => pos(r.toOrder));
  const selectedRows = rows.filter((r) => selected.includes(r.rowKey));
  const prProjects = [...new Set(selectedRows.map((r) => r.project?.id ?? "-"))];
  const general = mode === "general";
  const toggle = (key: string, on: boolean) => setSelected((s) => (on ? [...s, key] : s.filter((x) => x !== key)));

  async function raisePr() {
    if (prProjects.length !== 1 || prProjects[0] === "-") {
      toast.error("A requisition is for one project: select lines of one project, or create a purchase order / rate enquiry for a combined order.");
      return;
    }
    const res = await callAction(createPrFromMrpAction, { projectId: prProjects[0], requirementIds: selectedRows.map((r) => r.requirementId!) });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`Requisition ${res.data.number} created with the quantities still to order.`);
    setSelected([]);
    router.push(`/purchase-requisitions/${res.data.id}`);
  }

  if (!rows.length)
    return general ? (
      <EmptyState icon={PackageSearch} title="No general stock planned" description="Set a minimum and target stock on an item (Item page → brands), or add a stock purchase quantity, to plan warehouse stock without a project." />
    ) : (
      <EmptyState icon={PackageSearch} title="No material requirements" description="Approved sales orders create requirements automatically from their material lines. You can also add a requirement by hand." />
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {caps.canPo && (
          <Button size="sm" disabled={!selected.length} onClick={() => setDialog("po")}>
            <ShoppingCart /> Purchase order ({selected.length})
          </Button>
        )}
        {caps.canRfq && (
          <Button size="sm" variant="outline" disabled={!selected.length} onClick={() => setDialog("rfq")}>
            <MessageSquareQuote /> Rate enquiry
          </Button>
        )}
        {caps.canRaisePr && !general && (
          <Button size="sm" variant="outline" disabled={!selected.length} onClick={raisePr}>
            <ClipboardList /> Requisition
          </Button>
        )}
        {canSelect && (
          <Button size="sm" variant="ghost" disabled={!orderable.length} onClick={() => setSelected(orderable.map((r) => r.rowKey))}>
            Select all to order ({orderable.length})
          </Button>
        )}
        {selected.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        )}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox checked={detail} onCheckedChange={(v) => setDetail(v === true)} /> More columns
        </label>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[1050px] text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              {canSelect && <th className="w-8 px-2" />}
              <th className="w-12 px-2" aria-label="Image" />
              <th className="px-2 py-2 text-left font-medium">Item – brand</th>
              {showProject && !general && <th className="px-2 py-2 text-left font-medium">For</th>}
              {general && <th className="px-2 py-2 text-right font-medium" title="Minimum stock (reorder level)">Min</th>}
              {general && <th className="px-2 py-2 text-right font-medium" title="Order-up-to level">Target</th>}
              <th className="px-2 py-2 text-right font-medium">{general ? "Requested" : "Required"}</th>
              {!general && <th className="px-2 py-2 text-right font-medium" title="Received at / sent to site, incl. consumed and delivered">Issued</th>}
              <th className="px-2 py-2 text-right font-medium" title="Warehouse stock not reserved for any project">Available</th>
              <th className="px-2 py-2 text-right font-medium" title={general ? "Warehouse stock reserved for projects" : "Reserved for this project"}>Reserved</th>
              <th className="px-2 py-2 text-right font-medium" title="Approved purchase orders not yet received">Incoming</th>
              <th className="px-2 py-2 text-right font-medium" title="Draft / pending POs, open requisitions and open rate enquiries">On order</th>
              {general && <th className="px-2 py-2 text-right font-medium" title="Reorder suggestion: target − (available + incoming + on order) when at or below the minimum">Suggested</th>}
              {detail && !general && <th className="px-2 py-2 text-right font-medium">At site</th>}
              {detail && !general && <th className="px-2 py-2 text-right font-medium">Consumed</th>}
              {detail && !general && <th className="px-2 py-2 text-right font-medium">Shortage</th>}
              {detail && <th className="px-2 py-2 text-right font-medium">Open PR</th>}
              {detail && <th className="px-2 py-2 text-right font-medium">Open RFQ</th>}
              {detail && <th className="px-2 py-2 text-right font-medium">Physical</th>}
              <th className="px-2 py-2 text-right font-medium">To order</th>
              <th className="px-2 py-2 text-left font-medium">Status</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.rowKey} className={cn("align-top", selected.includes(r.rowKey) && "bg-primary/[0.03]")}>
                {canSelect && (
                  <td className="px-2 py-2.5">
                    <Checkbox aria-label={`Select ${r.item.name}`} disabled={!pos(r.toOrder) && !(r.scope === "GENERAL")} checked={selected.includes(r.rowKey)} onCheckedChange={(v) => toggle(r.rowKey, v === true)} />
                  </td>
                )}
                <td className="px-2 py-2">
                  {r.item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.item.image} alt="" className="size-10 rounded-md border bg-white object-contain" loading="lazy" />
                  ) : (
                    <span className="flex size-10 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground/60"><ImageOff className="size-4" /></span>
                  )}
                </td>
                <td className="px-2 py-2">
                  <Link href={`/items/${r.item.id}`} className="font-medium hover:text-primary hover:underline">{r.item.name}</Link>
                  <div className="text-xs text-muted-foreground">
                    {r.brand.name} · {r.item.code}
                    {r.preferredSupplier ? ` · ${r.preferredSupplier.name}` : ""}
                  </div>
                  {r.salesOrder && <Link href={`/sales-orders/${r.salesOrder.id}`} className="text-xs text-primary hover:underline">From sales order {r.salesOrder.number}</Link>}
                  {r.flags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.flags.map((f) => <ToneBadge key={f} tone={FLAG_LABEL[f]!.tone} className="px-1.5 py-0 text-[10px]">{FLAG_LABEL[f]!.label}</ToneBadge>)}
                    </div>
                  )}
                </td>
                {showProject && !general && (
                  <td className="px-2 py-2 font-mono text-xs">
                    {r.project ? <Link href={`/projects/${r.project.id}?tab=planning`} className="hover:underline">{r.project.code}</Link> : <span className="font-sans text-muted-foreground">General stock</span>}
                  </td>
                )}
                {general && <td className={num}>{z(r.minStock)}</td>}
                {general && <td className={num}>{z(r.targetStock)}</td>}
                <td className={num}>
                  {general ? z(r.manualQty) : <>{formatQty(r.requiredQty)} <span className="text-xs text-muted-foreground">{r.item.unit}</span></>}
                  {!general && <div className="text-xs text-muted-foreground">{r.scope === "GENERAL" ? "general stock" : r.requiredBy ? `by ${formatDate(r.requiredBy)}` : "no date"}</div>}
                </td>
                {!general && <td className={num}>{z(r.issuedQty)}</td>}
                <td className={num}>{z(r.availableStock)}</td>
                <td className={num}>{z(r.reservedStock)}</td>
                <td className={num}>
                  {z(r.incoming)}
                  {r.expectedDate && <div className={cn("text-xs", r.status === "DELAYED" ? "text-rose-700" : "text-muted-foreground")}>exp {formatDate(r.expectedDate)}</div>}
                </td>
                <td className={num}>{z(onOrder(r))}</td>
                {general && <td className={num}>{z(r.suggestedQty)}</td>}
                {detail && !general && <td className={num}>{z(r.siteStock)}</td>}
                {detail && !general && <td className={num}>{z(r.consumed)}</td>}
                {detail && !general && <td className={cn(num, pos(r.shortage) && "text-rose-700")}>{z(r.shortage)}</td>}
                {detail && <td className={num}>{z(r.openPr)}</td>}
                {detail && <td className={num}>{z(r.openRfq)}</td>}
                {detail && <td className={num}>{z(r.totalPhysical)}</td>}
                <td className={cn(num, pos(r.toOrder) && "font-semibold")}>
                  {z(r.toOrder)}
                  {r.estimatedCost && <div className="text-xs font-normal text-muted-foreground">≈ {formatINR(r.estimatedCost)}</div>}
                </td>
                <td className="px-2 py-2">
                  <DocStatusBadge status={r.status} />
                  <div className="mt-1 text-[11px] text-muted-foreground">{PRIORITY_LABELS[r.urgency] ?? r.urgency} urgency</div>
                </td>
                <td className="px-1 py-2">
                  <RowMenu r={r} caps={caps} projects={projects} positions={positions} locations={locations} suppliers={suppliers} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {general
          ? "General stock: suggested = target − (available + incoming + on order) once stock is at or below the minimum. To order = the larger of the suggestion and the requested quantity still open, so nothing already on order is asked for twice."
          : "To order = required − issued − reserved − incoming − on order (POs, requisitions, rate enquiries) − free warehouse stock. Each order line stays linked to its requirement, so a combined order for several projects and general stock never orders the same need twice."}
      </p>
      {dialog && <OrderDialog mode={dialog} rows={selectedRows} suppliers={suppliers} onClose={(done) => { setDialog(null); if (done) setSelected([]); }} />}
    </div>
  );
}

function RowMenu({ r, caps, projects, positions, locations, suppliers }: { r: MrpRow; caps: Caps; projects: ProjectOpt[]; positions: PositionOpt[]; locations: LocationOpt[]; suppliers: SupplierOpt[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<"req" | "levels" | "qty" | null>(null);
  const project = r.project;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${r.item.name}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          {project && caps.canTransfer && pos(r.freeStock) && (
            <DropdownMenuItem asChild>
              <Link href={`/challans/new?type=ISSUE_TO_SITE&projectId=${project.id}&itemBrandId=${r.itemBrandId}&qty=${pos(r.canReserveNow) ? r.canReserveNow : r.freeStock}`}>
                <Truck /> Issue available stock to site
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link href={`/purchase-orders?${project ? `projectId=${project.id}&` : ""}q=${encodeURIComponent(r.item.name)}&pending=1`}>
              <Truck /> View related deliveries
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/stock?tab=ledger&itemId=${r.item.id}&brandId=${r.brand.id}`}>
              <History /> View stock ledger
            </Link>
          </DropdownMenuItem>
          {r.scope === "GENERAL" && caps.canManage && (
            <DropdownMenuItem onSelect={() => setEdit("qty")}>
              <Pencil /> Set purchase quantity
            </DropdownMenuItem>
          )}
          {r.scope === "GENERAL" && caps.canPlanStock && (
            <DropdownMenuItem onSelect={() => setEdit("levels")}>
              <SlidersHorizontal /> Minimum / target stock
            </DropdownMenuItem>
          )}
          {caps.canManage && r.requirementId && r.scope === "PROJECT" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setEdit("req")}>
                <Pencil /> Edit requirement
              </DropdownMenuItem>
            </>
          )}
          {caps.canManage && r.requirementId && (
            <DropdownMenuItem
              onSelect={async () => {
                const res = await callAction(setRequirementStatusAction, r.requirementId!, r.reqStatus === "OPEN" ? "CLOSED" : "OPEN");
                if (!res.ok) toast.error(res.error);
                else {
                  toast.success(r.reqStatus === "OPEN" ? "Requirement closed." : "Requirement reopened.");
                  router.refresh();
                }
              }}
            >
              <XCircle /> {r.reqStatus === "OPEN" ? "Close requirement" : "Reopen requirement"}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {project && caps.canReserve && pos(r.canReserveNow) && (
        <div className="mt-1">
          <ReserveStockButton projects={projects} positions={positions} locations={locations} presetProjectId={project.id} presetItemBrandId={r.itemBrandId} label={`Reserve ${formatQty(r.canReserveNow)}`} variant="ghost" />
        </div>
      )}
      {edit === "req" && project && <RequirementDialog open onOpenChange={(o) => !o && setEdit(null)} projects={projects} positions={positions} initial={{ projectId: project.id, itemBrandId: r.itemBrandId, requiredQty: r.requiredQty, requiredBy: r.requiredBy?.slice(0, 10) ?? "", priority: r.priority, notes: r.notes ?? "" }} />}
      {edit === "qty" && <RequirementDialog open onOpenChange={(o) => !o && setEdit(null)} projects={projects} positions={positions} allowGeneral initial={{ projectId: null, general: true, itemBrandId: r.itemBrandId, requiredQty: r.manualLeft ?? "", notes: r.notes ?? "" }} />}
      {edit === "levels" && <LevelsDialog r={r} suppliers={suppliers} onClose={() => setEdit(null)} />}
    </>
  );
}

// ─────────────────────────── Order dialog (PO / RFQ from selected lines) ───────────────────────────

type OrderLine = { key: string; requirementId: string | null; itemBrandId: string; label: string; sub: string; unit: string; max: string | null; quantity: string; rate: string };

export function OrderDialog({ mode, rows, suppliers, onClose }: { mode: "po" | "rfq"; rows: MrpRow[]; suppliers: SupplierOpt[]; onClose: (done: boolean) => void }) {
  const router = useRouter();
  const preferred = [...new Set(rows.map((r) => r.preferredSupplier?.id).filter(Boolean) as string[])];
  const [lines, setLines] = useState<OrderLine[]>(
    rows.map((r) => ({
      key: r.rowKey,
      requirementId: r.requirementId,
      itemBrandId: r.itemBrandId,
      label: `${r.item.name} — ${r.brand.name}`,
      sub: r.project ? r.project.code : "General stock",
      unit: r.item.unit,
      max: r.maxOrderQty,
      quantity: pos(r.toOrder) ? r.toOrder : "",
      rate: r.lastPurchaseRate ? String(Number(r.lastPurchaseRate)) : "",
    })),
  );
  const [partyId, setPartyId] = useState<string | null>(preferred.length === 1 ? preferred[0]! : null);
  const [supplierIds, setSupplierIds] = useState<string[]>(preferred);
  const [date, setDate] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const projects = [...new Set(rows.map((r) => r.project?.code ?? "General stock"))];
  const combined = projects.length > 1 || rows.some((r) => !r.project);
  const set = (i: number, p: Partial<OrderLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  async function submit(finalize = false) {
    setBusy(true);
    const payloadLines = lines.filter((l) => Number(l.quantity) > 0).map((l) => ({ requirementId: l.requirementId, itemBrandId: l.itemBrandId, quantity: l.quantity, rate: mode === "po" ? l.rate : null }));
    const res = mode === "po" ? await callAction(createPoFromPlanningAction, { partyId, expectedDate: date, lines: payloadLines }, { finalize }) : await callAction(createRfqFromPlanningAction, { supplierIds, responseDue: date, lines: payloadLines });
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    const fin = res.data as { finalized?: boolean; finalizeError?: string | null };
    if (finalize && fin.finalizeError) toast.warning(`PO ${res.data.number} saved as draft, but not finalized: ${fin.finalizeError}`);
    else toast.success(mode === "po" ? (fin.finalized ? `Purchase order ${res.data.number} finalized — share it with the supplier.` : `Purchase order ${res.data.number} saved as draft — check rates and finalize it.`) : `Rate enquiry ${res.data.number} created — share it with the suppliers.`);
    onClose(true);
    router.push(mode === "po" ? `/purchase-orders/${res.data.id}` : `/rate-enquiries/${res.data.id}`);
  }

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose(false)} title={mode === "po" ? "Create purchase order" : "Create rate enquiry"} description={combined ? `Combined for ${projects.join(", ")} — delivered to the main warehouse; each line stays allocated to its project or general stock.` : `For ${projects[0]} — delivered to the project site.`}>
      {() => (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {mode === "po" ? (
            <Field id="pl-party" label="Supplier" required error={errors.partyId}>
              <SingleSelect id="pl-party" options={suppliers.map((s) => ({ value: s.id, label: s.name, hint: preferred.includes(s.id) ? "preferred" : s.code }))} value={partyId} onChange={setPartyId} allowClear={false} placeholder="Select supplier" invalid={!!errors.partyId} />
            </Field>
          ) : (
            <Field id="pl-sup" label="Suppliers to ask" required error={errors.supplierIds}>
              <MultiSelect id="pl-sup" options={suppliers.map((s) => ({ value: s.id, label: s.name, hint: preferred.includes(s.id) ? "preferred" : s.code }))} value={supplierIds} onChange={setSupplierIds} placeholder="Select suppliers" invalid={!!errors.supplierIds} />
            </Field>
          )}
          <div className="max-h-[45vh] space-y-2 overflow-y-auto">
            {lines.map((l, i) => (
              <div key={l.key} className="grid grid-cols-[1fr_7rem] gap-2 rounded-lg border p-2 sm:grid-cols-[1fr_7rem_8rem]">
                <div className="min-w-0 text-sm">
                  <div className="truncate font-medium">{l.label}</div>
                  <div className="text-xs text-muted-foreground">{l.sub}{l.max !== null ? ` · max ${formatQty(l.max)} ${l.unit}` : ""}</div>
                  {(errors[`lines.${i}.quantity`] || errors[`lines.${i}.rate`]) && <p className="text-xs text-destructive">{errors[`lines.${i}.quantity`] ?? errors[`lines.${i}.rate`]}</p>}
                </div>
                <Input aria-label={`Quantity for ${l.label}`} inputMode="decimal" className="text-right" placeholder={`Qty (${l.unit})`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
                {mode === "po" && <Input aria-label={`Rate for ${l.label}`} inputMode="decimal" className="col-span-2 text-right sm:col-span-1" placeholder="Rate ₹" value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} />}
              </div>
            ))}
          </div>
          {errors.lines && <p className="text-xs text-destructive">{errors.lines}</p>}
          <Field id="pl-date" label={mode === "po" ? "Expected delivery" : "Quotes due by"} help={mode === "po" ? "Defaults to the earliest required-by date." : undefined}>
            <Input id="pl-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onClose(false)}>Cancel</Button>
            {mode === "po" ? (
              <>
                <Button type="submit" variant="outline" disabled={busy || !partyId}>Save draft</Button>
                <Button type="button" disabled={busy || !partyId || lines.some((l) => Number(l.quantity) > 0 && !(Number(l.rate) > 0))} onClick={() => submit(true)} title="Creates the PO and finalizes it — enter a rate on every line.">Create &amp; finalize PO</Button>
              </>
            ) : (
              <Button type="submit" disabled={busy || !supplierIds.length}>Create enquiry</Button>
            )}
          </div>
        </form>
      )}
    </FormDialog>
  );
}

/**
 * "Request rates" / "Purchase order" buttons for a fixed set of planning rows — used on the sales
 * order page so material can be ordered straight from the order (items, brands, quantities and
 * project carried forward; allocations kept).
 */
export function PlanOrderButtons({ rows, suppliers, canPo, canRfq }: { rows: MrpRow[]; suppliers: SupplierOpt[]; canPo: boolean; canRfq: boolean }) {
  const [dialog, setDialog] = useState<"po" | "rfq" | null>(null);
  if (!rows.length) return null;
  return (
    <>
      {canRfq && (
        <Button size="sm" variant="outline" onClick={() => setDialog("rfq")} title="Ask suppliers for rates for the material still to order">
          <MessageSquareQuote /> Request rates
        </Button>
      )}
      {canPo && (
        <Button size="sm" variant="outline" onClick={() => setDialog("po")} title="Order the material still to order directly, without a rate enquiry">
          <ShoppingCart /> Purchase order
        </Button>
      )}
      {dialog && <OrderDialog mode={dialog} rows={rows} suppliers={suppliers} onClose={() => setDialog(null)} />}
    </>
  );
}

// ─────────────────────────── General stock levels ───────────────────────────

function LevelsDialog({ r, suppliers, onClose }: { r: MrpRow; suppliers: SupplierOpt[]; onClose: () => void }) {
  const router = useRouter();
  const [v, setV] = useState({ reorderLevel: r.minStock ?? "", targetStock: r.targetStock ?? "", preferredSupplierId: r.preferredSupplier?.id ?? null });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Minimum and target stock" description={`${r.item.name} — ${r.brand.name}. When warehouse stock (plus what is on order) falls to the minimum, planning suggests ordering back up to the target.`}>
      {() => (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const res = await callAction(setPlanningAttributesAction, r.itemBrandId, v);
            setBusy(false);
            if (!res.ok) {
              setErrors(res.fieldErrors ?? {});
              toast.error(res.error);
              return;
            }
            toast.success("Stock levels saved.");
            onClose();
            router.refresh();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lv-min" label={`Minimum stock (${r.item.unit})`} error={errors.reorderLevel} help="Leave empty to stop monitoring.">
              <Input id="lv-min" inputMode="decimal" value={v.reorderLevel} onChange={(e) => setV({ ...v, reorderLevel: e.target.value })} />
            </Field>
            <Field id="lv-target" label={`Target stock (${r.item.unit})`} error={errors.targetStock} help="Order up to this level.">
              <Input id="lv-target" inputMode="decimal" value={v.targetStock} onChange={(e) => setV({ ...v, targetStock: e.target.value })} />
            </Field>
          </div>
          <Field id="lv-sup" label="Preferred supplier" error={errors.preferredSupplierId}>
            <SingleSelect id="lv-sup" options={suppliers.map((s) => ({ value: s.id, label: s.name, hint: s.code }))} value={v.preferredSupplierId} onChange={(x) => setV({ ...v, preferredSupplierId: x })} placeholder="None" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>Save</Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}

// ─────────────────────────── Requirement / stock purchase dialog ───────────────────────────

type ReqInitial = { projectId: string | null; general: boolean; itemBrandId: string | null; requiredQty: string; requiredBy: string; priority: string; notes: string };

export function RequirementDialog({ projects, positions, initial, open, onOpenChange, trigger, allowGeneral = false }: { projects: ProjectOpt[]; positions: PositionOpt[]; initial?: Partial<ReqInitial>; open?: boolean; onOpenChange?: (o: boolean) => void; trigger?: React.ReactNode; allowGeneral?: boolean }) {
  const general = !!initial?.general;
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={general ? "General stock purchase" : initial?.itemBrandId ? "Edit material requirement" : "Add material requirement"} description={general ? "Quantity still to buy for the warehouse (no project). What is already on order is not asked for again." : "One line per item and brand for the project. Saving the same item–brand again updates it."} trigger={trigger}>
      {(close) => <RequirementForm projects={projects} positions={positions} initial={initial} onDone={close} allowGeneral={allowGeneral} />}
    </FormDialog>
  );
}

const GENERAL = "__general__";

function RequirementForm({ projects, positions, initial, onDone, allowGeneral }: { projects: ProjectOpt[]; positions: PositionOpt[]; initial?: Partial<ReqInitial>; onDone: () => void; allowGeneral: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<ReqInitial>({ projectId: null, general: false, itemBrandId: null, requiredQty: "", requiredBy: "", priority: "MEDIUM", notes: "", ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const unit = positions.find((p) => p.id === v.itemBrandId)?.unit;
  const lockedTarget = !!initial?.projectId || (!!initial?.general && !!initial?.itemBrandId);
  const projectOptions = [...(allowGeneral ? [{ value: GENERAL, label: "General stock (no project)", hint: "warehouse" }] : []), ...projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))];
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const res = v.general ? await callAction(setGeneralPurchaseQtyAction, { itemBrandId: v.itemBrandId, quantity: v.requiredQty, notes: v.notes }) : await callAction(saveRequirementAction, v);
        setBusy(false);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error);
          return;
        }
        toast.success(v.general ? "Stock purchase quantity saved." : "Requirement saved.");
        onDone();
        router.refresh();
      }}
    >
      <Field id="rq-project" label="For" required error={errors.projectId}>
        <SingleSelect id="rq-project" options={projectOptions} value={v.general ? GENERAL : v.projectId} onChange={(x) => setV({ ...v, general: x === GENERAL, projectId: x === GENERAL ? null : x })} disabled={lockedTarget} allowClear={false} placeholder="Select project or general stock" />
      </Field>
      <Field id="rq-ib" label="Item – brand" required error={errors.itemBrandId} help="Each brand is planned separately. Add new brands to an item from the item page.">
        <SingleSelect id="rq-ib" options={positions.map((p) => ({ value: p.id, label: `${p.itemName} — ${p.brandName}`, hint: p.itemCode }))} value={v.itemBrandId} onChange={(x) => setV({ ...v, itemBrandId: x })} disabled={!!initial?.itemBrandId} allowClear={false} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="rq-qty" label={`${v.general ? "Still to buy" : "Required qty"}${unit ? ` (${unit})` : ""}`} required error={errors.requiredQty ?? errors.quantity}>
          <Input id="rq-qty" inputMode="decimal" value={v.requiredQty} onChange={(e) => setV({ ...v, requiredQty: e.target.value })} />
        </Field>
        {!v.general && (
          <>
            <Field id="rq-date" label="Required by" error={errors.requiredBy}>
              <Input id="rq-date" type="date" value={v.requiredBy} onChange={(e) => setV({ ...v, requiredBy: e.target.value })} />
            </Field>
            <Field id="rq-pri" label="Priority">
              <Select value={v.priority} onValueChange={(x) => setV({ ...v, priority: x })}>
                <SelectTrigger id="rq-pri" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
                    <SelectItem key={k} value={k}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        )}
      </div>
      <Field id="rq-notes" label="Notes" error={errors.notes}>
        <Textarea id="rq-notes" rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={busy}>Save</Button>
      </div>
    </form>
  );
}
