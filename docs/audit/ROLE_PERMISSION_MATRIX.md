<!-- AUDIT-2026-11-24 -->
# Role and permission matrix

These are CODE DEFAULTS from src/lib/permissions/definitions.ts, not a dump of production grants. A Super Admin can customize stored grants. SUPER_ADMIN has implicit full access. Project/organization scopes still apply.

| Permission | Super Admin | Admin | User | Project Manager | Site Engineer | Purchase Team | Storekeeper | Accounts Team | Management Viewer |
|---|---|---|---|---|---|---|---|---|---|
| dashboard.view | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| projects.view_all | Yes | No | No | No | No | Yes | No | Yes | Yes |
| projects.create | Yes | Yes | No | No | No | No | No | No | No |
| projects.edit | Yes | Yes | No | Yes | No | No | No | No | No |
| projects.archive | Yes | Yes | No | No | No | No | No | No | No |
| projects.post_status | Yes | Yes | No | Yes | No | No | No | No | No |
| departments.manage | Yes | Yes | No | No | No | No | No | No | No |
| members.view | Yes | Yes | No | Yes | No | No | No | No | Yes |
| members.manage | Yes | Yes | No | No | No | No | No | No | No |
| users.manage_admins | Yes | No | No | No | No | No | No | No | No |
| tasks.view_all | Yes | No | No | No | No | No | No | No | Yes |
| tasks.create | Yes | Yes | No | Yes | No | No | No | No | No |
| tasks.manage | Yes | Yes | No | Yes | No | No | No | No | No |
| tasks.update_assigned | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |
| tasks.comment | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |
| reports.view | Yes | Yes | No | Yes | No | No | No | No | Yes |
| reports.own | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| reports.commercial | Yes | Yes | No | Yes | No | Yes | No | Yes | Yes |
| items.view | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes |
| items.manage | Yes | Yes | No | No | No | Yes | No | No | No |
| locations.manage | Yes | Yes | No | No | No | No | No | No | No |
| stock.post | Yes | Yes | No | No | No | No | Yes | No | No |
| stock.adjust | Yes | No | No | No | No | No | No | No | No |
| stock.reserve | Yes | Yes | No | Yes | No | No | Yes | No | No |
| stock.transfer | Yes | Yes | No | No | No | No | Yes | No | No |
| stock.consume | Yes | Yes | No | Yes | Yes | No | Yes | No | No |
| parties.view | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes |
| parties.manage | Yes | Yes | No | No | No | Yes | No | Yes | No |
| mrp.view | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes |
| mrp.manage | Yes | Yes | No | Yes | Yes | No | No | No | No |
| pr.view | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes |
| pr.create | Yes | Yes | No | Yes | Yes | Yes | Yes | No | No |
| pr.approve | Yes | Yes | No | Yes | No | No | No | No | No |
| rfq.view | Yes | Yes | No | Yes | No | Yes | No | Yes | Yes |
| rfq.manage | Yes | Yes | No | No | No | Yes | No | No | No |
| rfq.approve | Yes | Yes | No | Yes | No | No | No | No | No |
| po.view | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes |
| po.create | Yes | Yes | No | No | No | Yes | No | No | No |
| po.approve | Yes | Yes | No | No | No | No | No | No | No |
| po.cancel | Yes | Yes | No | No | No | No | No | No | No |
| grn.view | Yes | Yes | No | Yes | Yes | Yes | Yes | Yes | Yes |
| grn.create | Yes | Yes | No | Yes | Yes | No | Yes | No | No |
| grn.post | Yes | Yes | No | Yes | No | No | Yes | No | No |
| grn.reverse | Yes | Yes | No | No | No | No | No | No | No |
| bills.view | Yes | Yes | No | Yes | No | Yes | No | Yes | Yes |
| bills.manage | Yes | Yes | No | No | No | No | No | Yes | No |
| bills.approve | Yes | Yes | No | No | No | No | No | No | No |
| bills.override_match | Yes | No | No | No | No | No | No | No | No |
| payments.view | Yes | Yes | No | Yes | No | No | No | Yes | Yes |
| payments.manage | Yes | Yes | No | No | No | No | No | Yes | No |
| accounts.view | Yes | Yes | No | Yes | No | No | No | Yes | Yes |
| cpo.view | Yes | Yes | No | Yes | No | No | No | Yes | Yes |
| cpo.manage | Yes | Yes | No | Yes | No | No | No | No | No |
| cpo.approve | Yes | Yes | No | No | No | No | No | No | No |
| so.view | Yes | Yes | No | Yes | No | No | Yes | Yes | Yes |
| so.manage | Yes | Yes | No | Yes | No | No | No | No | No |
| so.approve | Yes | Yes | No | No | No | No | No | No | No |
| rabill.view | Yes | Yes | No | Yes | Yes | No | No | Yes | Yes |
| rabill.manage | Yes | Yes | No | Yes | Yes | No | No | No | No |
| rabill.approve | Yes | Yes | No | Yes | No | No | No | No | No |
| rabill.certify | Yes | Yes | No | Yes | No | No | No | Yes | No |
| invoice.view | Yes | Yes | No | Yes | No | No | No | Yes | Yes |
| invoice.manage | Yes | Yes | No | No | No | No | No | Yes | No |
| invoice.approve | Yes | Yes | No | No | No | No | No | Yes | No |
| attachments.verify | Yes | Yes | No | Yes | No | No | Yes | Yes | No |
| approvals.view | Yes | Yes | No | Yes | No | Yes | Yes | Yes | No |
| settings.commercial | Yes | No | No | No | No | No | No | No | No |
| settings.company | Yes | No | No | No | No | No | No | No | No |
| settings.roles | Yes | No | No | No | No | No | No | No | No |
| audit.view | Yes | No | No | No | No | No | No | No | No |

Help pages and manual downloads require SUPER_ADMIN independently of editable permission grants; local page and API checks verify denial for the other eight roles. Production role-specific testing was limited to Super Admin. Local role page probes are narrower than full action/API coverage. USER tasks are assignment-scoped; project access follows membership, management, creation or assigned work unless projects.view_all is granted. Accounts, stock and document permissions are separately checked. Sales Department is an operational mapping, not a tenth system role.
