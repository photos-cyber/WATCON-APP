"use client";

import { FileSignature, FileText, ReceiptIndianRupee, ScrollText } from "lucide-react";
import Link from "next/link";
import { DocStatusBadge, Money, ToneBadge } from "@/components/commercial/ui";
import { EmptyState } from "@/components/shared/states";
import { DataTable, type DataTableColumn } from "@/components/tables/data-table";
import { formatDate } from "@/lib/format";

type Proj = { id: string; code: string };
const projectCell = (p: Proj) => (
  <Link className="font-mono text-xs hover:underline" href={`/projects/${p.id}`}>
    {p.code}
  </Link>
);

export type CpoRow = { id: string; number: string; clientPoNumber: string; revision: number; status: string; poDate: string; total: string; invoiced: string; party: { id: string; name: string }; project: Proj };

export function CpoTable({ rows }: { rows: CpoRow[] }) {
  const columns: DataTableColumn<CpoRow>[] = [
    { id: "number", header: "Contract", cell: ({ row }) => <Link href={`/client-pos/${row.original.id}`} className="font-medium hover:text-primary hover:underline">{row.original.clientPoNumber}<span className="block text-xs font-normal text-muted-foreground">{row.original.number}{row.original.revision ? ` · rev ${row.original.revision}` : ""}</span></Link> },
    { id: "date", header: "Date", cell: ({ row }) => <span className="whitespace-nowrap">{formatDate(row.original.poDate)}</span> },
    { id: "client", header: "Client", cell: ({ row }) => row.original.party.name },
    { id: "project", header: "Project", cell: ({ row }) => projectCell(row.original.project) },
    { id: "value", header: "Contract value", className: "text-right", cell: ({ row }) => <Money value={row.original.total} /> },
    { id: "inv", header: "Invoiced", className: "text-right", cell: ({ row }) => <Money value={row.original.invoiced} muted /> },
    { id: "status", header: "Status", cell: ({ row }) => <DocStatusBadge status={row.original.status} /> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState icon={FileSignature} title="No client POs yet" description="Record the client's purchase order / work order to set the contract value and quantities you can bill." />} />;
}

export type SoRow = { id: string; number: string; revision: number; status: string; orderDate: string; deliveryDate: string | null; total: string; party: { id: string; name: string }; project: Proj; clientPo: string | null; fulfilledPct: number; pendingAmendment: boolean };

export function SoTable({ rows }: { rows: SoRow[] }) {
  const columns: DataTableColumn<SoRow>[] = [
    { id: "number", header: "Sales order", cell: ({ row }) => <Link href={`/sales-orders/${row.original.id}`} className="font-medium hover:text-primary hover:underline">{row.original.number}{row.original.revision ? <span className="ml-1 text-xs text-muted-foreground">rev {row.original.revision}</span> : null}</Link> },
    { id: "date", header: "Date", cell: ({ row }) => <span className="whitespace-nowrap">{formatDate(row.original.orderDate)}</span> },
    { id: "client", header: "Client", cell: ({ row }) => <span>{row.original.party.name}{row.original.clientPo && <span className="block text-xs text-muted-foreground">PO {row.original.clientPo}</span>}</span> },
    { id: "project", header: "Project", cell: ({ row }) => projectCell(row.original.project) },
    { id: "due", header: "Delivery by", cell: ({ row }) => formatDate(row.original.deliveryDate) },
    { id: "value", header: "Value", className: "text-right", cell: ({ row }) => <Money value={row.original.total} /> },
    {
      id: "ful",
      header: "Delivered",
      cell: ({ row }) => (
        <div className="flex min-w-24 items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"><div className="h-full bg-emerald-500" style={{ width: `${row.original.fulfilledPct}%` }} /></div>
          <span className="text-xs tabular-nums text-muted-foreground">{row.original.fulfilledPct}%</span>
        </div>
      ),
    },
    { id: "status", header: "Status", cell: ({ row }) => <span className="flex flex-wrap items-center gap-1"><DocStatusBadge status={row.original.status} />{row.original.pendingAmendment && <ToneBadge tone="warn">Change requested</ToneBadge>}</span> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState icon={FileText} title="No sales orders yet" description="Create the project's sales order — it drives material planning, purchasing, deliveries and billing." />} />;
}

export type RaRow = { id: string; number: string; raNumber: number; status: string; billDate: string; claimed: string; certified: string; net: string; party: { id: string; name: string }; project: Proj; contract: { id: string; number: string; href: string } | null };

export function RaTable({ rows }: { rows: RaRow[] }) {
  const columns: DataTableColumn<RaRow>[] = [
    { id: "number", header: "Bill", cell: ({ row }) => <Link href={`/running-bills/${row.original.id}`} className="font-medium hover:text-primary hover:underline">RA-{row.original.raNumber}<span className="block text-xs font-normal text-muted-foreground">{row.original.number}</span></Link> },
    { id: "date", header: "Date", cell: ({ row }) => formatDate(row.original.billDate) },
    { id: "client", header: "Client / contract", cell: ({ row }) => <span>{row.original.party.name}<span className="block text-xs text-muted-foreground">{row.original.contract?.number ?? "—"}</span></span> },
    { id: "project", header: "Project", cell: ({ row }) => projectCell(row.original.project) },
    { id: "claimed", header: "Claimed", className: "text-right", cell: ({ row }) => <Money value={row.original.claimed} /> },
    { id: "cert", header: "Certified", className: "text-right", cell: ({ row }) => (row.original.certified === "0.00" ? <span className="text-xs text-muted-foreground">—</span> : <Money value={row.original.certified} />) },
    { id: "net", header: "Net payable", className: "text-right", cell: ({ row }) => <Money value={row.original.net} /> },
    { id: "status", header: "Status", cell: ({ row }) => <DocStatusBadge status={row.original.status} /> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState icon={ScrollText} title="No running bills" description="Raise a running (RA) bill from an active client PO to claim work done this period." />} />;
}

export type InvRow = { id: string; number: string; status: string; invoiceDate: string; dueDate: string | null; total: string; net: string; received: string; outstanding: string; party: { id: string; name: string }; project: Proj; overdue: boolean };

export function InvoiceTable({ rows }: { rows: InvRow[] }) {
  const columns: DataTableColumn<InvRow>[] = [
    { id: "number", header: "Invoice", cell: ({ row }) => <Link href={`/client-invoices/${row.original.id}`} className="font-medium hover:text-primary hover:underline">{row.original.number}</Link> },
    { id: "date", header: "Date", cell: ({ row }) => formatDate(row.original.invoiceDate) },
    { id: "client", header: "Client", cell: ({ row }) => row.original.party.name },
    { id: "project", header: "Project", cell: ({ row }) => projectCell(row.original.project) },
    { id: "due", header: "Due", cell: ({ row }) => <span className={row.original.overdue ? "font-medium text-rose-700" : ""}>{formatDate(row.original.dueDate)}{row.original.overdue ? " · overdue" : ""}</span> },
    { id: "total", header: "Invoice total", className: "text-right", cell: ({ row }) => <Money value={row.original.total} /> },
    { id: "out", header: "Outstanding", className: "text-right", cell: ({ row }) => (["ISSUED", "PARTIALLY_PAID"].includes(row.original.status) ? <Money value={row.original.outstanding} /> : <span className="text-xs text-muted-foreground">—</span>) },
    { id: "status", header: "Status", cell: ({ row }) => <DocStatusBadge status={row.original.status} /> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState icon={ReceiptIndianRupee} title="No client invoices" description="Invoice a certified running bill, delivered sales-order quantities, or contract lines directly." />} />;
}
