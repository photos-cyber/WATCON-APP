"use client";

import {
  BarChart3,
  Boxes,
  Building2,
  ClipboardCheck,
  ClipboardList,
  FileCheck2,
  FileSignature,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  FolderOpen,
  HandCoins,
  CircleHelp,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquareQuote,
  PackageCheck,
  PackageSearch,
  Receipt,
  ScrollText,
  Settings,
  ShoppingCart,
  StickyNote,
  Tags,
  Truck,
  UserRound,
  Users,
  Wallet,
  Warehouse,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

/** `perms` = permission keys the user holds that affect navigation (computed on the server with can()). */
export type NavUser = { id: string; canViewMembers: boolean; perms: string[] };

type Item = { href: string; label: string; icon: typeof LayoutDashboard; disabled?: boolean; match?: string; exact?: boolean };
type Group = { label: string | null; items: Item[] };

/** Sidebar modules, filtered by permission (role-based visibility). Empty groups are dropped. */
export function navGroups(user: NavUser): Group[] {
  const has = (...keys: string[]) => keys.some((k) => user.perms.includes(k));
  const item = (show: boolean, i: Item) => (show ? [i] : []);
  const groups: Group[] = [
    {
      label: "Projects",
      items: [
        { href: "/projects", label: "Projects", icon: FolderKanban },
        { href: "/tasks", label: "Tasks", icon: ListChecks },
      ],
    },
    { label: null, items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }, ...item(has("approvals.view"), { href: "/approvals", label: "Approvals", icon: Inbox })] },
    {
      label: "Sales & Billing",
      items: [
        ...item(has("so.view"), { href: "/quotations", label: "Quotations", icon: FileText }),
        ...item(has("so.view"), { href: "/sales-orders", label: "Sales Orders", icon: FileText }),
        ...item(has("cpo.view"), { href: "/client-pos", label: "Client POs", icon: FileSignature }),
        ...item(has("rabill.view"), { href: "/running-bills", label: "Running Bills", icon: FileSpreadsheet }),
        ...item(has("invoice.view"), { href: "/client-invoices", label: "Client Invoices", icon: Receipt }),
      ],
    },
    {
      label: "Procurement",
      items: [
        ...item(has("mrp.view"), { href: "/material-planning", label: "Material Planning", icon: PackageSearch }),
        ...item(has("pr.view"), { href: "/purchase-requisitions", label: "Requisitions", icon: ClipboardList }),
        ...item(has("rfq.view"), { href: "/rate-enquiries", label: "Rate Enquiries", icon: MessageSquareQuote }),
        ...item(has("po.view"), { href: "/purchase-orders", label: "Purchase Orders", icon: ShoppingCart }),
      ],
    },
    {
      label: "Stores & Site",
      items: [
        ...item(has("grn.view"), { href: "/site-receipts", label: "Site Receipts", icon: PackageCheck }),
        ...item(has("grn.view"), { href: "/challans", label: "Challans", icon: ScrollText }),
        ...item(has("items.view"), { href: "/stock", label: "Inventory", icon: Warehouse }),
      ],
    },
    {
      label: "Accounts",
      items: [
        ...item(has("bills.view"), { href: "/supplier-bills", label: "Supplier Bills", icon: FileCheck2 }),
        ...item(has("payments.view"), { href: "/payments", label: "Payments & Receipts", icon: HandCoins }),
        ...item(has("bills.view"), { href: "/notes", label: "Credit / Debit Notes", icon: StickyNote }),
        ...item(has("accounts.view"), { href: "/accounts", label: "Project Accounts", icon: Wallet }),
      ],
    },
    {
      label: "Insights",
      items: [...item(has("reports.commercial"), { href: "/reports", label: "Reports", icon: BarChart3 }), { href: "/documents", label: "Documents", icon: FolderOpen }],
    },
    {
      label: "Masters",
      items: [
        ...item(has("parties.view"), { href: "/parties?type=client", label: "Clients", icon: Building2, match: "/parties?type=client", exact: true }),
        ...item(has("parties.view"), { href: "/parties?type=supplier", label: "Suppliers", icon: Truck, match: "/parties?type=supplier", exact: true }),
        ...item(has("items.view"), { href: "/items", label: "Items", icon: Boxes }),
        ...item(has("items.view"), { href: "/brands", label: "Brands", icon: Tags }),
      ],
    },
    {
      label: "Organization",
      items: [
        { href: "/departments", label: "Departments", icon: ClipboardCheck },
        user.canViewMembers ? { href: "/team-members", label: "Team Members", icon: Users } : { href: `/team-members/${user.id}`, label: "My Profile", icon: UserRound, match: "/team-members" },
      ],
    },
    { label: "Help", items: [{ href: "/help", label: "Help & User Guide", icon: CircleHelp }] },
    { label: "Administration", items: [{ href: "/settings", label: "Administration", icon: Settings }] },
  ];
  return groups.filter((g) => g.items.length > 0);
}

function NavEntry({ item, pathname, current, collapsed, onNavigate }: { item: Item; pathname: string; current: string; collapsed: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  if (item.disabled) {
    const content = (
      <span aria-disabled="true" className={cn("flex h-9 cursor-not-allowed items-center gap-3 rounded-lg px-2.5 text-sm text-muted-foreground/60", collapsed && "justify-center px-0")}>
        <Icon className="size-4 shrink-0" aria-hidden />
        {!collapsed && (
          <>
            <span className="truncate">{item.label}</span>
            <span className="ml-auto rounded border px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap">Soon</span>
          </>
        )}
        {collapsed && <span className="sr-only">{item.label} (Coming soon)</span>}
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right">{item.label} — Coming soon</TooltipContent>
      </Tooltip>
    );
  }
  const prefix = item.match ?? item.href;
  const active = item.exact ? current === prefix : pathname === item.href || pathname.startsWith(`${prefix}/`) || pathname === prefix;
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        active ? "bg-primary/8 text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
    </Link>
  );
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}

export function SidebarNav({ user, collapsed = false, onNavigate }: { user: NavUser; collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const type = useSearchParams().get("type");
  // The two /parties entries (Clients / Suppliers) are distinguished by their ?type= filter.
  const current = type ? `${pathname}?type=${type}` : pathname;
  return (
    <nav aria-label="Main" className="flex flex-col px-2">
      {navGroups(user).map((group, i) => {
        const headingId = `nav-group-${i}`;
        return (
          <div key={group.label ?? "top"} role="group" aria-labelledby={group.label ? headingId : undefined} className={cn(i > 0 && (collapsed ? "mt-2 border-t pt-2" : "mt-3"))}>
            {group.label && !collapsed && (
              <h2 id={headingId} className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
                {group.label}
              </h2>
            )}
            {group.label && collapsed && (
              <span id={headingId} className="sr-only">
                {group.label}
              </span>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavEntry key={item.label} item={item} pathname={pathname} current={current} collapsed={collapsed} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

export function Brand({ name, collapsed }: { name: string; collapsed?: boolean }) {
  return (
    <Link href="/dashboard" aria-label={name} className={cn("flex h-14 shrink-0 items-center gap-2.5 px-4", collapsed && "justify-center px-0")}>
      {collapsed ? (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">{name.charAt(0).toUpperCase()}</span>
      ) : (
        <Logo className="h-7" priority />
      )}
    </Link>
  );
}
