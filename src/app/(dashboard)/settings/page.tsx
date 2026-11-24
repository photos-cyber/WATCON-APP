import type { Metadata } from "next";
import Link from "next/link";
import { ChangePasswordForm } from "@/components/forms/change-password-form";
import { CompanyForm } from "@/components/settings/company-form";
import { CommercialSettings } from "@/components/settings/commercial-settings";
import { RoleMatrix } from "@/components/settings/role-matrix";
import { PageHeader } from "@/components/shared/page-header";
import { UrlTabs } from "@/components/shared/url-tabs";
import { FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { EDITABLE_ROLE_KEYS, ROLE_LABELS, can } from "@/lib/permissions/definitions";
import { BrandingForm } from "@/components/settings/branding-form";
import { getBranding } from "@/modules/settings/branding";
import { getCommercialAdmin } from "@/modules/settings/commercial";
import { getOrganization, getRoleMatrix, listAuditLogs } from "@/modules/settings/service";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const user = await requireUser();
  const sp = await searchParams;
  const tabs = [
    { key: "account", label: "My account" },
    ...(can(user, "settings.company") ? [{ key: "company", label: "Company" }] : []),
    ...(can(user, "settings.commercial") ? [{ key: "commercial", label: "Commercial" }] : []),
    ...(can(user, "settings.roles") ? [{ key: "roles", label: "Roles & permissions" }] : []),
    ...(can(user, "audit.view") ? [{ key: "audit", label: "Audit log" }] : []),
    ...(user.role === "SUPER_ADMIN" ? [{ key: "help", label: "Help & guide" }] : []),
  ];
  const tab = tabs.some((t) => t.key === sp.tab) ? String(sp.tab) : "account";

  return (
    <>
      <PageHeader title="Settings" breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }]} />
      <UrlTabs tabs={tabs} current={tab} />
      {tab === "account" && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-semibold">Account</h2>
          <dl className="mt-3 mb-6 grid gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted-foreground">Name</dt><dd>{user.fullName}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Email</dt><dd>{user.email}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Role</dt><dd>{ROLE_LABELS[user.role]}</dd></div>
          </dl>
          <h3 className="mb-3 text-sm font-semibold">Change password</h3>
          <ChangePasswordForm />
        </section>
      )}
      {tab === "company" && <CompanySection organizationId={user.organizationId} />}
      {tab === "commercial" && <CommercialSection user={user} />}
      {tab === "roles" && <RolesSection />}
      {tab === "audit" && <AuditSection user={user} sp={sp} />}
      {tab === "help" && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-semibold">Help & User Guide</h2>
          <p className="mt-1 mb-3 text-sm text-muted-foreground">Step-by-step guides for every module, plus the downloadable user manual. Visible only to Super Admin.</p>
          <Link href="/help" className="text-sm text-primary hover:underline">Open Help & User Guide →</Link>
        </section>
      )}
    </>
  );
}

async function CompanySection({ organizationId }: { organizationId: string }) {
  const [org, branding] = await Promise.all([getOrganization(organizationId), getBranding(organizationId)]);
  return (
    <>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Company profile</h2>
        <CompanyForm initial={{ name: org.name, legalName: org.legalName ?? "", address: org.address ?? "", phone: org.phone ?? "", email: org.email ?? "", logoDataUrl: org.logoDataUrl }} />
      </section>
      <BrandingForm initial={branding} />
    </>
  );
}

async function CommercialSection({ user }: { user: Awaited<ReturnType<typeof requireUser>> }) {
  const data = await getCommercialAdmin(user);
  return <CommercialSettings {...data} />;
}

async function RolesSection() {
  const m = await getRoleMatrix();
  const grantsOf = (k: string) => m.roles.find((r) => r.key === k)?.granted ?? [];
  return <RoleMatrix permissions={m.permissions} roles={EDITABLE_ROLE_KEYS.map((k) => ({ key: k, label: ROLE_LABELS[k] }))} initial={Object.fromEntries(EDITABLE_ROLE_KEYS.map((k) => [k, grantsOf(k)]))} />;
}

async function AuditSection({ user, sp }: { user: Awaited<ReturnType<typeof requireUser>>; sp: Record<string, string | string[] | undefined> }) {
  const logs = await listAuditLogs(user, { page: Number(sp.page) || 1, pageSize: Number(sp.pageSize) || 50, q: typeof sp.q === "string" ? sp.q : undefined, entityType: typeof sp.entity === "string" ? sp.entity : undefined });
  return (
    <section>
      <FilterBar params={["q", "entity"]}>
        <SearchInput placeholder="Search audit log…" />
        <FilterSelect param="entity" label="Entity" options={["user", "project", "department", "task", "organization", "role", "session", "settings", "party", "item", "stock", "location", "reservation", "attachment", "purchase_requisition", "rfq", "purchase_order", "grn", "challan", "supplier_bill", "payment", "client_po", "sales_order", "ra_bill", "client_invoice"].map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))} />
      </FilterBar>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Actor</th>
              <th className="px-3 py-2 text-left font-medium">Action</th>
              <th className="px-3 py-2 text-left font-medium">Details</th>
              <th className="px-4 py-2 text-left font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {logs.rows.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2 text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(l.createdAt)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{l.actor?.fullName ?? "System"}</td>
                <td className="px-3 py-2 font-mono text-xs">{l.action}</td>
                <td className="px-3 py-2">{l.summary ?? "—"}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{l.ipAddress ?? "—"}</td>
              </tr>
            ))}
            {!logs.rows.length && <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No audit entries.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination total={logs.total} page={logs.page} pageSize={logs.pageSize} />
    </section>
  );
}
