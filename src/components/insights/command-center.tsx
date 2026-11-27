import { AlertTriangle, ArrowRight, CheckCircle2, Circle, CircleDot, Info } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ToneBadge } from "@/components/commercial/ui";
import { Button } from "@/components/ui/button";
import { formatINR, formatINRCompact } from "@/lib/money";
import { cn } from "@/lib/utils";

export type FlowStepView = { n: number; key: string; title: string; summary: string; state: "done" | "active" | "todo"; tab: string; action: { label: string; href: string } | null; optional?: boolean };

/** The sales-order-driven order flow: numbered steps with live status and the next action. */
export function OrderFlow({ steps, projectId }: { steps: FlowStepView[]; projectId: string }) {
  // Optional steps (client quotation / PO) are shown but never picked as "Next".
  const next = steps.find((s) => s.state !== "done" && !s.optional);
  return (
    <section aria-labelledby="order-flow" className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 id="order-flow" className="text-sm font-semibold">
            Order flow
          </h2>
          <p className="text-xs text-muted-foreground">Everything in this project follows its sales order. Steps marked optional can be skipped.</p>
        </div>
        {next?.action && (
          <Button asChild size="sm">
            <Link href={next.action.href}>
              Next: {next.action.label} <ArrowRight />
            </Link>
          </Button>
        )}
      </div>
      <ol className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s) => {
          const Icon = s.state === "done" ? CheckCircle2 : s.state === "active" ? CircleDot : Circle;
          return (
            <li key={s.key} className={cn("flex flex-col gap-2 bg-card p-4", next?.key === s.key && "bg-primary/[0.03]")}>
              <div className="flex items-start gap-2">
                <Icon className={cn("mt-0.5 size-4 shrink-0", s.state === "done" ? "text-emerald-600" : s.state === "active" ? "text-primary" : "text-muted-foreground/50")} aria-hidden />
                <div className="min-w-0">
                  <Link href={`/projects/${projectId}?tab=${s.tab}`} className="text-sm font-medium hover:text-primary hover:underline">
                    {s.n}. {s.title}
                  </Link>
                  {s.optional && <span className="ml-1.5 rounded border px-1 py-px align-middle text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Optional</span>}
                  <p className="text-xs text-muted-foreground">{s.summary}</p>
                  <span className="sr-only">{s.state === "done" ? "Done" : s.state === "active" ? "In progress" : "Not started"}</span>
                </div>
              </div>
              {s.action && (
                <Link href={s.action.href} className="mt-auto inline-flex items-center gap-1 pl-6 text-xs font-medium text-primary hover:underline">
                  {s.action.label} <ArrowRight className="size-3" />
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export type Kpi = { label: string; value: string; help: string; tone?: "good" | "bad" | "warn"; compact?: boolean; href?: string };

/** Money KPI tiles. Each definition is visible on hover and listed under “How these are calculated”. */
export function KpiGrid({ title, kpis }: { title: string; kpis: Kpi[] }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {kpis.map((k) => {
          const body = (
            <>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {k.label} <Info className="size-3 opacity-60" aria-hidden />
              </p>
              <p className={cn("mt-1 text-lg font-semibold tabular-nums", k.tone === "bad" && "text-rose-700", k.tone === "warn" && "text-amber-700", k.tone === "good" && "text-emerald-700")}>{k.compact === false ? formatINR(k.value) : formatINRCompact(k.value)}</p>
              <span className="sr-only">{k.help}</span>
            </>
          );
          return k.href ? (
            <Link key={k.label} href={k.href} title={k.help} className="rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/40">
              {body}
            </Link>
          ) : (
            <div key={k.label} title={k.help} className="rounded-xl border bg-card p-3.5">
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function KpiDefinitions({ items }: { items: { label: string; help: string }[] }) {
  return (
    <details className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">How these figures are calculated</summary>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.label}>
            <dt className="text-xs font-medium">{i.label}</dt>
            <dd className="text-xs text-muted-foreground">{i.help}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export type AttentionView = { key: string; tone: "bad" | "warn" | "info"; title: string; detail: string; href: string };

export function NeedsAttention({ items, empty = "Nothing needs attention right now." }: { items: AttentionView[]; empty?: string }) {
  return (
    <section aria-labelledby="attention" className="rounded-xl border bg-card">
      <h2 id="attention" className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        <AlertTriangle className="size-4 text-amber-600" aria-hidden /> Needs attention
        {items.length > 0 && <ToneBadge tone="warn">{items.length}</ToneBadge>}
      </h2>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> {empty}
        </p>
      ) : (
        <ul className="divide-y">
          {items.slice(0, 15).map((i) => (
            <li key={i.key}>
              <Link href={i.href} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", i.tone === "bad" ? "bg-rose-500" : i.tone === "warn" ? "bg-amber-500" : "bg-blue-500")} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{i.title}</span>
                  <span className="block text-xs text-muted-foreground">{i.detail}</span>
                </span>
                <ArrowRight className="ml-auto size-4 shrink-0 self-center text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function MiniStat({ label, value, tone, href }: { label: string; value: ReactNode; tone?: "bad" | "warn" | "good"; href?: string }) {
  const body = (
    <>
      <dd className={cn("text-lg font-semibold tabular-nums", tone === "bad" && "text-rose-700", tone === "warn" && "text-amber-700", tone === "good" && "text-emerald-700")}>{value}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </>
  );
  return href ? (
    <Link href={href} className="rounded-lg bg-muted/50 px-3 py-2 hover:bg-muted">
      {body}
    </Link>
  ) : (
    <div className="rounded-lg bg-muted/50 px-3 py-2">{body}</div>
  );
}

/** Project "Action required": one card per next job; every card opens the filtered records it counts. */
export function ActionRequired({ cards }: { cards: { key: string; label: string; count: number; amount?: string | null; detail: string; href: string; tone: "action" | "warn" | "bad" | "done" }[] }) {
  if (!cards.length) return null;
  const tone = { action: "border-primary/40 bg-primary/[0.04]", warn: "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20", bad: "border-rose-300 bg-rose-50/60 dark:border-rose-800 dark:bg-rose-950/20", done: "bg-card" } as const;
  return (
    <section aria-labelledby="action-required" className="space-y-2">
      <h2 id="action-required" className="text-sm font-semibold">Action required</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {cards.map((c) => (
          <Link key={c.key} href={c.href} className={cn("flex flex-col rounded-xl border p-3 transition-colors hover:border-primary", tone[c.tone])}>
            <span className="text-xs text-muted-foreground">{c.label}</span>
            <span className={cn("text-2xl font-semibold tabular-nums", c.tone === "done" && "text-muted-foreground")}>{c.key === "client" ? formatINR(c.amount ?? "0") : c.count}</span>
            {c.amount && c.key !== "client" && <span className="text-xs tabular-nums text-muted-foreground">{formatINR(c.amount)}</span>}
            <span className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.detail}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
