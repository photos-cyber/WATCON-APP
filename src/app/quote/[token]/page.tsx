import type { Metadata } from "next";
import { Logo } from "@/components/layout/logo";
import { PortalQuoteForm } from "@/components/procurement/portal-quote-form";
import { formatDate, formatQty } from "@/lib/format";
import { getPortalQuote } from "@/modules/procurement/supplier-portal";

export const metadata: Metadata = { title: "Submit your quotation", referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function SupplierQuotePage({ params }: PageProps<"/quote/[token]">) {
  const { token } = await params;
  const data = await getPortalQuote(token);

  return (
    <div className="min-h-screen bg-muted/30 px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Logo className="h-8" priority />
          {data && <span className="text-right text-xs text-muted-foreground">{data.company.name}</span>}
        </div>

        {!data ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <h1 className="text-lg font-semibold">This quote link is not valid</h1>
            <p className="mt-2 text-sm text-muted-foreground">Please check you opened the full link, or ask the buyer to send it again.</p>
          </div>
        ) : (
          <>
            <div className="rounded-xl border bg-card p-4 sm:p-6">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Request for quotation · {data.rfq.number}</p>
              <h1 className="mt-1 text-xl font-semibold">{data.rfq.title}</h1>
              <p className="mt-1 text-sm">
                For <span className="font-medium">{data.supplier}</span>
              </p>
              <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {data.rfq.project && <Info label="Project" value={data.rfq.project} />}
                {data.rfq.responseDue && <Info label="Please quote by" value={formatDate(data.rfq.responseDue)} />}
                {data.rfq.requiredBy && <Info label="Needed at site by" value={formatDate(data.rfq.requiredBy)} />}
                {data.rfq.paymentTerms && <Info label="Payment terms" value={data.rfq.paymentTerms} />}
                {data.rfq.freightTerms && <Info label="Freight terms" value={data.rfq.freightTerms} />}
                {data.rfq.taxTerms && <Info label="Tax terms" value={data.rfq.taxTerms} />}
                {data.rfq.deliveryAddress && <Info label="Delivery address" value={data.rfq.deliveryAddress} wide />}
                {data.rfq.specifications && <Info label="Specifications" value={data.rfq.specifications} wide />}
              </dl>
            </div>

            {data.open ? (
              <PortalQuoteForm token={token} lines={data.lines} current={data.current} />
            ) : (
              <div className="rounded-xl border bg-card p-6">
                <h2 className="font-semibold">Quotations are closed for this enquiry</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {data.current ? `We have your quotation ${data.current.number}${data.current.revision > 1 ? ` (revision ${data.current.revision})` : ""}. ` : ""}Thank you — the buyer will contact you if needed.
                </p>
                <ul className="mt-3 divide-y text-sm">
                  {data.lines.map((l) => (
                    <li key={l.id} className="flex justify-between gap-2 py-2">
                      <span>{l.name}</span>
                      <span className="tabular-nums">
                        {formatQty(l.quantity)} {l.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <p className="text-center text-xs text-muted-foreground">This link is personal to your company. Please do not forward it.</p>
      </div>
    </div>
  );
}

function Info({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-line">{value}</dd>
    </div>
  );
}
