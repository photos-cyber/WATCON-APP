"use client";

import { Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SingleSelect } from "@/components/forms/combobox";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { GST_STATES } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { setApprovalLimitAction, updateCommercialSettingsAction, updateSeriesAction } from "@/modules/settings/actions";

type Settings = { gstin: string | null; pan: string | null; stateCode: string | null; enforceSegregation: boolean; allowReceiptOnUnapprovedPo: boolean; billMatchMode: "TWO_WAY" | "THREE_WAY"; receiptTolerancePct: string; rateTolerancePct: string; poTerms: string | null; advanceDocument: "PROFORMA" | "TAX_INVOICE" };
type Series = { docType: string; label: string; prefix: string; width: number; includeFiscalYear: boolean };
type Limit = { roleKey: string; docType: string; maxAmount: string };

export function CommercialSettings({ settings, series, limits, roles, approvalDocTypes }: { settings: Settings; series: Series[]; limits: Limit[]; roles: { key: string; label: string }[]; approvalDocTypes: { key: string; label: string }[] }) {
  return (
    <div className="space-y-6">
      <PolicyForm initial={settings} />
      <SeriesTable rows={series} />
      <LimitsTable limits={limits} roles={roles} docTypes={approvalDocTypes} />
    </div>
  );
}

function PolicyForm({ initial }: { initial: Settings }) {
  const router = useRouter();
  const [v, setV] = useState({ ...initial, gstin: initial.gstin ?? "", pan: initial.pan ?? "", poTerms: initial.poTerms ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV((s) => ({ ...s, [k]: val }));
  async function save() {
    setBusy(true);
    const res = await callAction(updateCommercialSettingsAction, v);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
      return;
    }
    setErrors({});
    toast.success("Commercial settings saved.");
    router.refresh();
  }
  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-sm font-semibold">Company GST identity & commercial policy</h2>
      <p className="mb-4 text-xs text-muted-foreground">The company state decides CGST + SGST vs IGST on every document. Policy switches apply to new transactions immediately.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="cs-gstin" label="Company GSTIN" error={errors.gstin}>
          <Input id="cs-gstin" className="uppercase" maxLength={15} value={v.gstin} onChange={(e) => set("gstin", e.target.value)} />
        </Field>
        <Field id="cs-pan" label="PAN" error={errors.pan}>
          <Input id="cs-pan" className="uppercase" maxLength={10} value={v.pan} onChange={(e) => set("pan", e.target.value)} />
        </Field>
        <Field id="cs-state" label="State" error={errors.stateCode}>
          <SingleSelect id="cs-state" options={Object.entries(GST_STATES).map(([value, n]) => ({ value, label: `${value} – ${n}` }))} value={v.stateCode} onChange={(x) => set("stateCode", x)} placeholder="Select state" />
        </Field>
        <Field id="cs-match" label="Supplier bill matching" help="Three-way: bills are matched to accepted GRN quantities. Two-way: to PO quantities.">
          <Select value={v.billMatchMode} onValueChange={(x) => set("billMatchMode", x as Settings["billMatchMode"])}>
            <SelectTrigger id="cs-match" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="THREE_WAY">Three-way (PO → GRN → bill)</SelectItem>
              <SelectItem value="TWO_WAY">Two-way (PO → bill)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="cs-rtol" label="Over-receipt tolerance %" error={errors.receiptTolerancePct} help="Allowed receipt above PO quantity.">
          <Input id="cs-rtol" inputMode="decimal" value={v.receiptTolerancePct} onChange={(e) => set("receiptTolerancePct", e.target.value)} />
        </Field>
        <Field id="cs-adv" label="Advance milestones are billed as" help="Goods: GST is generally not payable on advances, so use a proforma and charge GST on the tax invoice. Services: GST is due on advances — use tax invoices. Confirm with your tax advisor.">
          <Select value={v.advanceDocument} onValueChange={(x) => set("advanceDocument", x as Settings["advanceDocument"])}>
            <SelectTrigger id="cs-adv" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PROFORMA">Proforma / advance request (not a tax invoice)</SelectItem>
              <SelectItem value="TAX_INVOICE">Tax invoice</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="cs-ratetol" label="Bill rate tolerance %" error={errors.rateTolerancePct} help="Allowed bill rate above PO rate.">
          <Input id="cs-ratetol" inputMode="decimal" value={v.rateTolerancePct} onChange={(e) => set("rateTolerancePct", e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={v.enforceSegregation} onCheckedChange={(x) => set("enforceSegregation", x === true)} className="mt-0.5" />
          <span>
            <span className="font-medium">Separation of duties</span>
            <span className="block text-xs text-muted-foreground">Approvers cannot approve documents they created or submitted, and evidence cannot be verified by its uploader. Recommended.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={v.allowReceiptOnUnapprovedPo} onCheckedChange={(x) => set("allowReceiptOnUnapprovedPo", x === true)} className="mt-0.5" />
          <span>
            <span className="font-medium">Exception: allow receipts against unapproved POs</span>
            <span className="block text-xs text-muted-foreground">Off by default. When on, GRNs may be recorded against submitted (not yet approved) POs.</span>
          </span>
        </label>
      </div>
      <Field id="cs-terms" label="Default purchase order terms & conditions" className="mt-4">
        <Textarea id="cs-terms" rows={5} value={v.poTerms} onChange={(e) => set("poTerms", e.target.value)} />
      </Field>
      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />} Save settings
        </Button>
      </div>
    </section>
  );
}

function SeriesRow({ row }: { row: Series }) {
  const router = useRouter();
  const [prefix, setPrefix] = useState(row.prefix);
  const [width, setWidth] = useState(String(row.width));
  const [fy, setFy] = useState(row.includeFiscalYear);
  const dirty = prefix !== row.prefix || width !== String(row.width) || fy !== row.includeFiscalYear;
  return (
    <tr>
      <td className="px-4 py-2">{row.label}</td>
      <td className="px-2 py-2">
        <Input aria-label={`${row.label} prefix`} className="h-8 w-28 uppercase" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
      </td>
      <td className="px-2 py-2">
        <Input aria-label={`${row.label} digits`} className="h-8 w-16" inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} />
      </td>
      <td className="px-2 py-2 text-center">
        <Checkbox aria-label={`${row.label} yearly reset`} checked={fy} onCheckedChange={(x) => setFy(x === true)} />
      </td>
      <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
        {prefix.toUpperCase()}
        {fy ? "/2026-27" : ""}/{"1".padStart(Number(width) || 4, "0")}
      </td>
      <td className="px-4 py-2 text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty}
          onClick={async () => {
            const res = await callAction(updateSeriesAction, { docType: row.docType, prefix, width, includeFiscalYear: fy });
            if (!res.ok) toast.error(res.fieldErrors?.prefix ?? res.error);
            else {
              toast.success(`${row.label} numbering saved.`);
              router.refresh();
            }
          }}
        >
          Save
        </Button>
      </td>
    </tr>
  );
}

function SeriesTable({ rows }: { rows: Series[] }) {
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold">Document numbering</h2>
        <p className="text-xs text-muted-foreground">Numbers are allocated atomically when a document is created. With yearly reset, each Indian financial year (April–March) starts again at 1.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Document</th>
              <th className="px-2 py-2 text-left font-medium">Prefix</th>
              <th className="px-2 py-2 text-left font-medium">Digits</th>
              <th className="px-2 py-2 text-center font-medium">Yearly reset</th>
              <th className="px-2 py-2 text-left font-medium">Example</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <SeriesRow key={r.docType} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LimitsTable({ limits, roles, docTypes }: { limits: Limit[]; roles: { key: string; label: string }[]; docTypes: { key: string; label: string }[] }) {
  const router = useRouter();
  const [role, setRole] = useState(roles[0]!.key);
  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold">Approval limits</h2>
          <p className="text-xs text-muted-foreground">Maximum document value a role may approve (holders of the approve permission). Blank = no limit. Super Admins have no limit.</p>
        </div>
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger className="w-52" aria-label="Role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((r) => (
              <SelectItem key={r.key} value={r.key}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="divide-y">
        {docTypes.map((d) => {
          const current = limits.find((l) => l.roleKey === role && l.docType === d.key)?.maxAmount ?? "";
          return (
            <li key={`${role}-${d.key}`} className="flex flex-wrap items-center gap-3 px-5 py-2 text-sm">
              <span className="w-56">{d.label}</span>
              <span className="w-36 text-xs text-muted-foreground">{current ? formatINR(current) : "No limit"}</span>
              <form
                className="ml-auto flex items-center gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const value = String(new FormData(e.currentTarget).get("amount") ?? "");
                  const res = await callAction(setApprovalLimitAction, { roleKey: role, docType: d.key, maxAmount: value });
                  if (!res.ok) toast.error(res.error);
                  else {
                    toast.success("Approval limit saved.");
                    router.refresh();
                  }
                }}
              >
                <Input name="amount" defaultValue={current} inputMode="decimal" placeholder="No limit" className="h-8 w-36" aria-label={`${d.label} limit`} />
                <Button size="sm" variant="outline" type="submit">
                  Set
                </Button>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
