"use client";

import { Loader2, MoreHorizontal, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type ActionResultLike = { ok: true; data?: unknown } | { ok: false; error: string };

export type DocActionDef = {
  key: string;
  label: string;
  icon?: LucideIcon;
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost";
  /** Ask for confirmation; `note` adds a text box (required when `noteRequired`). */
  confirm?: { title: string; description: string; noteLabel?: string; noteRequired?: boolean; destructive?: boolean; confirmLabel?: string; input?: boolean };
  success: string;
  /** Force into the "More" menu (true) or keep as a visible button (false). Default: see `splitActions`. */
  more?: boolean;
};

/** A secondary page link shown in the "More" menu (plain data so server pages can pass it). */
export type MoreLink = { label: string; href: string };

/**
 * Simplified header: only the document's next step stays visible — actions marked `variant: "default"`
 * (or, when none is, the first non-destructive one). Everything else (cancel, close, amend, reject…) goes
 * into one "More" menu, so a page shows one or two buttons instead of a row of them.
 */
export function splitActions(actions: DocActionDef[]) {
  const pinned = new Set(actions.filter((a) => a.more === false || (a.more === undefined && a.variant === "default")).map((a) => a.key));
  if (!pinned.size) {
    const first = actions.find((a) => a.more !== true && !a.confirm?.destructive && a.variant !== "ghost" && a.variant !== "destructive");
    if (first) pinned.add(first.key);
  }
  return { visible: actions.filter((a) => pinned.has(a.key)), more: actions.filter((a) => !pinned.has(a.key)) };
}

/**
 * Status-workflow buttons for a document. `run` is provided by the module's client wrapper
 * and calls the module's server action; the server re-validates permission, state and version.
 */
export function DocActions({ actions, run, onDone, moreLinks: links = [] }: { actions: DocActionDef[]; run: (key: string, note: string | null) => Promise<ActionResultLike>; onDone?: (key: string, result: ActionResultLike) => void; moreLinks?: MoreLink[] }) {
  const moreLinks = links.filter((l, i) => links.findIndex((x) => x.href === l.href) === i);
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<DocActionDef | null>(null);
  const { visible, more } = splitActions(actions);

  async function exec(a: DocActionDef, n: string | null) {
    setBusy(a.key);
    const res = await run(a.key, n);
    setBusy(null);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    toast.success(a.success);
    setNote("");
    onDone?.(a.key, res);
    router.refresh();
    return true;
  }

  const start = (a: DocActionDef) => {
    if (a.confirm) {
      setNote("");
      setPending(a);
    } else void exec(a, null);
  };
  const c = pending?.confirm;

  return (
    <>
      {visible.map((a) => {
        const Icon = a.icon;
        return (
          <Button key={a.key} size="sm" variant={a.variant ?? "outline"} disabled={busy !== null} onClick={() => start(a)}>
            {busy === a.key ? <Loader2 className="animate-spin" /> : Icon ? <Icon /> : null}
            {a.label}
          </Button>
        );
      })}
      {more.length + moreLinks.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy !== null} aria-label="More actions">
              {busy && more.some((a) => a.key === busy) ? <Loader2 className="animate-spin" /> : <MoreHorizontal />} More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {moreLinks.map((l) => (
              <DropdownMenuItem key={l.href} asChild>
                <Link href={l.href}>{l.label}</Link>
              </DropdownMenuItem>
            ))}
            {moreLinks.length > 0 && more.length > 0 && <DropdownMenuSeparator />}
            {more.map((a) => {
              const Icon = a.icon;
              return (
                <DropdownMenuItem key={a.key} variant={a.confirm?.destructive || a.variant === "destructive" ? "destructive" : "default"} onSelect={() => start(a)}>
                  {Icon ? <Icon /> : null} {a.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={!!pending} onOpenChange={(o) => !o && busy === null && setPending(null)}>
        {pending && c && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{c.title}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2">
                  <p>{c.description}</p>
                  {c.noteLabel &&
                    (c.input ? (
                      <Input aria-label={c.noteLabel} placeholder={`${c.noteLabel}${c.noteRequired ? " (required)" : ""}`} value={note} onChange={(e) => setNote(e.target.value)} />
                    ) : (
                      <Textarea aria-label={c.noteLabel} rows={3} placeholder={`${c.noteLabel}${c.noteRequired ? " (required)" : ""}`} value={note} onChange={(e) => setNote(e.target.value)} />
                    ))}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant={c.destructive ? "destructive" : "default"}
                disabled={busy !== null}
                onClick={async (e) => {
                  e.preventDefault();
                  if (c.noteRequired && !note.trim()) {
                    toast.error(`${c.noteLabel} is required.`);
                    return;
                  }
                  if (await exec(pending, note.trim() || null)) setPending(null);
                }}
              >
                {busy === pending.key && <Loader2 className="animate-spin" />}
                {c.confirmLabel ?? pending.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
