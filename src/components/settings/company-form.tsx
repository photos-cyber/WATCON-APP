"use client";

import { callAction } from "@/lib/call-action";
import { Loader2, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { updateCompanyAction } from "@/modules/settings/actions";

type Company = { name: string; legalName: string; address: string; phone: string; email: string; logoDataUrl: string | null };

export function CompanyForm({ initial }: { initial: Company }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function onLogo(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg"].includes(file.type)) return toast.error("Logo must be a PNG or JPEG image.");
    if (file.size > 256 * 1024) return toast.error("Logo must be 256 KB or smaller.");
    const reader = new FileReader();
    reader.onload = () => setV((s) => ({ ...s, logoDataUrl: String(reader.result) }));
    reader.readAsDataURL(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const res = await callAction(updateCompanyAction, v);
    setBusy(false);
    if (res.ok) toast.success("Company settings saved");
    else {
      setErrors(res.fieldErrors ?? {});
      toast.error(res.error);
    }
  }

  const set = (k: keyof Company) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4 sm:grid-cols-2" noValidate>
      <Field id="c-name" label="Company name" required error={errors.name}>
        <Input id="c-name" value={v.name} onChange={set("name")} />
      </Field>
      <Field id="c-legal" label="Legal name" error={errors.legalName}>
        <Input id="c-legal" value={v.legalName} onChange={set("legalName")} />
      </Field>
      <Field id="c-address" label="Address" error={errors.address} className="sm:col-span-2">
        <Textarea id="c-address" rows={2} value={v.address} onChange={set("address")} />
      </Field>
      <Field id="c-phone" label="Phone" error={errors.phone}>
        <Input id="c-phone" value={v.phone} onChange={set("phone")} />
      </Field>
      <Field id="c-email" label="Email" error={errors.email}>
        <Input id="c-email" type="email" value={v.email} onChange={set("email")} />
      </Field>
      <Field id="c-logo" label="Logo (used on printed reports and PDFs)" help="PNG or JPEG, up to 256 KB. A wide logo on a transparent or white background prints best. Without an upload, PDFs use the standard WATCON logo." error={errors.logoDataUrl} className="sm:col-span-2">
        <div className="flex items-center gap-3">
          {v.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL preview
            <img src={v.logoDataUrl} alt="Company logo" className="h-12 w-auto max-w-40 rounded border bg-white object-contain p-1" />
          ) : (
            <span className="flex h-12 w-24 items-center justify-center rounded border border-dashed text-xs text-muted-foreground">No logo</span>
          )}
          <Button type="button" variant="outline" size="sm" asChild>
            <label htmlFor="c-logo" className="cursor-pointer">
              <Upload /> Upload
            </label>
          </Button>
          <input id="c-logo" type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => onLogo(e.target.files?.[0])} />
          {v.logoDataUrl && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setV((s) => ({ ...s, logoDataUrl: null }))}>
              <Trash2 /> Remove
            </Button>
          )}
        </div>
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Save company settings
        </Button>
      </div>
    </form>
  );
}
