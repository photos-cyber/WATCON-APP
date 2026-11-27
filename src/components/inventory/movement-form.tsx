"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { SingleSelect } from "@/components/forms/combobox";
import { Field } from "@/components/forms/field";
import { FormDialog } from "@/components/shared/dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { formatQty } from "@/lib/format";
import { newId } from "@/lib/utils";
import { applyActionResult } from "@/lib/forms";
import { postStockMovementAction } from "@/modules/inventory/actions";
import { movementSchema, type MovementInput } from "@/modules/inventory/validation";

type Output = z.output<typeof movementSchema>;

export type PositionOption = { id: string; itemCode: string; itemName: string; brandName: string; unit: string; currentQty: string };
export type MovementLocation = { id: string; name: string; type: string; status: string };

function MovementForm({ positions, locations = [], canPost, canAdjust, today, presetId, onDone }: { positions: PositionOption[]; locations?: MovementLocation[]; canPost: boolean; canAdjust: boolean; today: string; presetId?: string; onDone: () => void }) {
  const router = useRouter();
  const form = useForm<MovementInput, unknown, Output>({
    resolver: zodResolver(movementSchema),
    defaultValues: {
      itemBrandId: presetId ?? "",
      locationId: null,
      type: canPost ? "INWARD" : "ADJUSTMENT",
      direction: null,
      quantity: "",
      txnDate: today,
      reference: "",
      remarks: "",
      reason: "",
      // One key per form instance: a double submit or retry can never post twice.
      idempotencyKey: newId(),
    },
  });
  const { errors, isSubmitting } = form.formState;
  const [type, itemBrandId] = useWatch({ control: form.control, name: ["type", "itemBrandId"] });
  const position = positions.find((p) => p.id === itemBrandId);
  const [evidence, setEvidence] = useState<File | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  async function onSubmit(values: Output) {
    if (!evidence) {
      setEvidenceError("Attach evidence: a photo, count sheet or document.");
      return;
    }
    const fd = new FormData();
    fd.set("input", JSON.stringify(values));
    fd.set("evidence", evidence);
    const res = await callAction(postStockMovementAction, fd);
    if (!applyActionResult(res, form.setError)) return;
    if (res.data.duplicate) toast.info(`Already posted as ${res.data.code}. Nothing was posted twice.`);
    else toast.success(`Posted ${res.data.code}. New balance: ${formatQty(res.data.balanceAfter)}${position ? ` ${position.unit}` : ""}`);
    onDone();
    router.refresh();
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <Field id="mv-position" label="Item – brand" required error={errors.itemBrandId?.message} help={position ? `Available: ${formatQty(position.currentQty)} ${position.unit}` : undefined}>
        <Controller
          control={form.control}
          name="itemBrandId"
          render={({ field }) => (
            <SingleSelect
              id="mv-position"
              options={positions.map((p) => ({ value: p.id, label: `${p.itemName} — ${p.brandName}`, hint: `${p.itemCode} · ${formatQty(p.currentQty)} ${p.unit}` }))}
              value={field.value || null}
              onChange={(v) => field.onChange(v ?? "")}
              placeholder="Select item and brand"
              searchPlaceholder="Search item, code or brand…"
              invalid={!!errors.itemBrandId}
              disabled={!!presetId}
              allowClear={false}
            />
          )}
        />
      </Field>
      {locations.length > 0 && (
        <Field id="mv-loc" label="Location" error={errors.locationId?.message} help="Blank = Central Warehouse. Totals shown above are company-wide; the location balance is checked when posting.">
          <Controller
            control={form.control}
            name="locationId"
            render={({ field }) => (
              <SingleSelect
                id="mv-loc"
                options={locations.filter((l) => l.status === "ACTIVE" && (l.type === "WAREHOUSE" || l.type === "SITE")).map((l) => ({ value: l.id, label: l.name, hint: l.type === "SITE" ? "Site store" : "Warehouse" }))}
                value={field.value ?? null}
                onChange={(v) => field.onChange(v)}
                placeholder="Central Warehouse"
              />
            )}
          />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="mv-type" label="Movement" required error={errors.type?.message}>
          <Controller
            control={form.control}
            name="type"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="mv-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {canPost && <SelectItem value="INWARD">Inward (received)</SelectItem>}
                  {canPost && <SelectItem value="OUTWARD">Outward (issued)</SelectItem>}
                  {canAdjust && <SelectItem value="ADJUSTMENT">Adjustment</SelectItem>}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        {type === "ADJUSTMENT" && (
          <Field id="mv-direction" label="Adjustment" required error={errors.direction?.message}>
            <Controller
              control={form.control}
              name="direction"
              render={({ field }) => (
                <Select value={field.value ?? ""} onValueChange={field.onChange}>
                  <SelectTrigger id="mv-direction" className="w-full" aria-invalid={!!errors.direction}>
                    <SelectValue placeholder="Increase or decrease" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IN">Increase stock</SelectItem>
                    <SelectItem value="OUT">Decrease stock</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="mv-qty" label={`Quantity${position ? ` (${position.unit})` : ""}`} required error={errors.quantity?.message}>
          <Input id="mv-qty" inputMode="decimal" autoComplete="off" aria-invalid={!!errors.quantity} {...form.register("quantity")} />
        </Field>
        <Field id="mv-date" label="Date" required error={errors.txnDate?.message}>
          <Input id="mv-date" type="date" max={today} aria-invalid={!!errors.txnDate} {...form.register("txnDate")} />
        </Field>
      </div>
      <Field id="mv-ref" label="Reference" error={errors.reference?.message} help="Bill, challan, indent or site reference.">
        <Input id="mv-ref" autoComplete="off" {...form.register("reference")} />
      </Field>
      <Field id="mv-reason" label="Reason" required error={errors.reason?.message} help="Why this manual change is needed (normal stock moves through receipts, challans and consumption).">
        <Textarea id="mv-reason" rows={2} aria-invalid={!!errors.reason} {...form.register("reason")} />
      </Field>
      <Field id="mv-evidence" label="Evidence" required error={evidenceError ?? undefined} help="Photo, count sheet or document (image or PDF). Kept permanently with the entry.">
        <Input id="mv-evidence" type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => { setEvidence(e.target.files?.[0] ?? null); setEvidenceError(null); }} />
      </Field>
      <Field id="mv-remarks" label="Remarks" error={errors.remarks?.message}>
        <Textarea id="mv-remarks" rows={2} {...form.register("remarks")} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Post
        </Button>
      </div>
    </form>
  );
}

export function PostMovementButton({ positions, locations, canPost, canAdjust, today, presetId, label = "Post stock", size = "default", variant = "default" }: { positions: PositionOption[]; locations?: MovementLocation[]; canPost: boolean; canAdjust: boolean; today: string; presetId?: string; label?: string; size?: "sm" | "default"; variant?: "default" | "outline" }) {
  if (!canPost && !canAdjust) return null;
  return (
    <FormDialog
      title="Manual stock change"
      description="Owner only. Needs a reason and evidence; updates the brand-wise balance immediately. Stock can never go below zero."
      trigger={
        <Button size={size} variant={variant}>
          <ArrowDownToLine /> {label}
        </Button>
      }
    >
      {(close) => <MovementForm positions={positions} locations={locations} canPost={canPost} canAdjust={canAdjust} today={today} presetId={presetId} onDone={close} />}
    </FormDialog>
  );
}
