"use client";

import { callAction } from "@/lib/call-action";
import { Loader2, Printer } from "lucide-react";
import { PdfButtons } from "@/components/documents/pdf-buttons";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { whatsappLink } from "@/lib/whatsapp";
import { whatsappShareAction } from "@/modules/reports/actions";

/**
 * Print / PDF / WhatsApp actions for a report. `params` identifies the report
 * (type, id and — for the global register — the active filters). The server
 * re-authorizes every request.
 */
export function ReportActions({ params, size = "sm", compact = false }: { params: Record<string, string>; size?: "sm" | "default"; compact?: boolean }) {
  const qs = new URLSearchParams(params).toString();
  const [loading, setLoading] = useState(false);
  const [share, setShare] = useState<{ text: string; phone: string; subject: string } | null>(null);

  async function openShare() {
    setLoading(true);
    let res: Awaited<ReturnType<typeof whatsappShareAction>>;
    try {
      res = await callAction(whatsappShareAction, params);
    } catch {
      // Network failure, expired session or a blocked request (e.g. by a browser extension).
      toast.error("Could not reach the server. Reload the page and try again.");
      return;
    } finally {
      setLoading(false);
    }
    if (!res.ok) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard reload intentionally drops client state after the session is gone
      if (res.code === "UNAUTHENTICATED") window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return toast.error(res.error);
    }
    setShare({ text: res.data.text, phone: res.data.phone ?? "", subject: res.data.subject });
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size={size} asChild>
          <a href={`/reports/print?${qs}`} target="_blank" rel="noopener">
            <Printer /> {!compact && "Print"}
            {compact && <span className="sr-only">Print</span>}
          </a>
        </Button>
        <PdfButtons href={`/api/reports/pdf?${qs}`} size={size} compact={compact} print={false} />
        <Button variant="outline" size={size} onClick={openShare} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <WhatsAppIcon />} {!compact && "WhatsApp"}
          {compact && <span className="sr-only">Share on WhatsApp</span>}
        </Button>
      </div>
      <Dialog open={share !== null} onOpenChange={(o) => !o && setShare(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Share on WhatsApp</DialogTitle>
            <DialogDescription>Review the summary. WhatsApp will open with this message — you confirm and send it there. Files cannot be attached through a link; use Export PDF for full details.</DialogDescription>
          </DialogHeader>
          {share && (
            <div className="space-y-3">
              <Field id="wa-phone" label="WhatsApp number" help="Optional. Leave empty to choose the chat in WhatsApp. 10-digit numbers are treated as Indian (+91).">
                <Input id="wa-phone" inputMode="tel" value={share.phone} onChange={(e) => setShare({ ...share, phone: e.target.value })} placeholder="+91 98xxxxxxxx" />
              </Field>
              <Field id="wa-text" label="Message">
                <Textarea id="wa-text" rows={10} value={share.text} onChange={(e) => setShare({ ...share, text: e.target.value })} className="max-h-[40dvh] min-h-40 [field-sizing:fixed] overflow-y-auto font-mono text-xs" />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShare(null)}>
              Cancel
            </Button>
            <Button asChild>
              <a href={share ? whatsappLink(share.text, share.phone) : "#"} target="_blank" rel="noopener noreferrer" onClick={() => setTimeout(() => setShare(null), 100)}>
                <WhatsAppIcon /> Open WhatsApp
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
