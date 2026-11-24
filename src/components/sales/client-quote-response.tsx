"use client";

import { CheckCircle2, Loader2, Mail, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/call-action";
import { acceptQuotationAction, rejectQuotationAction, requestAcceptanceCodeAction } from "@/modules/sales/quotation-public-actions";

/** Client-side accept (verified with an emailed one-time code) or decline. */
export function ClientQuoteResponse({ token, emailOnFile }: { token: string; emailOnFile: string | null }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "accept" | "decline">("idle");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [v, setV] = useState({ code: "", name: "", role: "", note: "", reason: "" });
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    setBusy(true);
    const res = await callAction(requestAcceptanceCodeAction, token);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setSentTo(res.data.sentTo);
    toast.success(`Code sent to ${res.data.sentTo}`);
  }
  async function accept() {
    setBusy(true);
    const res = await callAction(acceptQuotationAction, token, { code: v.code, name: v.name, role: v.role, note: v.note });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Thank you — your acceptance is recorded.");
    router.refresh();
  }
  async function decline() {
    setBusy(true);
    const res = await callAction(rejectQuotationAction, token, { name: v.name, reason: v.reason });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Your response is recorded. Thank you.");
    router.refresh();
  }

  if (mode === "idle")
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" onClick={() => setMode("accept")}>
          <CheckCircle2 /> Accept quotation
        </Button>
        <Button size="lg" variant="outline" onClick={() => setMode("decline")}>
          <XCircle /> Decline
        </Button>
      </div>
    );

  if (mode === "decline")
    return (
      <div className="space-y-3">
        <Input placeholder="Your name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <Textarea rows={3} placeholder="Reason (helps us revise the offer)" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} />
        <div className="flex gap-2">
          <Button variant="destructive" onClick={decline} disabled={busy || !v.name || !v.reason}>
            {busy && <Loader2 className="animate-spin" />} Decline quotation
          </Button>
          <Button variant="ghost" onClick={() => setMode("idle")}>
            Back
          </Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-3">
      {!emailOnFile ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">We have no email address on file for your company, so online acceptance is not available. Please confirm acceptance with our team directly.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">To confirm it is you, we will email a 6-digit code to the address we have on file for your company ({emailOnFile}).</p>
          <Button variant="outline" onClick={sendCode} disabled={busy}>
            {busy && !sentTo ? <Loader2 className="animate-spin" /> : <Mail />} {sentTo ? "Send a new code" : "Email me the code"}
          </Button>
          {sentTo && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.replace(/\D/g, "") })} />
              <Input placeholder="Your full name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
              <Input placeholder="Designation (optional)" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} />
              <Input placeholder="Remarks (optional)" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
              <p className="text-xs text-muted-foreground sm:col-span-2">By accepting you agree to the items, prices, payment schedule and terms shown on this quotation. Your name, time and IP address are recorded.</p>
              <Button className="sm:col-span-2" size="lg" onClick={accept} disabled={busy || v.code.length !== 6 || v.name.length < 2}>
                {busy && <Loader2 className="animate-spin" />} Confirm acceptance
              </Button>
            </div>
          )}
        </>
      )}
      <Button variant="ghost" onClick={() => setMode("idle")}>
        Back
      </Button>
    </div>
  );
}
