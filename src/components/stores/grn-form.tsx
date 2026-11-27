"use client";

import { Camera, CheckCheck, Loader2, MapPin, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { formatQty } from "@/lib/format";
import { cmpQty, subQty } from "@/lib/money";
import { createGrnAction, updateGrnAction } from "@/modules/stores/actions";

export type ReceiptSourceView = {
  kind: "po" | "challan";
  id: string;
  number: string;
  party: string;
  location: string;
  project: { id: string; code: string; name: string } | null;
  lines: { sourceLineId: string; item: { name: string; code: string; unit: string }; image?: string | null; brand: string; ordered: string; alreadyAccepted: string; expected: string }[];
};

type LineState = { received: string; damaged: string; rejected: string; remarks: string };
export type GrnHeader = { receiptDate: string; supplierChallanNo: string; supplierInvoiceNo: string; vehicleNo: string; receivedByName: string; remarks: string; latitude: string; longitude: string };

const QTY_RE = /^\d{1,11}(\.\d{1,3})?$/;
const safe = (v: string) => (QTY_RE.test(v.trim()) ? v.trim() : "0");

function accepted(l: LineState) {
  return subQty(subQty(safe(l.received), safe(l.damaged)), safe(l.rejected));
}

/** Mobile-first receipt form. One client key per form mount makes repeated taps / retries idempotent. */
export function GrnForm({ source, header, lines: initialLines, grnId, version }: { source: ReceiptSourceView; header: GrnHeader; lines?: Record<string, LineState>; grnId?: string; version?: number }) {
  const router = useRouter();
  const [clientKey] = useState(() => crypto.randomUUID());
  const [h, setH] = useState<GrnHeader>(header);
  const [lines, setLines] = useState<Record<string, LineState>>(() => initialLines ?? Object.fromEntries(source.lines.map((l) => [l.sourceLineId, { received: cmpQty(l.expected, "0") > 0 ? l.expected : "0", damaged: "0", rejected: "0", remarks: "" }])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);
  const [locating, setLocating] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const challan = source.kind === "challan";
  const setHead = (p: Partial<GrnHeader>) => {
    setDirty(true);
    setH((s) => ({ ...s, ...p }));
  };
  const setLine = (id: string, p: Partial<LineState>) => {
    setDirty(true);
    setLines((s) => ({ ...s, [id]: { ...s[id]!, ...p } }));
  };

  function captureLocation() {
    if (!navigator.geolocation) return toast.error("This device cannot share its location.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setHead({ latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) });
        toast.success("Location captured.");
      },
      () => {
        setLocating(false);
        toast.error("Location permission was denied. You can still save the receipt.");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  async function save(submit: boolean) {
    setBusy(submit ? "submit" : "draft");
    const payload = {
      clientKey,
      poId: challan ? null : source.id,
      challanId: challan ? source.id : null,
      ...h,
      submit,
      lines: source.lines.map((l) => {
        const x = lines[l.sourceLineId]!;
        return { poLineId: challan ? null : l.sourceLineId, challanLineId: challan ? l.sourceLineId : null, receivedQty: x.received.trim() || "0", damagedQty: x.damaged.trim() || "0", rejectedQty: challan ? "0" : x.rejected.trim() || "0", remarks: x.remarks };
      }),
    };
    const res = grnId ? await callAction(updateGrnAction, grnId, version!, payload) : await callAction(createGrnAction, payload);
    setBusy(null);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setDirty(false);
    toast.success(submit ? "Receipt confirmed — stock updated." : `Receipt saved — now add the material photos and the ${challan ? "signed challan" : "supplier's delivery challan"}, then confirm the receipt.`);
    router.push(`/site-receipts/${res.data.id}${submit ? "" : "#proof"}`);
  }

  const anyReceived = source.lines.some((l) => cmpQty(safe(lines[l.sourceLineId]!.received), "0") > 0);

  return (
    <form className="space-y-4 pb-28" noValidate onSubmit={(e) => e.preventDefault()}>
      <div className="rounded-xl border bg-card p-4 text-sm">
        <p className="text-xs text-muted-foreground">{challan ? "Receiving transfer challan — material photos and the signed challan are required to confirm the receipt" : "Receiving purchase order — material photos and the supplier's delivery challan are required to confirm the receipt"}</p>
        <p className="text-lg font-semibold">{source.number}</p>
        <p>
          From <span className="font-medium">{source.party}</span> → <span className="font-medium">{source.location}</span>
        </p>
        {source.project && (
          <p className="text-muted-foreground">
            Project {source.project.code} – {source.project.name}
          </p>
        )}
      </div>

      <section aria-labelledby="grn-lines" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="grn-lines" className="text-base font-semibold">
            What arrived?
          </h2>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => source.lines.forEach((l) => setLine(l.sourceLineId, { received: l.expected, damaged: "0", rejected: "0" }))}>
              <CheckCheck /> Everything arrived OK
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => source.lines.forEach((l) => setLine(l.sourceLineId, { received: "0", damaged: "0", rejected: "0" }))}>
              Clear all
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Enter what physically arrived. {challan ? "Damaged material goes to quarantine; anything short stays “in transit” until the store closes the challan." : "Only accepted quantity is added to site stock. Damaged or rejected material is recorded but not added."}
        </p>
        {source.lines.map((l, i) => {
          const x = lines[l.sourceLineId]!;
          const acc = accepted(x);
          const bad = cmpQty(acc, "0") < 0;
          const short = cmpQty(l.expected, safe(x.received)) > 0 && cmpQty(safe(x.received), "0") > 0;
          const over = cmpQty(safe(x.received), l.expected) > 0;
          const err = (f: string) => errors[`lines.${i}.${f}`];
          return (
            <div key={l.sourceLineId} className="rounded-xl border bg-card p-3 sm:p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="flex items-center gap-2 font-medium">
                  {l.image && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={l.image} alt="" className="size-9 rounded-md border bg-white object-contain" loading="lazy" />
                  )}
                  <span>{l.item.name} <span className="font-normal text-muted-foreground">· {l.brand}</span></span>
                </p>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 rounded-lg bg-muted/40 p-2 text-center text-xs">
                <div><dt className="text-muted-foreground">Ordered</dt><dd className="font-semibold tabular-nums">{formatQty(l.ordered)} {l.item.unit}</dd></div>
                <div><dt className="text-muted-foreground">Previously received</dt><dd className="font-semibold tabular-nums">{formatQty(l.alreadyAccepted)}</dd></div>
                <div><dt className="text-muted-foreground">Pending</dt><dd className="font-semibold tabular-nums text-foreground">{formatQty(l.expected)}</dd></div>
              </dl>
              <div className={`mt-3 grid gap-3 ${challan ? "grid-cols-2" : "grid-cols-3"}`}>
                <QtyBox id={`rcv-${i}`} label="Received today" unit={l.item.unit} value={x.received} onChange={(v) => setLine(l.sourceLineId, { received: v })} error={err("receivedQty")} />
                <QtyBox id={`dmg-${i}`} label={challan ? "Damaged" : "Damaged"} unit={l.item.unit} value={x.damaged} onChange={(v) => setLine(l.sourceLineId, { damaged: v })} error={err("damagedQty")} />
                {!challan && <QtyBox id={`rej-${i}`} label="Rejected" unit={l.item.unit} value={x.rejected} onChange={(v) => setLine(l.sourceLineId, { rejected: v })} error={err("rejectedQty")} />}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className={bad ? "font-medium text-destructive" : "font-medium text-emerald-700 dark:text-emerald-400"}>
                  {bad ? "Damaged + rejected is more than received" : `Accepted into stock: ${formatQty(acc)} ${l.item.unit}`}
                </span>
                {short && <span className="text-amber-700 dark:text-amber-400">Short by {formatQty(subQty(l.expected, safe(x.received)))}</span>}
                {over && <span className="text-amber-700 dark:text-amber-400">More than expected — check it against the order before confirming.</span>}
              </div>
              <Input aria-label={`${l.item.name} remarks`} className="mt-2" placeholder="Remarks (optional), e.g. 2 bags torn" value={x.remarks} onChange={(e) => setLine(l.sourceLineId, { remarks: e.target.value })} />
            </div>
          );
        })}
      </section>

      <FormSection title="Delivery details" description="Copy these from the supplier's challan / vehicle.">
        <Field id="grn-date" label="Receipt date" required error={errors.receiptDate}>
          <Input id="grn-date" type="date" className="h-11" value={h.receiptDate} onChange={(e) => setHead({ receiptDate: e.target.value })} />
        </Field>
        {!challan && (
          <Field id="grn-dc" label="Supplier challan reference" error={errors.supplierChallanNo}>
            <Input id="grn-dc" className="h-11" value={h.supplierChallanNo} onChange={(e) => setHead({ supplierChallanNo: e.target.value })} />
          </Field>
        )}
        <Field id="grn-by" label="Receiver name" error={errors.receivedByName}>
          <Input id="grn-by" className="h-11" value={h.receivedByName} onChange={(e) => setHead({ receivedByName: e.target.value })} />
        </Field>
        <details className="group sm:col-span-2">
          <summary className="cursor-pointer text-sm text-primary">More details (vehicle, supplier invoice, site location)</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {!challan && (
          <Field id="grn-inv" label="Supplier invoice no." help="If the invoice came with the material." error={errors.supplierInvoiceNo}>
            <Input id="grn-inv" className="h-11" value={h.supplierInvoiceNo} onChange={(e) => setHead({ supplierInvoiceNo: e.target.value })} />
          </Field>
        )}
        <Field id="grn-vehicle" label="Vehicle no." error={errors.vehicleNo}>
          <Input id="grn-vehicle" className="h-11 uppercase" autoCapitalize="characters" value={h.vehicleNo} onChange={(e) => setHead({ vehicleNo: e.target.value })} />
        </Field>
        <Field id="grn-gps" label="Site location (optional)" help="Proves the material was received at site.">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={captureLocation} disabled={locating}>
              {locating ? <Loader2 className="animate-spin" /> : <MapPin />} {h.latitude ? "Update location" : "Capture location"}
            </Button>
            {h.latitude && (
              <span className="text-xs text-muted-foreground">
                {h.latitude}, {h.longitude}
              </span>
            )}
          </div>
        </Field>
          </div>
        </details>
        <Field id="grn-remarks" label="Remarks" className="sm:col-span-2" error={errors.remarks}>
          <Textarea id="grn-remarks" rows={2} value={h.remarks} onChange={(e) => setHead({ remarks: e.target.value })} />
        </Field>
      </FormSection>

      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-2 border-t bg-background/95 p-3 backdrop-blur sm:sticky sm:mx-0 sm:justify-end sm:rounded-xl sm:border">
        <Button type="button" variant="outline" className="h-11 flex-1 sm:flex-none" disabled={!!busy || !anyReceived} onClick={() => save(false)}>
          {busy === "draft" ? <Loader2 className="animate-spin" /> : <Save />} Save draft
        </Button>
        {(
          <Button type="button" className="h-11 flex-1 sm:flex-none" disabled={!!busy || !anyReceived} onClick={() => save(false)} title="Photos and the supplier's challan are added on the next screen; the receipt is confirmed from there.">
            {busy === "draft" ? <Loader2 className="animate-spin" /> : <Camera />} Next: add photos
          </Button>
        )}
      </div>
    </form>
  );
}

function QtyBox({ id, label, unit, value, onChange, error }: { id: string; label: string; unit: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">
        {label} <span className="font-normal">({unit})</span>
      </label>
      <Input id={id} inputMode="decimal" className="h-12 text-right text-lg tabular-nums" value={value} onFocus={(e) => e.target.select()} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
