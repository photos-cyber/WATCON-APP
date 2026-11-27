"use client";

import { Camera, CheckCircle2, CircleAlert, FileText, Loader2, Paperclip, RotateCw, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProofStatus } from "@/modules/stores/proof-rules";

type Slot = ProofStatus["required"][number];
type Upload = { key: string; file: File; preview: string | null; progress: number; state: "uploading" | "failed" | "done"; error?: string };

/**
 * Mandatory receiving proof: one box per required document (material photos, supplier challan,
 * damage evidence). Camera capture on phones, previews, per-file progress, retry on failure. The
 * server re-checks the same rules on submit and post, so this is guidance, not the guard.
 */
export function ReceiptProof({ grnId, proof, editable, maxUploadMb }: { grnId: string; proof: ProofStatus; editable: boolean; maxUploadMb: number }) {
  if (!proof.required.length) return null;
  return (
    <section id="proof" className="space-y-3 rounded-xl border bg-card p-4" aria-labelledby="proof-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="proof-title" className="text-base font-semibold">Mandatory proof</h2>
        {proof.complete ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-4" /> All proof uploaded</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-amber-700 dark:text-amber-400"><CircleAlert className="size-4" /> {proof.missing.length} still needed</span>
        )}
      </div>
      {!proof.complete && editable && <p className="text-sm text-muted-foreground">The receipt can be saved as a draft any time, but it can only be confirmed once every box below has a file.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {proof.required.map((s) => (
          <SlotBox key={s.key} grnId={grnId} slot={s} editable={editable} maxUploadMb={maxUploadMb} />
        ))}
      </div>
    </section>
  );
}

function SlotBox({ grnId, slot, editable, maxUploadMb }: { grnId: string; slot: Slot; editable: boolean; maxUploadMb: number }) {
  const router = useRouter();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const patch = (key: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  useEffect(() => () => uploads.forEach((u) => u.preview && URL.revokeObjectURL(u.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  function send(u: Upload) {
    patch(u.key, { state: "uploading", progress: 0, error: undefined });
    const fd = new FormData();
    fd.set("file", u.file);
    fd.set("entityType", "grn");
    fd.set("entityId", grnId);
    fd.set("category", slot.uploadCategory);
    if (u.file.lastModified) fd.set("capturedAt", new Date(u.file.lastModified).toISOString());
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/attachments");
    xhr.upload.onprogress = (e) => e.lengthComputable && patch(u.key, { progress: Math.round((e.loaded / e.total) * 100) });
    xhr.onload = () => {
      let json: { ok?: boolean; error?: string } = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON */
      }
      if (xhr.status < 300 && json.ok) {
        patch(u.key, { state: "done", progress: 100 });
        router.refresh();
      } else patch(u.key, { state: "failed", error: json.error ?? `Upload failed (${xhr.status}).` });
    };
    xhr.onerror = () => patch(u.key, { state: "failed", error: "Network error — check the connection and retry." });
    xhr.send(fd);
  }

  function pick(list: FileList | null) {
    if (!list?.length) return;
    const next: Upload[] = Array.from(list).map((file) => {
      const tooBig = file.size > maxUploadMb * 1048576;
      const wrong = slot.imageOnly && !file.type.startsWith("image/");
      return { key: crypto.randomUUID(), file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null, progress: 0, state: tooBig || wrong ? "failed" : "uploading", error: tooBig ? `Larger than ${maxUploadMb} MB.` : wrong ? "Must be a photo." : undefined };
    });
    setUploads((u) => [...u, ...next]);
    next.filter((u) => u.state === "uploading").forEach(send);
    if (fileRef.current) fileRef.current.value = "";
    if (camRef.current) camRef.current.value = "";
  }

  const pending = uploads.filter((u) => u.state !== "done");
  return (
    <div className={cn("space-y-2 rounded-lg border p-3", slot.met ? "border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20" : "border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/20")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{slot.label} <span className="text-destructive">*</span></p>
          <p className="text-xs text-muted-foreground">{slot.help}</p>
        </div>
        {slot.met ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" aria-label="Uploaded" /> : <CircleAlert className="size-5 shrink-0 text-amber-600" aria-label="Missing" />}
      </div>
      {slot.files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {slot.files.map((f) => (
            <li key={f.id}>
              <a href={`/api/attachments/${f.id}?inline=1`} target="_blank" rel="noreferrer" title={f.fileName} className="block">
                {f.mimeType.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/attachments/${f.id}?inline=1`} alt={f.fileName} className="size-16 rounded-md border object-cover" loading="lazy" />
                ) : (
                  <span className="flex size-16 flex-col items-center justify-center gap-1 rounded-md border bg-background text-[10px] text-muted-foreground"><FileText className="size-5" />PDF</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      {pending.length > 0 && (
        <ul className="space-y-1.5">
          {pending.map((u) => (
            <li key={u.key} className="flex items-center gap-2 rounded-md border bg-background p-1.5">
              {u.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={u.preview} alt="" className="size-10 rounded object-cover" />
              ) : (
                <span className="flex size-10 items-center justify-center rounded bg-muted"><FileText className="size-4" /></span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">{u.file.name}</p>
                {u.state === "uploading" ? (
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuenow={u.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${u.file.name}`}>
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${u.progress}%` }} />
                  </div>
                ) : (
                  <p className="text-xs text-destructive">{u.error}</p>
                )}
              </div>
              {u.state === "uploading" ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  {u.error !== "Must be a photo." && !u.error?.startsWith("Larger") && (
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Retry ${u.file.name}`} onClick={() => send(u)}><RotateCw /></Button>
                  )}
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${u.file.name}`} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}><X /></Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => camRef.current?.click()}><Camera /> Take photo</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Paperclip /> Choose {slot.imageOnly ? "photos" : "file"}</Button>
          <input ref={camRef} type="file" accept="image/*" capture="environment" className="sr-only" aria-label={`Take photo for ${slot.label}`} onChange={(e) => pick(e.target.files)} />
          <input ref={fileRef} type="file" accept={slot.accept} multiple className="sr-only" aria-label={`Choose files for ${slot.label}`} onChange={(e) => pick(e.target.files)} />
        </div>
      )}
    </div>
  );
}
