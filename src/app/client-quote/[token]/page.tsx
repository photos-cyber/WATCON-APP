import type { Metadata } from "next";
import { Logo } from "@/components/layout/logo";
import { ClientQuoteResponse } from "@/components/sales/client-quote-response";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { TRIGGERS, type Trigger } from "@/modules/commercial/payment-terms";
import { getPublicQuotation } from "@/modules/sales/quotation";

export const metadata: Metadata = { title: "Quotation", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function ClientQuotePage({ params }: PageProps<"/client-quote/[token]">) {
  const { token } = await params;
  const data = await getPublicQuotation(token);
  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">This quotation link is not available</h1>
          <p className="mt-2 text-sm text-muted-foreground">It may have been withdrawn or replaced. Please contact the company that sent it.</p>
        </div>
      </div>
    );
  }
  const { q, expired, canRespond, emailOnFile } = data;
  const company = q.organization.legalName || q.organization.name;
  return (
    <div className="min-h-screen bg-muted/30 px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Logo className="h-8" priority />
          <span className="text-right text-xs text-muted-foreground">{company}</span>
        </div>
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">
                Quotation {q.number}
                {q.revision ? ` · Rev ${q.revision}` : ""}
              </p>
              <h1 className="mt-1 text-xl font-semibold">{q.subject ?? `Quotation for ${q.party.name}`}</h1>
              <p className="mt-1 text-sm">
                For <span className="font-medium">{q.party.name}</span> · {q.project.name}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Total (incl. GST)</p>
              <p className="text-2xl font-semibold tabular-nums">{formatINR(q.total.toFixed(2))}</p>
              <p className="text-xs text-muted-foreground">Dated {formatDate(q.quoteDate)}{q.validUntil ? ` · valid until ${formatDate(q.validUntil)}` : ""}</p>
            </div>
          </div>
          <div className="mt-4">
            <Button asChild variant="outline" size="sm">
              <a href={`/client-quote/${token}/pdf`} target="_blank" rel="noopener">Download PDF</a>
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[600px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-3 py-2 text-right font-medium">GST</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {q.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 text-muted-foreground">{l.lineNo}</td>
                  <td className="px-3 py-2">
                    {l.description}
                    {l.brand && <span className="block text-xs text-muted-foreground">Brand: {l.brand}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.quantity.toFixed(3))} {l.unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate.toFixed(2))}</td>
                  <td className="px-3 py-2 text-right">{Number(l.gstRate)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.taxable.toFixed(2))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ml-auto max-w-xs space-y-1 border-t px-4 py-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Taxable value</span><span>{formatINR(q.taxable.toFixed(2))}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">GST</span><span>{formatINR(q.taxAmount.toFixed(2))}</span></div>
            <div className="flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>{formatINR(q.total.toFixed(2))}</span></div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-2 font-semibold">Payment schedule</h2>
          <ul className="divide-y text-sm">
            {q.milestones.map((m) => (
              <li key={m.id} className="flex justify-between gap-2 py-2">
                <span>
                  {m.label}
                  <span className="block text-xs text-muted-foreground">{TRIGGERS[m.trigger as Trigger] ?? m.trigger}{m.dueDate ? ` · ${formatDate(m.dueDate)}` : ""}{m.days !== null ? ` · ${m.days} days` : ""}</span>
                </span>
                <span className="tabular-nums">
                  {m.basis === "PERCENT" && m.percent ? <span className="mr-3 text-muted-foreground">{Number(m.percent)}%</span> : null}
                  <span className="font-medium">{formatINR(m.amount.toFixed(2))}</span>
                </span>
              </li>
            ))}
          </ul>
          {q.paymentTermsText && <p className="mt-2 text-sm text-muted-foreground">{q.paymentTermsText}</p>}
        </div>

        {(q.deliveryTerms || q.terms) && (
          <div className="rounded-xl border bg-card p-4 text-sm">
            {q.deliveryTerms && (
              <>
                <h2 className="mb-1 font-semibold">Delivery terms</h2>
                <p className="mb-3 whitespace-pre-line">{q.deliveryTerms}</p>
              </>
            )}
            {q.terms && (
              <>
                <h2 className="mb-1 font-semibold">Terms & conditions</h2>
                <p className="whitespace-pre-line">{q.terms}</p>
              </>
            )}
          </div>
        )}

        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {q.status === "ACCEPTED" || q.status === "CONVERTED" ? (
            <p className="text-sm">
              <span className="font-semibold text-emerald-700">Accepted</span> by {q.acceptedByName} on {q.acceptedAt ? formatDateTime(q.acceptedAt) : ""}. Thank you — our team will be in touch.
            </p>
          ) : q.status === "REJECTED" ? (
            <p className="text-sm">You declined this quotation. Our team may send you a revised offer.</p>
          ) : expired ? (
            <p className="text-sm">This quotation expired on {formatDate(q.validUntil)}. Please contact us for a revised quotation.</p>
          ) : canRespond ? (
            <ClientQuoteResponse token={token} emailOnFile={emailOnFile} />
          ) : null}
        </div>
        <p className="text-center text-xs text-muted-foreground">This link is personal to your company. Please do not forward it.</p>
      </div>
    </div>
  );
}
