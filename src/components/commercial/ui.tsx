import Link from "next/link";
import type { ReactNode } from "react";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";

/**
 * Shared commercial UI vocabulary: one status palette for every document type
 * (colour + text, never colour alone), money / quantity cells, detail grids, sections.
 */

type Tone = "neutral" | "info" | "warn" | "good" | "bad" | "muted" | "violet";

const TONES: Record<Tone, string> = {
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
  info: "border-blue-200 bg-blue-50 text-blue-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  bad: "border-rose-200 bg-rose-50 text-rose-700",
  muted: "border-zinc-200 bg-zinc-100 text-zinc-500",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
};

export const DOC_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  PENDING_APPROVAL: { label: "Pending approval", tone: "warn" },
  INTERNAL_REVIEW: { label: "Internal review", tone: "warn" },
  APPROVED: { label: "Approved", tone: "good" },
  REJECTED: { label: "Rejected", tone: "bad" },
  SENT: { label: "Sent", tone: "info" },
  ACKNOWLEDGED: { label: "Acknowledged", tone: "violet" },
  PARTIALLY_RECEIVED: { label: "Partially received", tone: "warn" },
  FULLY_RECEIVED: { label: "Fully received", tone: "good" },
  PARTIALLY_ORDERED: { label: "Partially ordered", tone: "warn" },
  ORDERED: { label: "Ordered", tone: "good" },
  PARTIALLY_FULFILLED: { label: "Partially fulfilled", tone: "warn" },
  FULFILLED: { label: "Fulfilled", tone: "good" },
  ACTIVE: { label: "Active", tone: "good" },
  INACTIVE: { label: "Inactive", tone: "muted" },
  OPEN: { label: "Open", tone: "info" },
  CLOSED: { label: "Closed", tone: "muted" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
  COMPLETED: { label: "Completed", tone: "good" },
  VERIFIED: { label: "Verified", tone: "good" },
  POSTED: { label: "Posted", tone: "good" },
  REVERSED: { label: "Reversed", tone: "muted" },
  DISPATCHED: { label: "In transit", tone: "violet" },
  RECEIVED: { label: "Received", tone: "good" },
  DELIVERED: { label: "Delivered", tone: "good" },
  DISCREPANCY: { label: "Discrepancy", tone: "bad" },
  RESPONSES_IN: { label: "Responses in", tone: "info" },
  AWARD_PENDING: { label: "Award pending", tone: "warn" },
  AWARDED: { label: "Awarded", tone: "good" },
  RECEIVED_QUOTE: { label: "Received", tone: "info" },
  SUPERSEDED: { label: "Superseded", tone: "muted" },
  CLIENT_CERTIFIED: { label: "Client certified", tone: "good" },
  PARTIALLY_CERTIFIED: { label: "Partially certified", tone: "warn" },
  DISPUTED: { label: "Disputed", tone: "bad" },
  INVOICED: { label: "Invoiced", tone: "violet" },
  ISSUED: { label: "Issued", tone: "info" },
  PARTIALLY_PAID: { label: "Partially paid", tone: "warn" },
  PAID: { label: "Paid", tone: "good" },
  UNPAID: { label: "Unpaid", tone: "bad" },
  OVERDUE: { label: "Overdue", tone: "bad" },
  RELEASED: { label: "Released", tone: "muted" },
  // MRP availability statuses
  AVAILABLE: { label: "Available", tone: "good" },
  LOW_STOCK: { label: "Low stock", tone: "warn" },
  SHORTAGE: { label: "Shortage", tone: "bad" },
  ALREADY_ORDERED: { label: "Already ordered", tone: "violet" },
  AWAITING_DELIVERY: { label: "Awaiting delivery", tone: "info" },
  DELAYED: { label: "Delayed", tone: "bad" },
  DAMAGED: { label: "Damaged / rejected", tone: "bad" },
  // Client quotations
  VIEWED: { label: "Viewed by client", tone: "violet" },
  ACCEPTED: { label: "Accepted", tone: "good" },
  EXPIRED: { label: "Expired", tone: "bad" },
  CONVERTED: { label: "Converted to SO", tone: "good" },
  // Payment milestones
  NOT_DUE: { label: "Not due yet", tone: "muted" },
  DUE: { label: "Due to invoice", tone: "warn" },
  PART_INVOICED: { label: "Part invoiced", tone: "info" },
  PART_PAID: { label: "Part paid", tone: "warn" },
  MATCHED: { label: "Matched", tone: "good" },
  EXCEPTION: { label: "Exceptions", tone: "bad" },
  NOT_MATCHED: { label: "Not matched", tone: "neutral" },
};

export function DocStatusBadge({ status, className, label }: { status: string; className?: string; label?: string }) {
  const s = DOC_STATUS[status] ?? { label: status.replace(/_/g, " ").toLowerCase(), tone: "neutral" as Tone };
  return <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[s.tone], className)}>{label ?? s.label}</span>;
}

export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

export function Money({ value, className, muted }: { value: string | null | undefined; className?: string; muted?: boolean }) {
  return <span className={cn("tabular-nums whitespace-nowrap", muted && "text-muted-foreground", className)}>{formatINR(value)}</span>;
}

export function Section({ title, actions, children, className, bodyClassName, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} className={cn("overflow-hidden rounded-xl border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function DetailGrid({ items, cols = 3 }: { items: { label: string; value: ReactNode; wide?: boolean }[]; cols?: 2 | 3 | 4 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-sm", cols === 2 ? "sm:grid-cols-2" : cols === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-4")}>
      {items.map((i) => (
        <div key={i.label} className={cn("min-w-0", i.wide && "sm:col-span-2 lg:col-span-full")}>
          <dt className="text-xs text-muted-foreground">{i.label}</dt>
          <dd className="mt-0.5 break-words whitespace-pre-line">{i.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Summary tiles; each one optionally links to the filtered records it counts. */
export function SummaryCards({ items }: { items: { label: string; value: ReactNode; hint?: ReactNode; href?: string; tone?: "default" | "warn" | "bad" | "good" }[] }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {items.map((i) => {
        const body = (
          <>
            <p className="text-xs text-muted-foreground">{i.label}</p>
            <p className={cn("mt-1 text-lg font-semibold tabular-nums", i.tone === "bad" && "text-rose-700", i.tone === "warn" && "text-amber-700", i.tone === "good" && "text-emerald-700")}>{i.value}</p>
            {i.hint && <p className="mt-0.5 text-xs text-muted-foreground">{i.hint}</p>}
          </>
        );
        return i.href ? (
          <Link key={i.label} href={i.href} className="rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/40 hover:bg-primary/[0.02]">
            {body}
          </Link>
        ) : (
          <div key={i.label} className="rounded-xl border bg-card p-3.5">
            {body}
          </div>
        );
      })}
    </div>
  );
}

/** Horizontal bar showing parts of a whole (e.g. ordered / received / pending). */
export function ProgressSegments({ total, segments, className }: { total: number; segments: { value: number; className: string; label: string }[]; className?: string }) {
  const safe = total > 0 ? total : 1;
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}>
        {segments.map((s) => (
          <div key={s.label} className={s.className} style={{ width: `${Math.min(100, Math.max(0, (s.value / safe) * 100))}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span className={cn("size-2 rounded-full", s.className)} aria-hidden /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
