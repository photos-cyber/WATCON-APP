"use client";

import { Eye, FileDown, Loader2, Printer } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type Busy = "download" | "print" | null;

/**
 * Preview / Download / Print for a server-generated PDF. All three use the same URL, so the
 * preview, the printed copy and the downloaded file are always the same, current document.
 */
export function PdfButtons({ href, size = "sm", compact = false, print = true }: { href: string; size?: "sm" | "default"; compact?: boolean; print?: boolean }) {
  const [busy, setBusy] = useState<Busy>(null);
  const withParam = (p: string) => `${href}${href.includes("?") ? "&" : "?"}${p}`;

  async function fetchPdf() {
    const res = await fetch(withParam("inline=1"), { cache: "no-store", credentials: "same-origin" });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/pdf")) {
      let msg = "Could not generate the PDF. Please try again.";
      if (res.status === 401) msg = "Your session has expired. Sign in again to download.";
      else if (res.status === 404) msg = "This document is not available to you.";
      else {
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* keep generic message */
        }
      }
      throw new Error(msg);
    }
    const name = res.headers.get("x-document-filename") ?? "document.pdf";
    return { blob: await res.blob(), name };
  }

  async function download() {
    setBusy("download");
    try {
      const { blob, name } = await fetchPdf();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast.success(`Downloaded ${name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(null);
    }
  }

  async function printPdf() {
    setBusy("print");
    try {
      const { blob } = await fetchPdf();
      const url = URL.createObjectURL(blob);
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
      frame.src = url;
      frame.onload = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          window.open(url, "_blank", "noopener");
        }
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 60_000);
      };
      document.body.appendChild(frame);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not print.");
    } finally {
      setBusy(null);
    }
  }

  const label = (text: string) => (compact ? <span className="sr-only">{text}</span> : text);
  return (
    <>
      <Button asChild size={size} variant="outline" title="Open the PDF in a new tab">
        <a href={withParam("inline=1")} target="_blank" rel="noopener">
          <Eye /> {label("Preview")}
        </a>
      </Button>
      <Button size={size} variant="outline" onClick={download} disabled={busy !== null} title="Download the PDF">
        {busy === "download" ? <Loader2 className="animate-spin" /> : <FileDown />} {label("Download")}
      </Button>
      {print && (
        <Button size={size} variant="outline" onClick={printPdf} disabled={busy !== null} title="Print the PDF">
          {busy === "print" ? <Loader2 className="animate-spin" /> : <Printer />} {label("Print")}
        </Button>
      )}
    </>
  );
}
