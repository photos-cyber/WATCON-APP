"use client";

import { callAction } from "@/lib/call-action";
import { Archive, ArchiveRestore, Eye, FolderKanban, MoreHorizontal, Pencil } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { ProgressBar, StatusBadge } from "@/components/shared/badges";
import { ConfirmDialog } from "@/components/shared/dialogs";
import { EmptyState } from "@/components/shared/states";
import { DataTable, type DataTableColumn } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatDate } from "@/lib/format";
import { setProjectArchivedAction } from "@/modules/projects/actions";

export type ProjectRow = {
  id: string;
  code: string;
  name: string;
  siteAddress: string;
  status: string;
  updatedAt: string;
  archived: boolean;
  manager: string | null;
  total: number;
  completed: number;
  progress: number;
  progressBasis?: "delivery" | "tasks";
};

function RowActions({ row, canEdit, canArchive }: { row: ProjectRow; canEdit: boolean; canArchive: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/projects/${row.id}`}>
            <Eye /> View
          </Link>
        </DropdownMenuItem>
        {canEdit && (
          <DropdownMenuItem asChild>
            <Link href={`/projects/${row.id}/edit`}>
              <Pencil /> Edit
            </Link>
          </DropdownMenuItem>
        )}
        {canArchive && (
          <>
            <DropdownMenuSeparator />
            <ConfirmDialog
              trigger={
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  {row.archived ? <ArchiveRestore /> : <Archive />} {row.archived ? "Restore" : "Archive"}
                </DropdownMenuItem>
              }
              title={row.archived ? "Restore project?" : "Archive project?"}
              description={row.archived ? `${row.name} will return to the active project directory.` : `${row.name} will be hidden from the default directory. Its tasks and history are kept and remain visible.`}
              confirmLabel={row.archived ? "Restore" : "Archive"}
              onConfirm={async () => {
                const res = await callAction(setProjectArchivedAction, row.id, !row.archived);
                if (res.ok) toast.success(row.archived ? "Project restored" : "Project archived");
                else toast.error(res.error);
                return res.ok;
              }}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectsTable({ rows, canEdit, canArchive, canCreate }: { rows: ProjectRow[]; canEdit: boolean; canArchive: boolean; canCreate: boolean }) {
  const columns: DataTableColumn<ProjectRow>[] = [
    { id: "code", header: "Code", sortKey: "code", cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.code}</span> },
    {
      id: "name",
      header: "Project",
      sortKey: "name",
      cell: ({ row }) => (
        <Link href={`/projects/${row.original.id}`} className="font-medium hover:text-primary hover:underline">
          {row.original.name}
          {row.original.archived && <span className="ml-2 rounded border px-1.5 py-px text-[10px] font-normal text-muted-foreground">Archived</span>}
        </Link>
      ),
    },
    { id: "address", header: "Site address", cell: ({ row }) => <span className="line-clamp-2 max-w-64 text-sm text-muted-foreground">{row.original.siteAddress}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: ({ row }) => <StatusBadge kind="project" status={row.original.status} /> },
    { id: "manager", header: "Manager", cell: ({ row }) => <span className="whitespace-nowrap">{row.original.manager ?? "—"}</span> },
    { id: "tasks", header: "Tasks", className: "text-right", cell: ({ row }) => <span className="tabular-nums">{row.original.total}</span> },
    { id: "completed", header: "Done", className: "text-right", cell: ({ row }) => <span className="tabular-nums">{row.original.completed}</span> },
    {
      id: "progress",
      header: "Progress",
      className: "min-w-32",
      cell: ({ row }) => (
        <div title={row.original.progressBasis === "delivery" ? "Sales order value delivered to the client" : "Completed tasks"}>
          <ProgressBar value={row.original.progress} />
          <span className="text-[10px] text-muted-foreground">{row.original.progressBasis === "delivery" ? "delivered" : "tasks"}</span>
        </div>
      ),
    },
    { id: "updatedAt", header: "Updated", sortKey: "updatedAt", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(row.original.updatedAt)}</span> },
    { id: "actions", header: () => <span className="sr-only">Actions</span>, className: "w-10", cell: ({ row }) => <RowActions row={row.original} canEdit={canEdit} canArchive={canArchive} /> },
  ];
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      defaultSort="updatedAt"
      defaultDir="desc"
      empty={
        <EmptyState
          icon={FolderKanban}
          title="No projects found"
          description="Try adjusting your search or filters."
          action={
            canCreate ? (
              <Button asChild>
                <Link href="/projects/new">Create project</Link>
              </Button>
            ) : undefined
          }
        />
      }
    />
  );
}
