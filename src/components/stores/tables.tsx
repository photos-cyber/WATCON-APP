"use client";

import { AlertTriangle, PackageCheck, PackageOpen, Truck } from "lucide-react";
import Link from "next/link";
import { DocStatusBadge } from "@/components/commercial/ui";
import { EmptyState } from "@/components/shared/states";
import { DataTable, type DataTableColumn } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { formatDate, formatQty } from "@/lib/format";

export type GrnRow = { id: string; number: string; status: string; receiptDate: string; project: { id: string; code: string } | null; source: { kind: "po" | "challan"; id: string; number: string } | null; from: string; location: string; createdBy: string; lines: number; discrepancy: boolean };

export function GrnTable({ rows }: { rows: GrnRow[] }) {
  const columns: DataTableColumn<GrnRow>[] = [
    { id: "number", header: "Receipt", cell: ({ row }) => <Link href={`/site-receipts/${row.original.id}`} className="font-medium hover:text-primary hover:underline">{row.original.number}</Link> },
    { id: "date", header: "Date", cell: ({ row }) => <span className="whitespace-nowrap">{formatDate(row.original.receiptDate)}</span> },
    { id: "project", header: "Project", cell: ({ row }) => (row.original.project ? <span className="font-mono text-xs">{row.original.project.code}</span> : "—") },
    { id: "source", header: "Against", cell: ({ row }) => (row.original.source ? <Link className="hover:underline" href={row.original.source.kind === "po" ? `/purchase-orders/${row.original.source.id}` : `/challans/${row.original.source.id}`}>{row.original.source.number}</Link> : "—") },
    { id: "from", header: "From", cell: ({ row }) => row.original.from },
    { id: "loc", header: "Received at", cell: ({ row }) => row.original.location },
    { id: "issues", header: "", cell: ({ row }) => (row.original.discrepancy ? <span className="inline-flex items-center gap-1 text-xs text-amber-700"><AlertTriangle className="size-3.5" /> Damage / rejection</span> : null) },
    { id: "status", header: "Status", cell: ({ row }) => <DocStatusBadge status={row.original.status} /> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState icon={PackageCheck} title="No site receipts yet" description="When material arrives at site, open it from “Waiting to be received” above and tap Receive." />} />;
}

export type PendingDelivery = { kind: "po" | "challan"; id: string; number: string; party: string; project: { id: string; code: string } | null; location: string; expectedDate: string | null; overdue: boolean; pendingLines: number; pendingQty: string; inProgress: number };

/** Site engineer's inbox: one card per PO / transfer still awaiting material, with a one-tap Receive. */
export function PendingDeliveries({ items, canReceive }: { items: PendingDelivery[]; canReceive: boolean }) {
  if (!items.length) return <EmptyState icon={PackageOpen} title="Nothing waiting to be received" description="Approved purchase orders and dispatched transfers for your projects will appear here." />;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((d) => (
        <li key={`${d.kind}:${d.id}`} className={`flex flex-col gap-2 rounded-xl border bg-card p-4 ${d.overdue ? "border-rose-300 dark:border-rose-900" : ""}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {d.kind === "po" ? <PackageCheck className="size-3.5" /> : <Truck className="size-3.5" />}
                {d.kind === "po" ? "Purchase order" : "Transfer challan"}
                {d.project && <span className="font-mono">· {d.project.code}</span>}
              </p>
              <Link href={d.kind === "po" ? `/purchase-orders/${d.id}` : `/challans/${d.id}`} className="font-semibold hover:underline">
                {d.number}
              </Link>
              <p className="truncate text-sm">{d.party}</p>
            </div>
            {d.overdue && <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200">Overdue</span>}
          </div>
          <p className="text-sm text-muted-foreground">
            {d.pendingLines} item{d.pendingLines === 1 ? "" : "s"} · {formatQty(d.pendingQty)} units pending · to {d.location}
            {d.expectedDate && <> · due {formatDate(d.expectedDate)}</>}
          </p>
          {d.inProgress > 0 && <p className="text-xs text-amber-700 dark:text-amber-400">{d.inProgress} receipt(s) already started — finish them (add proof and confirm).</p>}
          {canReceive && (
            <Button asChild className="mt-auto h-11">
              <Link href={`/site-receipts/new?${d.kind === "po" ? "poId" : "challanId"}=${d.id}`}>
                <PackageCheck /> Receive
              </Link>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export type ChallanRow = { id: string; number: string; type: string; typeLabel: string; status: string; date: string | null; project: { id: string; code: string } | null; from: string; to: string; vehicleNo: string | null; lines: number };

export function ChallanTable({ rows }: { rows: ChallanRow[] }) {
  const columns: DataTableColumn<ChallanRow>[] = [
    { id: "number", header: "Challan", cell: ({ row }) => <Link href={`/challans/${row.original.id}`} className="font-medium hover:text-primary hover:underline">{row.original.number}</Link> },
    { id: "type", header: "Type", cell: ({ row }) => row.original.typeLabel },
    { id: "date", header: "Dispatch", cell: ({ row }) => <span className="whitespace-nowrap">{formatDate(row.original.date)}</span> },
    { id: "project", header: "Project", cell: ({ row }) => (row.original.project ? <span className="font-mono text-xs">{row.original.project.code}</span> : "—") },
    { id: "route", header: "From → To", cell: ({ row }) => <span className="whitespace-nowrap">{row.original.from} → {row.original.to}</span> },
    { id: "vehicle", header: "Vehicle", cell: ({ row }) => row.original.vehicleNo ?? "—" },
    { id: "lines", header: "Items", className: "text-right", cell: ({ row }) => row.original.lines },
    { id: "status", header: "Status", cell: ({ row }) => <DocStatusBadge status={row.original.status} /> },
  ];
  return <DataTable columns={columns} data={rows} getRowId={(r) => r.id} empty={<EmptyState icon={Truck} title="No challans" description="Create a challan to send material from the store to a site, between sites, back to a supplier or to a client." />} />;
}
