"use client";

import { ChevronDown, Eye, FileDown, FileText, Loader2, Mail, Printer } from "lucide-react";
import { WhatsAppIcon } from "@/components/icons/whatsapp-icon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { whatsappLink } from "@/lib/whatsapp";
import { usePdfActions } from "./pdf-buttons";

/**
 * One "PDF & share" menu for a commercial document: preview, download, print, WhatsApp, email. WhatsApp and
 * email open the user's own app with a prefilled message — the app never claims anything was sent (attach the
 * downloaded PDF manually).
 */
export function DocShare({ type, id, summary, phone, email, subject }: { type: string; id: string; summary: string; phone?: string | null; email?: string | null; subject: string }) {
  const { busy, previewHref, download, printPdf } = usePdfActions(`/api/documents/pdf?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" disabled={busy !== null}>
          {busy ? <Loader2 className="animate-spin" /> : <FileText />} PDF &amp; share <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem asChild>
          <a href={previewHref} target="_blank" rel="noopener">
            <Eye /> Preview
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download()}>
          <FileDown /> Download
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void printPdf()}>
          <Printer /> Print
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild title="Opens WhatsApp with a prefilled message. Attach the downloaded PDF before sending.">
          <a href={whatsappLink(summary, phone)} target="_blank" rel="noopener noreferrer">
            <WhatsAppIcon className="size-4" /> WhatsApp
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild title="Opens your email app. Attach the downloaded PDF before sending.">
          <a href={`mailto:${email ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(summary)}`}>
            <Mail /> Email
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
