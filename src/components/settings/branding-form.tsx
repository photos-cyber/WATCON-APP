"use client";

import { Loader2, Save, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { updateBrandingAction } from "@/modules/settings/actions";

type Branding = {
  website: string | null;
  officeAddress: string | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
  bankBranch: string | null;
  signatoryName: string | null;
  signatoryDesignation: string | null;
  signatureDataUrl: string | null;
  stampDataUrl: string | null;
  documentFooter: string | null;
};
type TextKey = Exclude<keyof Branding, "signatureDataUrl" | "stampDataUrl">;

/** Letterhead, bank, signatory and footer details printed on PDFs. */
export function BrandingForm({ initial }: { initial: Branding }) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const text = (k: TextKey) => ({ value: v[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value })) });

  function onImage(k: "signatureDataUrl" | "stampDataUrl", file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) return toast.error("Use a PNG or JPEG image.");
    if (file.size > 256 * 1024) return toast.error("Image must be 256 KB or smaller.");
    const reader = new FileReader();
    reader.onload = () => setV((s) => ({ ...s, [k]: String(reader.result) }));
    reader.readAsDataURL(file);
  }

  async function save() {
    setBusy(true);
    const res = await callAction(updateBrandingAction, v);
    setBusy(false);
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      return toast.error(res.error);
    }
    setErrors({});
    toast.success("Letterhead & document settings saved.");
    router.refresh();
  }

  const imageField = (k: "signatureDataUrl" | "stampDataUrl", label: string, help: string) => (
    <Field id={`b-${k}`} label={label} help={help} error={errors[k]}>
      <div className="flex items-center gap-3">
        {v[k] ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL preview
          <img src={v[k]!} alt={label} className="h-12 w-auto max-w-40 rounded border bg-white object-contain p-1" />
        ) : (
          <span className="flex h-12 w-24 items-center justify-center rounded border border-dashed text-xs text-muted-foreground">None</span>
        )}
        <Button type="button" variant="outline" size="sm" asChild>
          <label htmlFor={`b-${k}`} className="cursor-pointer">
            <Upload /> Upload
          </label>
        </Button>
        <input id={`b-${k}`} type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => onImage(k, e.target.files?.[0])} />
        {v[k] && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setV((s) => ({ ...s, [k]: null }))}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
    </Field>
  );

  return (
    <section className="mt-6 rounded-xl border bg-card p-5">
      <h2 className="text-sm font-semibold">Letterhead & documents</h2>
      <p className="mb-4 text-xs text-muted-foreground">Printed on purchase orders, invoices, challans and other PDFs. GSTIN, PAN and state come from Settings → Commercial.</p>
      <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
        <Field id="b-web" label="Website" error={errors.website}>
          <Input id="b-web" placeholder="www.example.com" {...text("website")} />
        </Field>
        <Field id="b-footer" label="Footer line on every page" error={errors.documentFooter} help="e.g. “Subject to Mumbai jurisdiction”. Optional.">
          <Input id="b-footer" {...text("documentFooter")} />
        </Field>
        <Field id="b-office" label="Office address (if different from registered address)" error={errors.officeAddress} className="sm:col-span-2">
          <Textarea id="b-office" rows={2} {...text("officeAddress")} />
        </Field>

        <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">Bank details — printed only on tax invoices</h3>
        <Field id="b-bank" label="Bank name" error={errors.bankName}>
          <Input id="b-bank" {...text("bankName")} />
        </Field>
        <Field id="b-acname" label="Account name" error={errors.bankAccountName}>
          <Input id="b-acname" {...text("bankAccountName")} />
        </Field>
        <Field id="b-acno" label="Account number" error={errors.bankAccountNo}>
          <Input id="b-acno" inputMode="numeric" {...text("bankAccountNo")} />
        </Field>
        <Field id="b-ifsc" label="IFSC" error={errors.bankIfsc}>
          <Input id="b-ifsc" className="uppercase" maxLength={11} {...text("bankIfsc")} />
        </Field>
        <Field id="b-branch" label="Branch" error={errors.bankBranch} className="sm:col-span-2">
          <Input id="b-branch" {...text("bankBranch")} />
        </Field>

        <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:col-span-2">Authorised signatory</h3>
        <Field id="b-sname" label="Name" error={errors.signatoryName}>
          <Input id="b-sname" {...text("signatoryName")} />
        </Field>
        <Field id="b-sdesig" label="Designation" error={errors.signatoryDesignation}>
          <Input id="b-sdesig" placeholder="e.g. Director" {...text("signatoryDesignation")} />
        </Field>
        {imageField("signatureDataUrl", "Signature image", "Printed only on approved / issued documents. PNG with transparent background works best.")}
        {imageField("stampDataUrl", "Company stamp", "Optional. Printed beside the signature on approved / issued documents.")}
      </div>
      <div className="mt-4">
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />} Save letterhead settings
        </Button>
      </div>
    </section>
  );
}
