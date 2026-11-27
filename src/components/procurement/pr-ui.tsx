"use client";

import { Ban, CheckCircle2, FileSpreadsheet, Lock, Pencil, Send, ShoppingCart, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocActions, type DocActionDef } from "@/components/commercial/doc-actions";
import { LinesEditor, emptyLine, type EditableLine, type ItemBrandOpt } from "@/components/commercial/lines-editor";
import { SingleSelect } from "@/components/forms/combobox";
import { Field, FormSection } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedWarning } from "@/hooks/use-unsaved-warning";
import { callAction } from "@/lib/call-action";
import { createPrAction, prActionAction, updatePrAction } from "@/modules/procurement/actions";
import type { LocOpt, ProjectOpt } from "./po-form";

export type PrFormValues = { projectId: string | null; deliveryLocationId: string | null; requiredBy: string; purpose: string; lines: EditableLine[] };

export function PrForm({ initial, prId, version, lockProject = false, projects, locations, options }: { initial: PrFormValues; prId?: string; version?: number; lockProject?: boolean; projects: ProjectOpt[]; locations: LocOpt[]; options: ItemBrandOpt[] }) {
  const router = useRouter();
  const siteOf = (pid: string | null) => locations.find((l) => l.type === "SITE" && l.status === "ACTIVE" && l.projectId === pid)?.id ?? null;
  const [v, setV] = useState<PrFormValues>({ ...initial, deliveryLocationId: initial.deliveryLocationId ?? siteOf(initial.projectId), lines: initial.lines.length ? initial.lines : [emptyLine()] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedWarning(dirty && !busy);
  const set = (p: Partial<PrFormValues>) => {
    setDirty(true);
    setV((s) => ({ ...s, ...p }));
  };
  const locs = locations.filter((l) => l.status === "ACTIVE" && (l.type === "WAREHOUSE" || (l.type === "SITE" && l.projectId === v.projectId)));
  return (
    <form
      className="space-y-4 pb-20"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const payload = { ...v, lines: v.lines.map((l) => ({ itemBrandId: l.itemBrandId, quantity: l.quantity, notes: l.description, requirementId: l.links?.requirementId ?? null })) };
        const res = prId ? await callAction(updatePrAction, prId, version!, payload) : await callAction(createPrAction, payload);
        setBusy(false);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error);
          return;
        }
        setDirty(false);
        toast.success("Requisition saved as draft.");
        router.push(`/purchase-requisitions/${res.data.id}`);
      }}
    >
      <FormSection title="Requisition" description="Which project needs what, where, and by when.">
        <Field id="pr-project" label="Project" required error={errors.projectId}>
          {lockProject && projects.find((p) => p.id === v.projectId) ? (
            <p className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-medium">
              {projects.find((p) => p.id === v.projectId)!.code} – {projects.find((p) => p.id === v.projectId)!.name}
            </p>
          ) : (
            <SingleSelect id="pr-project" options={projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }))} value={v.projectId} onChange={(x) => set({ projectId: x, deliveryLocationId: siteOf(x) })} allowClear={false} placeholder="Select project" invalid={!!errors.projectId} />
          )}
        </Field>
        <Field id="pr-loc" label="Deliver to" error={errors.deliveryLocationId}>
          <SingleSelect id="pr-loc" options={locs.map((l) => ({ value: l.id, label: l.name, hint: l.type === "SITE" ? "Site store" : "Warehouse" }))} value={v.deliveryLocationId} onChange={(x) => set({ deliveryLocationId: x })} placeholder={v.projectId ? "Project site store" : "Select the project first"} />
        </Field>
        <Field id="pr-by" label="Required by" error={errors.requiredBy}>
          <Input id="pr-by" type="date" value={v.requiredBy} onChange={(e) => set({ requiredBy: e.target.value })} />
        </Field>
        <Field id="pr-purpose" label="Purpose / justification" error={errors.purpose} className="sm:col-span-2">
          <Textarea id="pr-purpose" rows={2} value={v.purpose} onChange={(e) => set({ purpose: e.target.value })} />
        </Field>
      </FormSection>
      <LinesEditor lines={v.lines} onChange={(lines) => set({ lines })} options={options} mode="INTRA" priced={false} errors={errors} />
      <div className="sticky bottom-0 z-10 -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Save draft
        </Button>
      </div>
    </form>
  );
}

type PrCan = { edit: boolean; submit: boolean; approve: boolean; approveBlockedReason: string | null; cancel: boolean; close: boolean; rfq: boolean; po: boolean };

export function PrActions({ id, version, can }: { id: string; version: number; can: PrCan }) {
  const defs: DocActionDef[] = [];
  if (can.submit) defs.push({ key: "submit", label: "Finalize", icon: Send, variant: "default", success: "Requisition finalized — purchasing can order it." });
  if (can.approve) {
    defs.push({ key: "approve", label: "Finalize", icon: ThumbsUp, variant: "default", confirm: { title: "Finalize this requisition?", description: "Purchasing can then request rates and raise purchase orders." }, success: "Requisition finalized." });
    defs.push({ key: "reject", label: "Return for changes", icon: ThumbsDown, confirm: { title: "Return this requisition?", description: "It goes back to the requester.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Returned to the requester." });
  }
  if (can.close) defs.push({ key: "close", label: "Close", icon: Lock, confirm: { title: "Close this requisition?", description: "Remaining unordered quantities will no longer be considered open.", noteLabel: "Reason", noteRequired: false }, success: "Requisition closed." });
  if (can.cancel) defs.push({ key: "cancel", label: "Cancel", icon: Ban, variant: "ghost", confirm: { title: "Cancel this requisition?", description: "This cannot be undone.", noteLabel: "Reason", noteRequired: true, destructive: true }, success: "Requisition cancelled." });
  return (
    <>
      {can.edit && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/purchase-requisitions/${id}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      )}
      {can.rfq && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/rate-enquiries/new?prId=${id}`}>
            <FileSpreadsheet /> Request rates
          </Link>
        </Button>
      )}
      {can.po && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/purchase-orders/new?prId=${id}`}>
            <ShoppingCart /> Create PO
          </Link>
        </Button>
      )}
      <DocActions actions={defs} run={(key, note) => callAction(prActionAction, id, key as never, { version, note })} />
      {can.approveBlockedReason && <span className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCircle2 className="size-3" />{can.approveBlockedReason}</span>}
    </>
  );
}
