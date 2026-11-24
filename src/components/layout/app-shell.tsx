"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AppHeader, type HeaderUser } from "./app-header";
import { Brand, SidebarNav, type NavUser } from "./app-sidebar";

const STORAGE_KEY = "wc.sidebar.collapsed";

export function AppShell({ user, nav, orgName, unread, children }: { user: HeaderUser; nav: NavUser; orgName: string; unread: number; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // UI preference only (not business data).
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a persisted UI preference after hydration
      setCollapsed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {}
  }, []);

  function toggle() {
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobileOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORAGE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  }

  return (
    <div className="flex min-h-screen">
      <aside className={cn("sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200 lg:flex", collapsed ? "w-16" : "w-60")}>
        <Brand name={orgName} collapsed={collapsed} />
        <div className="flex-1 overflow-y-auto py-2">
          <SidebarNav user={nav} collapsed={collapsed} />
        </div>
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 gap-0 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <Brand name={orgName} />
          {/* The sheet is viewport-high: scroll the nav so the lower groups stay reachable on phones. */}
          <div className="min-h-0 flex-1 overflow-y-auto py-2">
            <SidebarNav user={nav} onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader user={user} unread={unread} onToggleSidebar={toggle} />
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
