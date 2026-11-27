import type { Metadata } from "next";
import { RecordClientPaymentButton } from "@/components/payables/client-account";
import { can as can_ } from "@/lib/permissions/definitions";
import Link from "next/link";
import { RelatedDocs } from "@/components/commercial/related-docs";
import { DetailGrid, DocStatusBadge, Money, Section } from "@/components/commercial/ui";
import { ActivityTimeline } from "@/components/documents/activity-timeline";
import { AttachmentsPanel } from "@/components/documents/attachments-panel";
import { DocShare } from "@/components/documents/doc-share";
import { NextStep } from "@/components/procurement/next-step";
import { projectCrumbs } from "@/components/projects/project-breadcrumbs";
import { RaActions } from "@/components/sales/actions";
import { CertifyForm, RaStepper } from "@/components/sales/ra-ui";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatQty } from "@/lib/format";
import { formatINR } from "@/lib/money";
import { orNotFound } from "@/lib/pages";
import { entityActivity } from "@/modules/documents/activity";
import { listAttachments } from "@/modules/documents/attachments";
import { getRaBill } from "@/modules/sales/ra-bill";
import { soRunningBillPreview } from "@/modules/sales/so-running-bill";
import { SoRunningBillForm } from "@/components/sales/so-ra-ui";

export const metadata: Metadata = { title: "Running bill" };

export default async function RunningBillPage({ params }: PageProps<"/running-bills/[raId]">) {
  const user = await requirePagePermission("rabill.view");
  const { raId } = await params;
  const { bill, can } = await orNotFound(getRaBill(user, raId));
  const [files, activity] = await Promise.all([listAttachments(user, "ra_bill", bill.id), entityActivity(user, "ra_bill", bill.id)]);
  const so = bill.basis === "SO";
  const st = bill.statement;
  const contract = bill.clientPo ? { type: "Client PO", id: bill.clientPo.id, number: bill.clientPo.number, label: `${bill.clientPo.clientPoNumber} (${bill.clientPo.number})`, href: `/client-pos/${bill.clientPo.id}` } : bill.salesOrder ? { type: "Sales order", id: bill.salesOrder.id, number: bill.salesOrder.number, label: bill.salesOrder.number, href: `/sales-orders/${bill.salesOrder.id}` } : null;
  const preview = so && can.refresh && bill.soId ? await soRunningBillPreview(user, bill.soId) : null;
  const share = `Running bill ${bill.number} (RA-${bill.raNumber})\n${contract ? `${contract.type}: ${contract.label}\n` : ""}Period: ${formatDate(bill.periodFrom)} to ${formatDate(bill.periodTo)}\nThis bill: ${formatINR(bill.netPayable)}${so ? `\nPrevious outstanding: ${formatINR(st.previousOutstanding)}\nTotal payable: ${formatINR(st.totalPayable)}` : ""}\n\nThe PDF is attached.`;
  return (
    <>
      <PageHeader
        title={`${bill.number} · RA-${bill.raNumber}`}
        breadcrumbs={[...projectCrumbs(bill.project, "running-bills"), { label: bill.number }]}
        meta={
          <>
            <DocStatusBadge status={bill.status} />
            <span className="text-sm text-muted-foreground">
              {bill.party.name} · <Money value={bill.gross} />
            </span>
          </>
        }
        actions={
          <>
            <RaActions id={bill.id} version={bill.version} can={can} />
            {bill.invoice && can_(user, "payments.manage") && <RecordClientPaymentButton projectId={bill.projectId} partyId={bill.partyId} invoiceId={bill.invoice.id} />}
            {can.certify && <CertifyForm id={bill.id} version={bill.version} lines={bill.lines.map((l) => ({ id: l.id, lineNo: l.ref.lineNo, description: l.ref.description, unit: l.ref.unit, claimedQty: l.claimedQty, rate: l.rate }))} otherDeductions={bill.otherDeductions} deductionNotes={bill.deductionNotes} />}
            <DocShare type="ra_bill" id={bill.id} summary={share} phone={bill.party.whatsappNumber ?? bill.party.phone} email={bill.party.email} subject={`Running bill ${bill.number}`} />
          </>
        }
      />
      <RaStepper status={bill.status} />
      {bill.status === "DRAFT" && <NextStep title="Draft — check and submit to the client">{so ? "Check the quantities (refresh below picks up anything delivered since), then press “Submit to client”." : "Check quantities against the measurement sheet, then press “Submit to client”."}</NextStep>}
      {bill.status === "INTERNAL_REVIEW" && <NextStep title="Submit to the client">It was waiting under the old review step — press “Submit to client”.</NextStep>}
      {bill.status === "SUBMITTED" && <NextStep tone="info" title="With the client">Share the PDF with the client. If they accept it as submitted, press “Client accepted — invoice now” (certifies, creates and issues the invoice in one step); otherwise record their certified quantities or a dispute.</NextStep>}
      {bill.status === "DISPUTED" && <NextStep tone="warn" title="Disputed by the client">{bill.disputeNote ?? "Resolve the objection, then resubmit or record the certification."}</NextStep>}
      {bill.status === "CLIENT_CERTIFIED" && <NextStep title="Certified — raise the invoice" links={can.invoice ? [{ href: `/client-invoices/new?raBillId=${bill.id}`, label: "Create invoice" }] : []}>The tax invoice is raised for the certified quantities.</NextStep>}
      {bill.statusNote && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">{bill.statusNote}</p>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="min-w-0 space-y-4 xl:col-span-2">
          <Section title="Bill">
            <DetailGrid
              items={[
                { label: "Client", value: <Link className="hover:underline" href={`/parties/${bill.party.id}`}>{bill.party.name}</Link> },
                { label: contract?.type ?? "Contract", value: contract ? <Link className="hover:underline" href={contract.href}>{contract.label}</Link> : "—" },
                ...(bill.isFinal ? [{ label: "Bill type", value: "Final bill" }] : []),
                { label: "Project", value: `${bill.project.code} – ${bill.project.name}` },
                { label: "Bill date", value: formatDate(bill.billDate) },
                { label: "Period", value: `${formatDate(bill.periodFrom)} → ${formatDate(bill.periodTo)}` },
                { label: "Prepared by", value: `${bill.createdBy.fullName} · ${formatDateTime(bill.createdAt)}` },
                { label: "Client certificate", value: bill.clientCertRef ? `${bill.clientCertRef} · ${formatDate(bill.clientCertDate)}${bill.certifiedBy ? ` · recorded by ${bill.certifiedBy.fullName}` : ""}` : "—" },
                { label: "Remarks", value: bill.remarks, wide: true },
              ]}
            />
          </Section>
          {so && (
            <Section title="Cumulative statement">
              <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                {[["Previous material value", st.previousValue], ["New material value", st.currentValue], ["Cumulative value", st.cumulativeValue], ["Previously billed", st.previousBilled], ["Current new billing (net)", st.currentBilling], ["Received to date", st.receivedToDate], ["Previous outstanding", st.previousOutstanding], ["Total payable", st.totalPayable]].map(([l, v]) => (
                  <div key={l}>
                    <dt className="text-xs text-muted-foreground">{l}</dt>
                    <dd className={l === "Total payable" ? "text-base font-semibold tabular-nums" : "font-medium tabular-nums"}>{formatINR(v)}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">Only this bill&apos;s net amount becomes a receivable when invoiced; previous outstanding is shown, never billed again.</p>
            </Section>
          )}
          <Section title={so ? "Items (previous / this bill / cumulative)" : "Measurements & amounts"} bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">Contract</th>
                    <th className="px-3 py-2 text-right font-medium">Previous</th>
                    <th className="px-3 py-2 text-right font-medium">This bill</th>
                    <th className="px-3 py-2 text-right font-medium">Cumulative</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Claimed</th>
                    <th className="px-3 py-2 text-right font-medium">Certified</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {bill.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{l.ref.lineNo}. {l.ref.description}</div>
                        <div className="text-xs text-muted-foreground">{[l.ref.kind === "SERVICE" ? "Service" : l.ref.kind === "INSTALLATION" ? "Installation" : null, so && l.ref.kind === "MATERIAL" ? `delivered ${formatQty(l.deliveredQty)}` : null, l.ref.boqRef && `BOQ ${l.ref.boqRef}`, l.measurementRef && `Measurement ${l.measurementRef}`, l.remarks].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.contractQty)} {l.ref.unit}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.prevCertifiedQty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.certifiedQty ?? l.claimedQty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatQty(l.cumulativeQty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatINR(l.rate)}</td>
                      <td className="px-3 py-2 text-right tabular-nums"><Money value={l.claimedAmount} /></td>
                      <td className="px-3 py-2 text-right tabular-nums">{l.certifiedAmount ? <Money value={l.certifiedAmount} /> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end border-t px-4 py-3">
              <dl className="w-80 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-muted-foreground">{bill.certified ? "Certified value" : "Claimed value"}</dt><dd className="tabular-nums">{formatINR(bill.gross)}</dd></div>
                {bill.certified && bill.claimedAmount !== bill.certifiedAmount && <div className="flex justify-between text-xs text-muted-foreground"><dt>Originally claimed</dt><dd className="tabular-nums">{formatINR(bill.claimedAmount)}</dd></div>}
                <div className="flex justify-between"><dt className="text-muted-foreground">GST</dt><dd className="tabular-nums">{formatINR(bill.gstAmount)}</dd></div>
                {bill.retentionAmount !== "0.00" && <div className="flex justify-between"><dt className="text-muted-foreground">Retention ({Number(bill.retentionPct)}%)</dt><dd className="tabular-nums">− {formatINR(bill.retentionAmount)}</dd></div>}
                {bill.advanceRecovery !== "0.00" && <div className="flex justify-between"><dt className="text-muted-foreground">Advance recovery</dt><dd className="tabular-nums">− {formatINR(bill.advanceRecovery)}</dd></div>}
                {bill.otherDeductions !== "0.00" && <div className="flex justify-between"><dt className="text-muted-foreground">Other deductions</dt><dd className="tabular-nums">− {formatINR(bill.otherDeductions)}</dd></div>}
                <div className="flex justify-between border-t pt-1 text-base font-semibold"><dt>{so ? "This bill (net)" : "Net payable"}</dt><dd className="tabular-nums">{formatINR(bill.netPayable)}</dd></div>
                {so && <div className="flex justify-between text-muted-foreground"><dt>Previous outstanding</dt><dd className="tabular-nums">{formatINR(st.previousOutstanding)}</dd></div>}
                {so && <div className="flex justify-between font-semibold"><dt>Total payable</dt><dd className="tabular-nums">{formatINR(st.totalPayable)}</dd></div>}
              </dl>
            </div>
            {bill.deductionNotes && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Deductions: {bill.deductionNotes}</p>}
          </Section>
          {so && bill.previousBills.length > 0 && (
            <Section title="Previous running bills" bodyClassName="p-0">
              <ul className="divide-y text-sm">
                {bill.previousBills.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 px-4 py-2">
                    <Link href={`/running-bills/${p.id}`} className="font-medium hover:underline">RA-{p.raNumber} · {p.number}</Link>
                    <span className="text-muted-foreground">{formatDate(p.billDate)} · billed {formatINR(p.netPayable)}{p.invoice ? ` · invoice ${p.invoice}` : " · not invoiced yet"}</span>
                    <span className="ml-auto tabular-nums">received {formatINR(p.received)} · <span className="font-medium">outstanding {formatINR(p.outstanding)}</span></span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {preview && bill.soId && (
            <Section title="Refresh this draft">
              <SoRunningBillForm soId={bill.soId} lines={preview.lines} statement={preview.statement} draftNumber={bill.number} initial={{ isFinal: bill.isFinal, retentionPct: String(Number(bill.retentionPct)), advanceRecovery: bill.advanceRecovery, otherDeductions: bill.otherDeductions === "0.00" ? "" : bill.otherDeductions, deductionNotes: bill.deductionNotes ?? "", remarks: bill.remarks ?? "", claims: Object.fromEntries(bill.lines.filter((l) => l.soLineId).map((l) => [l.soLineId!, l.claimedQty])) }} />
            </Section>
          )}
          <ActivityTimeline items={activity} />
        </div>
        <div className="space-y-4">
          <RelatedDocs
            docs={[
              ...(contract ? [{ type: contract.type, id: contract.id, number: contract.number, href: contract.href }] : []),
              ...(bill.invoice ? [{ type: "Invoice", id: bill.invoice.id, number: bill.invoice.number, status: bill.invoice.status, href: `/client-invoices/${bill.invoice.id}`, meta: formatINR(bill.invoice.total) }] : []),
            ]}
          />
          <AttachmentsPanel entityType="ra_bill" entityId={bill.id} data={files} currentUserId={user.id} defaultCategory="MEASUREMENT_SHEET" />
        </div>
      </div>
    </>
  );
}
