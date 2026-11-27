import { HandCoins } from "lucide-react";
import Link from "next/link";
import { Section } from "@/components/commercial/ui";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { cmpMoney, formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { ClientAccount } from "@/modules/sales/client-account";

/** The one "Record client payment" entry point used across projects, orders, bills, invoices and accounts. */
export function RecordClientPaymentButton({ projectId, partyId, invoiceId, soId, label = "Record client payment", size = "sm", variant = "outline" }: { projectId?: string | null; partyId?: string | null; invoiceId?: string | null; soId?: string | null; label?: string; size?: "sm" | "default"; variant?: "outline" | "default" }) {
  const qs = new URLSearchParams({ direction: "IN" });
  if (projectId) qs.set("projectId", projectId);
  if (partyId) qs.set("partyId", partyId);
  if (invoiceId) qs.set("invoiceId", invoiceId);
  if (soId) qs.set("soId", soId);
  return (
    <Button asChild size={size} variant={variant}>
      <Link href={`/payments/new?${qs}`}>
        <HandCoins /> {label}
      </Link>
    </Button>
  );
}

/** Contract → billed → received → outstanding / unbilled / advances / overdue, plus the next payment milestone. */
export function ClientAccountCard({ account, action, title = "Client account", originalValue }: { account: ClientAccount; action?: React.ReactNode; title?: string; originalValue?: string | null }) {
  const a = account;
  const so = a.scope === "SALES_ORDER";
  const revised = so && originalValue && cmpMoney(originalValue, a.contractValue) !== 0;
  const rows: [string, string, string?][] = [
    ...(revised ? [["Sales order total (original)", originalValue!] as [string, string]] : []),
    [so ? (revised ? "Revised contract value" : "Sales order total") : "Contract value", a.contractValue, so ? undefined : "confirmed sales orders"],
    ["Material delivered", a.deliveredValue, "at order rates, excl. GST"],
    ["Running bills", a.runningBillValue, "excl. GST · billed through invoices"],
    ["Total invoiced", a.invoiced],
    ["Payment received", a.paymentReceived, "allocated + advances"],
    ["Outstanding billed", a.outstandingBilled],
    ["Unallocated advance", a.clientAdvances, "not yet set against invoices"],
    ["Unbilled contract", a.unbilled],
    ["Remaining to receive", a.remainingContract],
    ["Overdue", a.overdue],
  ];
  return (
    <Section title={title} actions={action}>
      <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        {rows.map(([l, v, hint]) => (
          <div key={l}>
            <dt className="text-xs text-muted-foreground">{l}</dt>
            <dd className={cn("font-semibold tabular-nums", l === "Overdue" && cmpMoney(v, "0") > 0 && "text-rose-700", l === "Remaining to receive" && "text-base")}>{formatINR(v)}</dd>
            {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
          </div>
        ))}
      </dl>
      {a.nextMilestone && (
        <p className="mt-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          Next payment milestone: <span className="font-medium">{a.nextMilestone.label}</span> ({a.nextMilestone.soNumber}) — {formatINR(a.nextMilestone.dueNow)} of {formatINR(a.nextMilestone.amount)} still to receive · {a.nextMilestone.trigger}
          {a.nextMilestone.dueDate ? ` · due ${formatDate(a.nextMilestone.dueDate)}` : ""}
        </p>
      )}
    </Section>
  );
}
