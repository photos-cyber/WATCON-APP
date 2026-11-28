/**
 * Central permission catalogue — the single source of truth for permission keys.
 * Pure module (no server imports) so UI can use it for display decisions; every
 * decision is re-checked server-side in services/policies.
 */

export const ROLE_KEYS = ["SUPER_ADMIN", "ADMIN", "USER", "PROJECT_MANAGER", "SITE_ENGINEER", "PURCHASE", "STOREKEEPER", "ACCOUNTS", "VIEWER"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: "Super Admin",
  ADMIN: "Admin",
  USER: "User",
  PROJECT_MANAGER: "Project Manager",
  SITE_ENGINEER: "Site Engineer",
  PURCHASE: "Purchase Team",
  STOREKEEPER: "Storekeeper",
  ACCOUNTS: "Accounts Team",
  VIEWER: "Management Viewer",
};

/** Roles whose grants a Super Admin edits in Settings (Super Admin always holds everything). */
export const EDITABLE_ROLE_KEYS = ROLE_KEYS.filter((r) => r !== "SUPER_ADMIN") as Exclude<RoleKey, "SUPER_ADMIN">[];
/** Roles that only a Super Admin may assign (users.manage_admins). */
export const ADMIN_ROLE_KEYS: readonly RoleKey[] = ["SUPER_ADMIN", "ADMIN"];

type Group =
  | "Dashboard"
  | "Projects"
  | "Departments"
  | "Team Members"
  | "Tasks"
  | "Reports"
  | "Inventory"
  | "Parties"
  | "Material Planning"
  | "Procurement"
  | "Stores & Site"
  | "Sales & Contracts"
  | "Billing"
  | "Accounts"
  | "Documents"
  | "Administration";

type PermissionDef = {
  key: string;
  name: string;
  group: Group;
  description: string;
  /** Can never be granted to other roles, even if a row exists in role_permissions. */
  superAdminOnly?: boolean;
  defaults: RoleKey[];
};

// Role shorthands for the default grant lists below.
const A = "ADMIN" as const;
const U = "USER" as const;
const PM = "PROJECT_MANAGER" as const;
const SE = "SITE_ENGINEER" as const;
const PU = "PURCHASE" as const;
const SK = "STOREKEEPER" as const;
const AC = "ACCOUNTS" as const;
const VW = "VIEWER" as const;
const ALL_STAFF: RoleKey[] = [A, U, PM, SE, PU, SK, AC, VW];

export const PERMISSIONS = [
  { key: "dashboard.view", name: "View dashboard", group: "Dashboard", description: "Open the dashboard.", defaults: ALL_STAFF },

  { key: "projects.view_all", name: "View all projects", group: "Projects", description: "See every project (and its commercial records), not only projects the user manages, created, belongs to or has tasks in.", defaults: [VW, AC, PU] },
  { key: "projects.create", name: "Create projects", group: "Projects", description: "Create new projects / sites.", defaults: [A] },
  { key: "projects.edit", name: "Edit projects", group: "Projects", description: "Edit details and members of accessible projects.", defaults: [A, PM] },
  { key: "projects.archive", name: "Archive projects", group: "Projects", description: "Archive and restore accessible projects.", defaults: [A] },
  { key: "projects.post_status", name: "Post project status", group: "Projects", description: "Write current-status updates on accessible projects.", defaults: [A, PM] },

  { key: "departments.manage", name: "Manage departments", group: "Departments", description: "Create, edit and deactivate departments and their memberships.", defaults: [A] },

  { key: "members.view", name: "View team directory", group: "Team Members", description: "See the full team member directory and profiles.", defaults: [A, PM, VW] },
  { key: "members.manage", name: "Manage team members", group: "Team Members", description: "Create and edit non-administrator accounts, activate/deactivate them and issue password-reset links.", defaults: [A] },
  { key: "users.manage_admins", name: "Manage administrators", group: "Administration", description: "Create administrators and change any account's role.", superAdminOnly: true, defaults: [] },

  { key: "tasks.view_all", name: "View all tasks", group: "Tasks", description: "See every task in the organization.", defaults: [VW] },
  { key: "tasks.create", name: "Create tasks", group: "Tasks", description: "Create and assign tasks on accessible projects.", defaults: [A, PM] },
  { key: "tasks.manage", name: "Manage tasks", group: "Tasks", description: "Edit, reassign and cancel tasks on accessible projects.", defaults: [A, PM] },
  { key: "tasks.update_assigned", name: "Update assigned tasks", group: "Tasks", description: "Update status and progress of tasks assigned to the user.", defaults: [A, U, PM, SE, PU, SK, AC] },
  { key: "tasks.comment", name: "Comment on tasks", group: "Tasks", description: "Add comments to visible tasks.", defaults: [A, U, PM, SE, PU, SK, AC] },

  { key: "reports.view", name: "Task reports", group: "Reports", description: "Print / export / share project, department, member and global task lists within the user's access.", defaults: [A, PM, VW] },
  { key: "reports.own", name: "Own task report", group: "Reports", description: "Print / export the user's own task list.", defaults: ALL_STAFF },
  { key: "reports.commercial", name: "Commercial reports & exports", group: "Reports", description: "Run and export procurement, stock, billing and accounts reports (rows still limited to accessible projects).", defaults: [A, PM, PU, AC, VW] },

  { key: "items.view", name: "View inventory", group: "Inventory", description: "See items, brands, locations, stock balances and the stock ledger.", defaults: [A, PM, SE, PU, SK, AC, VW] },
  { key: "items.manage", name: "Manage items & brands", group: "Inventory", description: "Create, edit and deactivate items and brands, link brands, set HSN/GST and reorder levels.", defaults: [A, PU] },
  { key: "locations.manage", name: "Manage stock locations", group: "Inventory", description: "Create and edit warehouses and site stores.", defaults: [A] },
  { key: "stock.post", name: "Post stock inward / outward", group: "Inventory", description: "Record manual stock received (inward) and issued (outward).", defaults: [A, SK] },
  { key: "stock.adjust", name: "Manual stock changes", group: "Inventory", description: "Owner only: manual inward / outward, adjustments and reversals of manual entries — each needs a reason and an evidence file. Normal stock moves through receipts, challans and consumption.", superAdminOnly: true, defaults: [] },
  { key: "stock.reserve", name: "Reserve stock", group: "Inventory", description: "Reserve and release stock for projects.", defaults: [A, PM, SK] },
  { key: "stock.transfer", name: "Transfers & challans", group: "Stores & Site", description: "Create, dispatch and cancel delivery challans / stock transfers and returns.", defaults: [A, SK] },
  { key: "stock.consume", name: "Record site consumption", group: "Stores & Site", description: "Record material consumed / installed at a project site.", defaults: [A, PM, SE, SK] },

  { key: "parties.view", name: "View clients & suppliers", group: "Parties", description: "See the client and supplier directory.", defaults: [A, PM, SE, PU, SK, AC, VW] },
  { key: "parties.manage", name: "Manage clients & suppliers", group: "Parties", description: "Create and edit clients and suppliers, GST and bank details.", defaults: [A, PU, AC] },

  { key: "mrp.view", name: "View material planning", group: "Material Planning", description: "See project material requirements, availability and shortages.", defaults: [A, PM, SE, PU, SK, AC, VW] },
  { key: "mrp.manage", name: "Manage material requirements", group: "Material Planning", description: "Add and edit project material requirements.", defaults: [A, PM, SE] },

  { key: "pr.view", name: "View purchase requisitions", group: "Procurement", description: "See purchase requisitions.", defaults: [A, PM, SE, PU, SK, AC, VW] },
  { key: "pr.create", name: "Raise purchase requisitions", group: "Procurement", description: "Create, edit and submit purchase requisitions.", defaults: [A, PM, SE, PU, SK] },
  { key: "pr.approve", name: "Approve purchase requisitions", group: "Procurement", description: "Finalize requisitions (the creator can also finalize them; no separate approval).", defaults: [A, PM] },
  { key: "rfq.view", name: "View rate enquiries", group: "Procurement", description: "See rate enquiries, supplier quotations and comparisons.", defaults: [A, PM, PU, AC, VW] },
  { key: "rfq.manage", name: "Manage rate enquiries", group: "Procurement", description: "Create RFQs, record supplier quotations and propose awards.", defaults: [A, PU] },
  { key: "rfq.approve", name: "Approve RFQ awards", group: "Procurement", description: "Confirm supplier awards (rate-enquiry users award directly; no separate approval).", defaults: [A, PM] },
  { key: "po.view", name: "View purchase orders", group: "Procurement", description: "See purchase orders.", defaults: [A, PM, SE, PU, SK, AC, VW] },
  { key: "po.create", name: "Create purchase orders", group: "Procurement", description: "Create, edit, submit, send and amend purchase orders.", defaults: [A, PU] },
  { key: "po.approve", name: "Approve purchase orders", group: "Procurement", description: "Finalize purchase orders (anyone who creates POs finalizes them in one step). Also amends a finalized PO.", defaults: [A] },
  { key: "po.cancel", name: "Cancel / close purchase orders", group: "Procurement", description: "Cancel purchase orders, including cancelling or short-closing a finalized PO.", defaults: [A] },

  { key: "grn.view", name: "View site receipts", group: "Stores & Site", description: "See GRNs / site material receipts and challans.", defaults: [A, PM, SE, PU, SK, AC, VW] },
  { key: "grn.create", name: "Capture site receipts", group: "Stores & Site", description: "Record received quantities, photos and signed challans and submit them for verification.", defaults: [A, PM, SE, SK] },
  { key: "grn.post", name: "Verify & post GRNs", group: "Stores & Site", description: "Confirm receipts to stock (the receiver also confirms them once proof is uploaded).", defaults: [A, SK, PM] },
  { key: "grn.reverse", name: "Reverse posted GRNs", group: "Stores & Site", description: "Reverse a confirmed receipt (creates reversal stock entries).", defaults: [A] },

  { key: "bills.view", name: "View supplier bills", group: "Accounts", description: "See supplier invoices and their matching status.", defaults: [A, PU, AC, VW, PM] },
  { key: "bills.manage", name: "Enter supplier bills", group: "Accounts", description: "Enter, edit and submit supplier bills and supplier credit/debit notes.", defaults: [A, AC] },
  { key: "bills.approve", name: "Approve supplier bills", group: "Accounts", description: "Finalize supplier bills (bills that match the PO / receipts are finalized by accounts in one step). Also cancels a final bill and applies supplier credit / debit notes.", defaults: [A] },
  { key: "bills.override_match", name: "Override match exceptions", group: "Accounts", description: "Approve a bill despite PO/GRN match exceptions (reason mandatory).", defaults: [] },
  { key: "payments.view", name: "View payments & receipts", group: "Accounts", description: "See supplier payments and client receipts.", defaults: [A, AC, VW, PM] },
  { key: "payments.manage", name: "Record payments & receipts", group: "Accounts", description: "Record supplier payments / client receipts, allocate and reverse them.", defaults: [A, AC] },
  { key: "accounts.view", name: "Project accounts", group: "Accounts", description: "See project financial summaries, ledgers and aging.", defaults: [A, AC, VW, PM] },

  { key: "cpo.view", name: "View client POs", group: "Sales & Contracts", description: "See client purchase orders / contracts.", defaults: [A, PM, AC, VW] },
  { key: "cpo.manage", name: "Manage client POs", group: "Sales & Contracts", description: "Create, edit, submit and amend client purchase orders.", defaults: [A, PM] },
  { key: "cpo.approve", name: "Approve client POs", group: "Sales & Contracts", description: "Finalize client POs, and amend / vary / close / cancel an active client PO.", defaults: [A] },
  { key: "so.view", name: "View sales orders", group: "Sales & Contracts", description: "See sales orders.", defaults: [A, PM, SK, AC, VW] },
  { key: "so.manage", name: "Manage sales orders", group: "Sales & Contracts", description: "Create, edit, submit and amend sales orders.", defaults: [A, PM] },
  { key: "so.approve", name: "Approve sales orders", group: "Sales & Contracts", description: "Confirm sales orders (sales users confirm in one step). Amend / cancel / close of a confirmed order: Super Admin only.", defaults: [A] },

  { key: "rabill.view", name: "View running bills", group: "Billing", description: "See RA bills, measurements and certifications.", defaults: [A, PM, SE, AC, VW] },
  { key: "rabill.manage", name: "Prepare running bills", group: "Billing", description: "Prepare running bills and submit them to the client.", defaults: [A, PM, SE] },
  { key: "rabill.approve", name: "Review & submit running bills", group: "Billing", description: "Submit running bills to the client (preparers submit directly; no internal review).", defaults: [A, PM] },
  { key: "rabill.certify", name: "Record client certification", group: "Billing", description: "Record client-certified quantities, deductions and disputes.", defaults: [A, PM, AC] },
  { key: "invoice.view", name: "View client invoices", group: "Billing", description: "See client tax invoices.", defaults: [A, PM, AC, VW] },
  { key: "invoice.manage", name: "Prepare client invoices", group: "Billing", description: "Draft client invoices and client credit notes.", defaults: [A, AC] },
  { key: "invoice.approve", name: "Issue client invoices", group: "Billing", description: "Issue client invoices (whoever prepares an invoice may issue it). Also cancels an issued invoice and applies client credit / debit notes.", defaults: [A, AC] },

  { key: "attachments.verify", name: "Verify evidence", group: "Documents", description: "Mark attached proofs (photos, signed challans, invoices) verified or rejected.", defaults: [A, PM, SK, AC] },
  { key: "approvals.view", name: "Approvals inbox", group: "Documents", description: "See the cross-module approvals inbox (only items the user may act on).", defaults: [A, PM, AC, PU, SK] },

  { key: "settings.commercial", name: "Commercial settings", group: "Administration", description: "Company GST identity, numbering series, matching tolerances, approval limits and locations.", defaults: [] },
  { key: "settings.company", name: "Company settings", group: "Administration", description: "Edit company name, logo and contact details.", superAdminOnly: true, defaults: [] },
  { key: "settings.roles", name: "Roles & permissions", group: "Administration", description: "Change which permissions each role has.", superAdminOnly: true, defaults: [] },
  { key: "audit.view", name: "Audit log", group: "Administration", description: "View the organization audit log.", superAdminOnly: true, defaults: [] },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as PermissionKey[];

const SUPER_ADMIN_ONLY = new Set<string>(PERMISSIONS.filter((p) => "superAdminOnly" in p && p.superAdminOnly).map((p) => p.key));

export function isSuperAdminOnly(key: string): boolean {
  return SUPER_ADMIN_ONLY.has(key);
}

export function isPermissionKey(key: string): key is PermissionKey {
  return (PERMISSION_KEYS as string[]).includes(key);
}

/** Default grants used by the seed (SUPER_ADMIN implicitly has everything). */
export function defaultPermissionsFor(role: RoleKey): PermissionKey[] {
  if (role === "SUPER_ADMIN") return [...PERMISSION_KEYS];
  return PERMISSIONS.filter((p) => (p.defaults as readonly RoleKey[]).includes(role)).map((p) => p.key);
}

/** Minimal identity used for authorization decisions. */
export type Actor = {
  id: string;
  organizationId: string;
  role: RoleKey;
  permissions: readonly string[];
};

/**
 * The single permission check. SUPER_ADMIN always passes; super-admin-only
 * permissions are never granted to other roles regardless of database rows.
 */
export function can(actor: Pick<Actor, "role" | "permissions">, permission: PermissionKey): boolean {
  if (actor.role === "SUPER_ADMIN") return true;
  if (isSuperAdminOnly(permission)) return false;
  return actor.permissions.includes(permission);
}

export function canAny(actor: Pick<Actor, "role" | "permissions">, ...permissions: PermissionKey[]): boolean {
  return permissions.some((p) => can(actor, p));
}
