import { listCrumbs, lockedProject } from "@/components/procurement/crumbs";
import type { Metadata } from "next";
import { LedgerWithActions } from "@/components/inventory/ledger-with-actions";
import { LocationBalancesTable, LocationDialog, LocationsTable, ReservationsTable, ReserveStockButton } from "@/components/inventory/location-ui";
import { PostMovementButton } from "@/components/inventory/movement-form";
import { StockTable } from "@/components/inventory/tables";
import { PageHeader } from "@/components/shared/page-header";
import { UrlTabs } from "@/components/shared/url-tabs";
import { DateRangeFilter, FilterBar, FilterSelect, SearchInput } from "@/components/tables/filters";
import { Pagination } from "@/components/tables/pagination";
import { requirePagePermission } from "@/lib/auth/session";
import { STOCK_TXN_LABELS } from "@/modules/inventory/rules";
import { toLedgerRow, todayString } from "@/modules/inventory/serialize";
import { getLedger, getStockSummary, inventoryCapabilities, listBrandOptions, listItemCategories, listStockPositionOptions } from "@/modules/inventory/service";
import { listLocationBalances, listLocationOptions, listLocations, listReservations, locationCapabilities } from "@/modules/inventory/locations";
import { listProjectOptions } from "@/modules/projects/service";
import { stockOverview } from "@/modules/inventory/overview";
import { formatQty } from "@/lib/format";

export const metadata: Metadata = { title: "Inventory" };

const TABS = ["overview", "summary", "locations-stock", "ledger", "reservations", "locations"] as const;

export default async function StockPage({ searchParams }: PageProps<"/stock">) {
  const user = await requirePagePermission("items.view");
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(String(sp.tab)) ? (String(sp.tab) as (typeof TABS)[number]) : "overview";
  const caps = { ...inventoryCapabilities(user), ...locationCapabilities(user) };
  const [brands, categories, positions, locations, projects] = await Promise.all([listBrandOptions(user), listItemCategories(user), listStockPositionOptions(user), listLocationOptions(user), listProjectOptions(user, { forTaskCreation: true })]);
  const locked = lockedProject(projects, sp);
  const brandFilter = <FilterSelect param="brandId" label="Brand" options={brands.map((b) => ({ value: b.id, label: b.name }))} />;
  const locationFilter = <FilterSelect param="locationId" label="Location" options={locations.map((l) => ({ value: l.id, label: l.name }))} />;

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Item–brand stock by location, reservations and the complete stock movement ledger."
        breadcrumbs={listCrumbs(locked, "stock")}
        actions={
          <>
            {caps.canReserve && <ReserveStockButton projects={projects} positions={positions} locations={locations} />}
            <PostMovementButton positions={positions} locations={locations} canPost={caps.canPost} canAdjust={caps.canAdjust} today={todayString()} />
          </>
        }
      />
      <UrlTabs
        current={tab}
        tabs={[
          { key: "overview", label: "Stock overview" },
          { key: "summary", label: "Movements by period" },
          { key: "locations-stock", label: "By location" },
          { key: "ledger", label: "Stock ledger" },
          { key: "reservations", label: "Reservations" },
          { key: "locations", label: "Locations" },
        ]}
      />
      {tab === "overview" && <Overview sp={sp} user={user} />}
      {tab === "summary" && (
        <Summary sp={sp} brandFilter={brandFilter} categories={categories} user={user} />
      )}
      {tab === "locations-stock" && <ByLocation sp={sp} brandFilter={brandFilter} locationFilter={locationFilter} user={user} />}
      {tab === "ledger" && <Ledger sp={sp} brandFilter={brandFilter} locationFilter={locationFilter} user={user} canReverse={caps.canReverse} />}
      {tab === "reservations" && <Reservations user={user} canRelease={caps.canReserve} />}
      {tab === "locations" && <Locations user={user} canManage={caps.canManageLocations} projects={projects} />}
    </>
  );
}

type Sp = Awaited<PageProps<"/stock">["searchParams"]>;

/** Physical / reserved / available / incoming / in-transit / site / damaged / reorder per item–brand. */
async function Overview({ sp, user }: { sp: Sp; user: User }) {
  const result = await stockOverview(user, sp);
  const n = "px-2 py-2 text-right tabular-nums whitespace-nowrap";
  const z = (v: string) => (v === "0" ? <span className="text-muted-foreground/50">—</span> : formatQty(v));
  return (
    <>
      <FilterBar params={["q", "filter"]}>
        <SearchInput placeholder="Search item, code or brand…" />
        <FilterSelect param="filter" label="Show" allLabel="All item–brands" options={[{ value: "in-stock", label: "Holding stock" }, { value: "reorder", label: `Needs reorder (${result.reorderCount})` }]} />
      </FilterBar>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Item – brand</th>
              <th className={n} title="Warehouse + site stores">Physical</th>
              <th className={n} title="Open reservations for projects">Reserved</th>
              <th className={n} title="Warehouse stock not reserved for any project">Available</th>
              <th className={n} title="Approved purchase orders not yet received">Incoming</th>
              <th className={n} title="Dispatched on challans, not yet received">In transit</th>
              <th className={n} title="At project site stores">Site</th>
              <th className={n} title="In quarantine (damaged / held)">Damaged</th>
              <th className={n} title="Ordering back up to the target when available + incoming is at or below the minimum">Reorder qty</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {result.rows.map((r) => (
              <tr key={r.itemBrandId}>
                <td className="px-2 py-2">
                  <a href={`/items/${r.item.id}`} className="font-medium hover:text-primary hover:underline">{r.item.name}</a>
                  <div className="text-xs text-muted-foreground">{r.brand} · {r.item.code} · {r.item.unit}</div>
                </td>
                <td className={n}>{z(r.physical)}</td>
                <td className={n}>{z(r.reserved)}</td>
                <td className={`${n} font-medium`}>{z(r.available)}</td>
                <td className={n}>{z(r.incoming)}</td>
                <td className={n}>{z(r.inTransit)}</td>
                <td className={n}>{z(r.site)}</td>
                <td className={`${n} ${r.damaged !== "0" ? "text-rose-700" : ""}`}>{z(r.damaged)}</td>
                <td className={`${n} ${r.reorderQty !== "0" ? "font-semibold text-amber-700" : ""}`}>
                  {z(r.reorderQty)}
                  {r.reorderLevel && <div className="text-[11px] font-normal text-muted-foreground">min {formatQty(r.reorderLevel)}{r.targetStock ? ` · target ${formatQty(r.targetStock)}` : ""}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}
type User = Awaited<ReturnType<typeof requirePagePermission>>;

async function Summary({ sp, brandFilter, categories, user }: { sp: Sp; brandFilter: React.ReactNode; categories: string[]; user: User }) {
  const result = await getStockSummary(user, sp);
  return (
    <>
      <FilterBar params={["q", "brandId", "category", "itemId", "from", "to"]}>
        <SearchInput placeholder="Search item, code or brand…" />
        {brandFilter}
        <FilterSelect param="category" label="Category" options={categories.map((c) => ({ value: c, label: c }))} />
        <DateRangeFilter fromParam="from" toParam="to" label="Period" />
      </FilterBar>
      <p className="mb-2 text-xs text-muted-foreground">Company-wide totals per item–brand across all locations (including goods in transit). Opening includes opening entries and all movements before the period start.</p>
      <StockTable rows={result.rows} />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}

async function ByLocation({ sp, brandFilter, locationFilter, user }: { sp: Sp; brandFilter: React.ReactNode; locationFilter: React.ReactNode; user: User }) {
  const result = await listLocationBalances(user, sp);
  return (
    <>
      <FilterBar params={["q", "brandId", "locationId", "nonZero"]}>
        <SearchInput placeholder="Search item, code or brand…" />
        {locationFilter}
        {brandFilter}
        <FilterSelect param="nonZero" label="Balances" allLabel="In stock only" options={[{ value: "0", label: "Include zero balances" }]} />
      </FilterBar>
      <p className="mb-2 text-xs text-muted-foreground">Available = on hand − reserved (open reservations for projects). Balances are maintained by the posting engine, never by the browser.</p>
      <LocationBalancesTable rows={result.rows} />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}

async function Ledger({ sp, brandFilter, locationFilter, user, canReverse }: { sp: Sp; brandFilter: React.ReactNode; locationFilter: React.ReactNode; user: User; canReverse: boolean }) {
  const result = await getLedger(user, sp);
  return (
    <>
      <FilterBar params={["q", "brandId", "itemId", "type", "locationId", "from", "to"]}>
        <SearchInput placeholder="Search entry, reference, item…" />
        {locationFilter}
        {brandFilter}
        <FilterSelect param="type" label="Type" options={Object.entries(STOCK_TXN_LABELS).map(([value, label]) => ({ value, label }))} />
        <DateRangeFilter fromParam="from" toParam="to" label="Date" />
      </FilterBar>
      <LedgerWithActions rows={result.rows.map(toLedgerRow)} canReverse={canReverse} />
      <Pagination total={result.total} page={result.page} pageSize={result.pageSize} />
    </>
  );
}

async function Reservations({ user, canRelease }: { user: User; canRelease: boolean }) {
  const rows = await listReservations(user);
  return <ReservationsTable rows={rows} canRelease={canRelease} />;
}

async function Locations({ user, canManage, projects }: { user: User; canManage: boolean; projects: { id: string; code: string; name: string }[] }) {
  const rows = await listLocations(user);
  return (
    <>
      {canManage && (
        <div className="mb-3 flex justify-end">
          <LocationDialog projects={projects} />
        </div>
      )}
      <p className="mb-2 text-xs text-muted-foreground">Each project gets a site store automatically when material is first sent or delivered there. In-transit and quarantine are system locations used by transfers and damaged stock.</p>
      <LocationsTable rows={rows.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, isSystem: r.isSystem, status: r.status, address: r.address, project: r.project, positions: r.positions }))} canManage={canManage} projects={projects} />
    </>
  );
}
