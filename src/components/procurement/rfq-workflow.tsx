"use client";

import { Ban, CheckCircle2, Link2, Loader2, Lock, Mail, Send, ShoppingCart, Sparkles, ThumbsDown, ThumbsUp, UserPlus } from "lucide-react";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { whatsappLink } from "@/lib/whatsapp";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocActions, type DocActionDef } from "@/components/commercial/doc-actions";
import type { ItemBrandOpt } from "@/components/commercial/lines-editor";
import { DocStatusBadge, Section, ToneBadge } from "@/components/commercial/ui";
import { MultiSelect, SingleSelect, type ComboOption } from "@/components/forms/combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/call-action";
import { formatDate, formatQty } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { ConfirmDialog } from "@/components/shared/dialogs";
import { addRfqSuppliersAction, convertQuotationToPoAction, createPosFromAwardAction, markRfqSupplierSharedAction, proposeAwardAction, recordQuotationAction, rfqActionAction } from "@/modules/procurement/actions";
import type { ComparisonQuote } from "@/modules/procurement/rfq";

type Line = { id: string; itemId: string; name: string; itemBrandId: string | null; quantity: string; unit: string; acceptableBrands: string | null };
type Quote = { id: string; partyId: string; partyName: string; number: string; revision: number; status: string; quoteDate: string; convertible?: boolean };
type Can = { manage: boolean; send: boolean; award: boolean; approveAward: boolean; approveBlockedReason: string | null; createPos: boolean; cancel: boolean; close: boolean };
type Entry = { enabled: boolean; itemBrandId: string; quantity: string; rate: string; discountPct: string; gstRate: string; leadTimeDays: string; paymentTerms: string };

const GST = ["0", "5", "12", "18", "28"];
const label = "mb-1 block text-xs font-medium text-muted-foreground";

type Supplier = { id: string; name: string; status: string; shared: boolean; opened: boolean; phone: string | null; email: string | null; link: string | null };

export function RfqWorkflow({ id, version, status, today, can, suppliers, supplierOptions, enquiry, lines, quotations, comparison, options }: { id: string; version: number; status: string; today: string; can: Can; suppliers: Supplier[]; supplierOptions: ComboOption[]; enquiry: { number: string; title: string; responseDue: string | null }; lines: Line[]; quotations: Quote[]; comparison: { lineId: string; name: string; quantity: string; unit: string; quotes: ComparisonQuote[] }[]; options: ItemBrandOpt[] }) {
  const router = useRouter();
  const gstOf = (l: Line) => options.find((o) => o.id === l.itemBrandId)?.gstRate ?? options.find((o) => o.itemId === l.itemId)?.gstRate ?? "18";
  const blank = () => Object.fromEntries(lines.map((l) => [l.id, { enabled: true, itemBrandId: l.itemBrandId ?? "", quantity: l.quantity, rate: "", discountPct: "0", gstRate: String(Number(gstOf(l))), leadTimeDays: "", paymentTerms: "" }])) as Record<string, Entry>;
  const [partyId, setPartyId] = useState<string | null>(null);
  const [head, setHead] = useState({ quoteDate: today, validUntil: "", supplierRef: "", freight: "0", freightGstRate: "18", deliveryDays: "", paymentTerms: "", advancePct: "", creditDays: "", warranty: "" });
  const [entries, setEntries] = useState<Record<string, Entry>>(blank);
  // Award qty starts pre-filled: the existing award if one was proposed, else the full line qty on the recommended quote.
  const defaultAwards = () => {
    const next: Record<string, string> = {};
    for (const c of comparison) {
      const awarded = c.quotes.filter((q) => q.awardedQty !== "0");
      if (awarded.length) for (const q of awarded) next[q.quotationLineId] = q.awardedQty;
      else {
        const best = c.quotes.find((q) => q.recommended);
        if (best) next[best.quotationLineId] = c.quantity;
      }
    }
    return next;
  };
  const awardsKey = comparison.map((c) => `${c.lineId}:${c.quotes.map((q) => `${q.quotationLineId}=${q.awardedQty}${q.recommended ? "*" : ""}`).join(",")}`).join("|");
  const [awards, setAwards] = useState<Record<string, string>>(defaultAwards);
  const [awardsFor, setAwardsFor] = useState(awardsKey);
  if (awardsFor !== awardsKey) {
    // New quotations or a saved award arrived (router.refresh) — re-seed the defaults.
    setAwardsFor(awardsKey);
    setAwards(defaultAwards());
  }
  const [busy, setBusy] = useState<string | null>(null);
  const [newSuppliers, setNewSuppliers] = useState<string[]>([]);
  const unshared = status !== "DRAFT" && suppliers.some((s) => !s.shared);
  const current = quotations.find((q) => q.partyId === partyId && q.status === "RECEIVED");
  const responded = new Set(quotations.filter((q) => q.status !== "SUPERSEDED").map((q) => q.partyId));

  const defs: DocActionDef[] = [];
  if (can.send && (status === "DRAFT" || unshared)) defs.push({ key: "send", label: status === "DRAFT" ? "Mark as shared with suppliers" : "Mark new suppliers as shared", icon: Send, variant: "default", confirm: { title: "Mark the enquiry as shared?", description: "Share it first using PDF / WhatsApp / email (top right). This only records that you shared it — the app does not send messages.", noteLabel: "Shared via (e.g. WhatsApp, email)", input: true }, success: "Enquiry marked as shared." });

  async function markShared(s: Supplier, via: string) {
    if (s.shared) return;
    const res = await callAction(markRfqSupplierSharedAction, id, s.id, via);
    if (res.ok) router.refresh();
  }

  async function addSuppliers() {
    if (!newSuppliers.length) return toast.error("Choose the suppliers to add.");
    setBusy("add");
    const res = await callAction(addRfqSuppliersAction, id, { supplierIds: newSuppliers });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${res.data.added} supplier(s) added. Share the enquiry with them (top right), then enter their quotations below.`);
    setNewSuppliers([]);
    router.refresh();
  }
  if (can.approveAward) {
    defs.push({ key: "approve_award", label: "Approve award", icon: ThumbsUp, variant: "default", confirm: { title: "Approve this award?", description: "Purchase orders can then be created for the awarded suppliers." }, success: "Award approved." });
    defs.push({ key: "reject_award", label: "Reject award", icon: ThumbsDown, confirm: { title: "Reject the proposed award?", description: "Purchasing can revise the award and propose again.", noteLabel: "Reason", noteRequired: true }, success: "Award rejected." });
  }
  if (can.close) defs.push({ key: "close", label: "Close", icon: Lock, confirm: { title: "Close this enquiry?", description: "No more quotations or awards will be recorded.", noteLabel: "Reason", noteRequired: true }, success: "Enquiry closed." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this enquiry?", description: "This cannot be undone.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Enquiry cancelled." });

  async function runQuote(e: React.FormEvent) {
    e.preventDefault();
    if (!partyId) return toast.error("Choose the supplier whose quotation you are entering.");
    setBusy("quote");
    const res = await callAction(recordQuotationAction, { rfqId: id, partyId, ...head, replacesId: current?.id ?? null, lines: lines.filter((l) => entries[l.id]?.enabled).map((l) => ({ ...entries[l.id], rfqLineId: l.id })) });
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Quotation recorded. Attach the supplier's quotation file under “Supplier quotations”.");
    setPartyId(null);
    setEntries(blank());
    setHead((h) => ({ ...h, validUntil: "", supplierRef: "", freight: "0", deliveryDays: "", paymentTerms: "", advancePct: "", creditDays: "", warranty: "" }));
    router.refresh();
  }

  function awardRecommended() {
    const next: Record<string, string> = {};
    for (const c of comparison) {
      const best = c.quotes.find((q) => q.recommended);
      if (best) next[best.quotationLineId] = c.quantity;
    }
    setAwards(next);
    toast.info("Filled with the recommended supplier per item. Adjust if you want to split.");
  }

  return (
    <>
      <Section title="Suppliers & actions">
        {suppliers.some((s) => s.link) && <p className="mb-2 text-xs text-muted-foreground">Send each supplier their own quote link — they fill in their rates on their phone (no login) and the quotation appears in the comparison below.</p>}
        <ul className="mb-3 divide-y rounded-lg border">
          {suppliers.map((s) => {
            const state = responded.has(s.id) ? "quoted" : s.opened ? "opened the link" : s.shared ? "link sent · awaiting quote" : "not sent yet";
            const message = s.link ? `Dear ${s.name},\n\nPlease send your best rates for our enquiry ${enquiry.number}: ${enquiry.title}.${enquiry.responseDue ? `\nPlease quote by ${enquiry.responseDue}.` : ""}\n\nFill in your rates here (no login needed):\n${s.link}\n\nThank you.` : "";
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5">
                  {responded.has(s.id) ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" /> : <span className={`size-2 shrink-0 rounded-full ${s.opened ? "bg-amber-500" : "bg-muted-foreground/40"}`} />}
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{state}</span>
                </span>
                {s.link && (
                  <span className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(s.link!);
                          toast.success(`Quote link for ${s.name} copied.`);
                          void markShared(s, "link");
                        } catch {
                          toast.error("Could not copy. Select and copy the link manually: " + s.link);
                        }
                      }}
                    >
                      <Link2 /> Copy link
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href={whatsappLink(message, s.phone)} target="_blank" rel="noopener noreferrer" onClick={() => void markShared(s, "whatsapp")}>
                        <WhatsAppIcon className="size-4" /> WhatsApp
                      </a>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href={`mailto:${s.email ?? ""}?subject=${encodeURIComponent(`Request for quotation ${enquiry.number}`)}&body=${encodeURIComponent(message)}`} onClick={() => void markShared(s, "email")}>
                        <Mail /> Email
                      </a>
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {can.manage && (
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <MultiSelect options={supplierOptions} value={newSuppliers} onChange={setNewSuppliers} placeholder="Add more suppliers to compare…" searchPlaceholder="Search suppliers…" emptyText="No other active suppliers." />
            </div>
            <Button size="sm" variant="outline" disabled={!!busy || !newSuppliers.length} onClick={addSuppliers}>
              {busy === "add" ? <Loader2 className="animate-spin" /> : <UserPlus />} Add {newSuppliers.length > 1 ? `${newSuppliers.length} suppliers` : "supplier"}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <DocActions actions={defs} run={(key, note) => callAction(rfqActionAction, id, key as never, { version, note })} />
          {can.createPos && (
            <Button
              size="sm"
              disabled={!!busy}
              onClick={async () => {
                setBusy("po");
                const r = await callAction(createPosFromAwardAction, id);
                setBusy(null);
                if (!r.ok) toast.error(r.error);
                else {
                  toast.success(`${r.data.length} purchase order(s) created and finalized — share them with the suppliers.`);
                  router.refresh();
                }
              }}
            >
              {busy === "po" ? <Loader2 className="animate-spin" /> : <ShoppingCart />} Create purchase orders
            </Button>
          )}
        </div>
        {can.approveBlockedReason && <p className="mt-2 text-sm text-muted-foreground">{can.approveBlockedReason}</p>}
      </Section>

      {can.manage && (
        <Section title={current ? "Revise a supplier's quotation" : "Enter a supplier's quotation"}>
          <form className="space-y-4" onSubmit={runQuote}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <span className={label}>Supplier *</span>
                <SingleSelect options={suppliers.map((s) => ({ value: s.id, label: s.name, hint: responded.has(s.id) ? "already quoted" : undefined }))} value={partyId} onChange={setPartyId} placeholder="Which supplier's quotation?" />
              </div>
              <label className="block">
                <span className={label}>Their quotation no.</span>
                <Input value={head.supplierRef} onChange={(e) => setHead({ ...head, supplierRef: e.target.value })} />
              </label>
              <label className="block">
                <span className={label}>Quotation date *</span>
                <Input required type="date" value={head.quoteDate} onChange={(e) => setHead({ ...head, quoteDate: e.target.value })} />
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
                <span className={label}>Freight / transport ₹</span>
                <Input inputMode="decimal" value={head.freight} onChange={(e) => setHead({ ...head, freight: e.target.value })} />
              </label>
              <label className="block">
                <span className={label}>GST on freight</span>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={head.freightGstRate} onChange={(e) => setHead({ ...head, freightGstRate: e.target.value })}>
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
              <label className="block sm:col-span-2">
                <span className={label}>Warranty</span>
                <Input placeholder="e.g. 12 months from installation" value={head.warranty} onChange={(e) => setHead({ ...head, warranty: e.target.value })} />
              </label>
              <label className="block sm:col-span-2 lg:col-span-4">
                <span className={label}>Payment terms offered (other conditions)</span>
                <Input value={head.paymentTerms} onChange={(e) => setHead({ ...head, paymentTerms: e.target.value })} />
              </label>
            </div>
            {current && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">This replaces {current.number} (revision {current.revision}). The old one stays in the history.</p>}
            <div className="space-y-2">
              {lines.map((l) => {
                const x = entries[l.id]!;
                const update = (p: Partial<Entry>) => setEntries((s) => ({ ...s, [l.id]: { ...s[l.id]!, ...p } }));
                const brands = options.filter((o) => o.itemId === l.itemId);
                return (
                  <div key={l.id} className="rounded-lg border p-3">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input type="checkbox" className="size-4" checked={x.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
                      {l.name}
                      <span className="font-normal text-muted-foreground">
                        · asked {formatQty(l.quantity)} {l.unit}
                        {l.acceptableBrands ? ` · also OK: ${l.acceptableBrands}` : ""}
                      </span>
                    </label>
                    {x.enabled ? (
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-6">
                        <label className="col-span-2 block">
                          <span className={label}>Brand offered</span>
                          <select aria-label={`${l.name} brand offered`} required className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={x.itemBrandId} onChange={(e) => update({ itemBrandId: e.target.value })}>
                            <option value="">Select brand</option>
                            {brands.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.brandName}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className={label}>Qty</span>
                          <Input aria-label={`${l.name} quantity`} inputMode="decimal" value={x.quantity} onChange={(e) => update({ quantity: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className={label}>Rate ₹ / {l.unit}</span>
                          <Input aria-label={`${l.name} rate`} inputMode="decimal" required value={x.rate} onChange={(e) => update({ rate: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className={label}>Discount %</span>
                          <Input aria-label={`${l.name} discount`} inputMode="decimal" value={x.discountPct} onChange={(e) => update({ discountPct: e.target.value })} />
                        </label>
                        <label className="col-span-2 block sm:col-span-6">
                          <span className={label}>Payment terms for this item (only if different)</span>
                          <Input aria-label={`${l.name} payment terms`} placeholder="e.g. 50% advance for this pump" value={x.paymentTerms} onChange={(e) => update({ paymentTerms: e.target.value })} />
                        </label>
                        <label className="block">
                          <span className={label}>GST</span>
                          <select aria-label={`${l.name} GST`} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={x.gstRate} onChange={(e) => update({ gstRate: e.target.value })}>
                            {[...new Set([...GST, x.gstRate])].map((g) => (
                              <option key={g} value={g}>
                                {g}%
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">Not quoted by this supplier.</p>
                    )}
                  </div>
                );
              })}
            </div>
            <Button disabled={!!busy} type="submit">
              {busy === "quote" && <Loader2 className="animate-spin" />}
              {current ? "Save revised quotation" : "Save quotation"}
            </Button>
          </form>
        </Section>
      )}

      <Section
        title="Compare quotations"
        actions={
          can.award &&
          comparison.some((c) => c.quotes.length) && (
            <Button size="sm" variant="outline" onClick={awardRecommended}>
              <Sparkles /> Award to recommended
            </Button>
          )
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">Landed cost = price after discount + GST + share of freight. “Recommended” is the cheapest valid landed cost, with on-time delivery history as the tie-breaker.</p>
        <div className="space-y-5">
          {comparison.map((c) => (
            <div key={c.lineId}>
              <h3 className="mb-1 font-medium">
                {c.name} <span className="font-normal text-muted-foreground">· {formatQty(c.quantity)} {c.unit}</span>
              </h3>
              {c.quotes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No quotations yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Supplier · brand</th>
                        <th className="px-3 py-2 text-right font-medium">Rate</th>
                        <th className="px-3 py-2 text-right font-medium">Landed / unit</th>
                        <th className="px-3 py-2 text-right font-medium">Delivery</th>
                        <th className="px-3 py-2 font-medium">Payment terms</th>
                        <th className="px-3 py-2 font-medium">Track record</th>
                        {can.award && <th className="px-3 py-2 text-right font-medium">Award qty</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {c.quotes.map((q) => (
                        <tr key={q.quotationLineId} className={q.recommended ? "bg-emerald-50/60 dark:bg-emerald-950/20" : ""}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{q.partyName}</div>
                            <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                              {q.brand}
                              {q.recommended && <ToneBadge tone="good">Recommended</ToneBadge>}
                              {q.lowestRate && <ToneBadge tone="info">Lowest price</ToneBadge>}
                              {q.lowestLanded && !q.recommended && <ToneBadge tone="info">Lowest landed</ToneBadge>}
                              {q.expired && <ToneBadge tone="bad">Expired {formatDate(q.validUntil)}</ToneBadge>}
                              {q.awardedQty !== "0" && <ToneBadge tone="violet">Awarded {formatQty(q.awardedQty)}</ToneBadge>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatINR(q.rate)}
                            {q.discountPct !== "0.00" && <div className="text-xs text-muted-foreground">−{Number(q.discountPct)}%</div>}
                          </td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{formatINR(q.landedUnit)}</td>
                          <td className="px-3 py-2 text-right">{q.leadTimeDays != null ? `${q.leadTimeDays} days` : "—"}</td>
                          <td className="px-3 py-2 text-xs">
                            {q.terms ?? <span className="text-muted-foreground">Not stated</span>}
                            {q.lineTerms && <span className="block font-medium text-amber-700">This item: {q.lineTerms}</span>}
                            {q.warranty && <span className="block text-muted-foreground">Warranty: {q.warranty}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs">{q.reliability.onTimePct == null ? <span className="text-muted-foreground">No history</span> : `${q.reliability.onTimePct}% on time · ${q.reliability.rejectionPct ?? 0}% rejected`}</td>
                          {can.award && (
                            <td className="px-3 py-2 text-right">
                              <Input aria-label={`Award ${c.name} to ${q.partyName}`} inputMode="decimal" className="ml-auto w-24 text-right" value={awards[q.quotationLineId] ?? ""} onChange={(e) => setAwards((s) => ({ ...s, [q.quotationLineId]: e.target.value }))} />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
        {can.award && (
          <Button
            className="mt-4"
            disabled={!!busy || !Object.values(awards).some((x) => x.trim())}
            onClick={async () => {
              setBusy("award");
              const r = await callAction(proposeAwardAction, id, { version, awards: Object.entries(awards).filter(([, quantity]) => quantity.trim()).map(([quotationLineId, quantity]) => ({ quotationLineId, quantity })) });
              setBusy(null);
              if (!r.ok) toast.error(r.error);
              else {
                toast.success("Award saved — now create the purchase orders.");
                router.refresh();
              }
            }}
          >
            {busy === "award" && <Loader2 className="animate-spin" />} Award to selected suppliers
          </Button>
        )}
      </Section>

      <Section title="Quotation history" bodyClassName="p-0">
        {quotations.length ? (
          <ul className="divide-y text-sm">
            {quotations.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                <span className="font-medium">{q.partyName}</span>
                <span className="text-muted-foreground">
                  {q.number} · rev {q.revision} · {formatDate(q.quoteDate)}
                </span>
                <DocStatusBadge status={q.status === "RECEIVED" ? "RECEIVED_QUOTE" : q.status} />
                {q.convertible && <ConvertQuote id={q.id} partyName={q.partyName} />}
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">No quotations yet. Enter each supplier’s quotation above as it comes in.</p>
        )}
      </Section>
    </>
  );
}

/** Comparison is optional: order straight from one supplier's quotation (draft PO, then Finalize). */
function ConvertQuote({ id, partyName }: { id: string; partyName: string }) {
  const router = useRouter();
  return (
    <span className="ml-auto">
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="outline">
            <ShoppingCart /> Create PO
          </Button>
        }
        title={`Order from ${partyName}?`}
        description="Creates a draft purchase order with this supplier's quoted rates, GST, freight, delivery and payment terms for everything still open on the enquiry. Check it and press Finalize. Comparing other quotations first is optional."
        confirmLabel="Create draft PO"
        onConfirm={async () => {
          const r = await callAction(convertQuotationToPoAction, { quotationId: id });
          if (!r.ok) {
            toast.error(r.error);
            return false;
          }
          toast.success(`Purchase order ${r.data.number} created — check it and Finalize.`);
          router.push(`/purchase-orders/${r.data.id}`);
        }}
      />
    </span>
  );
}
