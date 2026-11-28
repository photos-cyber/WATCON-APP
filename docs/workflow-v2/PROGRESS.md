# Workflow v2 — Progress

_Last updated: 2026-11-27_

## Resume here

1. Read `PLAN.md` (stage map + phases) and `BUSINESS-RULES.md` (§Open decisions D1–D9 — get owner answers before Phase 4/6).
2. Read `docs/erp/PROGRESS.md` §Safety rules (production DB in `.env`; local DB `npm run db:start`; tests via PowerShell).
3. Baseline check before coding: `npx next typegen`, `npx tsc --noEmit`, `npx eslint src tests`, full Vitest (last known 180/180, 2026-11-21 — not re-run in Phase 1).
4. All phases done; see "Final verification". Remaining: owner approval for production migrations + `npm run db:seed`. Do not commit, push, deploy or migrate production.

## Status

| # | Phase | Status | Notes |
|---|---|---|---|
| 1 | Audit | ✅ 2026-11-26 | Docs only; no code/schema change. Working tree was clean (no uncommitted changes to preserve) |
| 2 | SO & Material Planning | ✅ 2026-11-26 | See "Phase 2" below. Migration applied **locally only** |
| 3 | Rate Enquiries & POs | ✅ 2026-11-26 | See "Phase 3" below. No schema change |
| 4 | Material Receiving | ✅ 2026-11-26 | See "Phase 4" below. No schema change (proof always required for supplier receipts — owner instruction, replaces D1/D2) |
| 5 | Stock & Site Challans | ✅ 2026-11-26 | See "Phase 5" below. Migration `20261126120000_workflow_v2_site_issue` (local only) |
| 6 | Cumulative Running Bills | ✅ 2026-11-26 | See "Phase 6" below. Migration `20261126150000_workflow_v2_running_bills` (local only). D3–D5 resolved by the owner's Phase 6 brief | Migration: `ra_bills.client_po_id` nullable + `so_id`; `ra_bill_lines.client_po_line_id` nullable + `so_line_id`; CHECK one basis; adjust unique `(client_po_id, ra_number)` → per basis |
| 7 | Client Payments | ✅ 2026-11-26 | See "Phase 7" below. Migration `20261126170000_workflow_v2_client_payments` (local only) |
| 8 | Supplier Payments & Project Accounts | ✅ 2026-11-26 | See "Phase 8" below. Migration `20261126190000_workflow_v2_supplier_accounts` (local only) |
| 9 | UI/UX & PDFs | ✅ 2026-11-26 | See "Phase 9" below. No schema change |
| 10 | Testing & Documentation | ✅ 2026-11-27 | See "Final verification" below. Browser-tested on a production build against the disposable `_e2e` DB |

## Phase 1 findings (summary)

- All target stages already exist (models, services, pages, PDFs). v2 is mostly **relaxing hard links, adding prefills/bulk actions, enforcing proof, and merging approval clicks**.
- Hard blockers vs target: (a) project mandatory for planning/PR/RFQ/PO; (b) running bills require a client PO (schema NOT NULL); (c) proof not enforced on receipts.
- Reusable unchanged: stock engine, GRN/challan posting, attachments (camera, GPS, hash, verify), MRP maths, SO→requirement sync, SO amendments, payment allocation/settlement, bill matching, PDFs.

## Phase 2 — Sales Order & Material Planning (done 2026-11-26)

**Built**
- SO line kind `MATERIAL | SERVICE | INSTALLATION` (form selector per line; material needs item–brand; non-material lines drop the item). Only MATERIAL lines sync into requirements on approve / close / cancel / amendment (no manual re-entry).
- New SO form shows editable payment milestones, default 50/40/10 (untick → bill by delivered qty). Saved on create; draft edits recompute percentage schedules. Quotation / client PO conversion unchanged and optional.
- General inventory: requirements with `project_id NULL` (one OPEN per item–brand); `item_brands.target_stock` (+ existing `reorder_level` = minimum); reorder suggestion + manual "still to buy" quantity.
- Line-level allocation: `po_lines.requirement_id`, `rfq_lines.requirement_id` (PR lines already had it). Guard `assertAllocations` in createPr/updatePr/createRfq/createPo/updatePo; RFQ award copies the link when the planned brand is quoted.
- MRP attributes PO/PR/RFQ pipeline via the requirement link; open planning RFQs and REJECTED (re-editable) POs now count as "on order".
- Material Planning tabs (`?plan=`): Project requirements · General inventory · All requirements · Already ordered. Columns: image, item, brand, required, issued, available, reserved, incoming, on order, to order. Bulk actions: Purchase order / Rate enquiry (combined across projects + general stock), Requisition (single project). Row: issue stock to site (challan prefill), reserve, min/target levels, purchase qty.
- RFQ/PO services accept no project (`optionalProjectIdField`) → delivered to WH-MAIN; PO form project field optional.

**Changed files**: `prisma/schema.prisma`, `prisma/migrations/20261126090000_workflow_v2_planning/` (new), `src/modules/planning/{allocation,ordering}.ts` (new), `src/modules/planning/{mrp,service}.ts`, `src/modules/procurement/{po,pr,rfq,actions}.ts`, `src/modules/commercial/pricing.ts`, `src/modules/sales/{sales-order,milestone-billing}.ts`, `src/components/planning/{mrp-section,mrp-table}.tsx`, `src/components/sales/{so-form.tsx,so-initial.ts}`, `src/components/procurement/po-form.tsx`, `src/app/(dashboard)/{material-planning,sales-orders/new,sales-orders/[soId]}/page.tsx`, tests `tests/unit/planning-v2.test.ts`, `tests/integration/planning-v2.test.ts` (new), `tests/integration/procurement-stores.test.ts` (old "project required for RFQ/PO" test rewritten to the new rule).

**Verification**: baseline 222/222 → now **238/238** Vitest (27 files); `tsc --noEmit` clean; `eslint src tests` 0 errors (11 old warnings, none new); `migrate diff` vs schema empty on local dev DB.

**Remaining / blockers**
- Production migration NOT applied (needs owner approval; additive, back-fills SO line kind and PO line requirement links).
- Not browser-tested (no `next build` / Playwright run this phase).
- Combined POs list one line per requirement (same item may repeat); PDF consolidation → Phase 9.
- Received stock from a combined PO lands in WH-MAIN; issuing/reserving to projects is still manual (Phase 5 auto-reserve).
- An award to an alternative brand drops the planning link (re-shows as to-order) — by design, revisit in Phase 3.
- `ClientPoLine.itemBrandId` not added (CPO-prefilled SO lines default to SERVICE until an item is picked).

## Phase 3 — Rate enquiries & purchase orders (done 2026-11-26)

**Built** (no migration)
- Sales order page: **Request rates** / **Purchase order** buttons (planning lines of that SO still to order) → reuse `OrderDialog` + `createRfqFromPlanning` / `createPoFromPlanning`. RFQ lines carry project / SO number in specifications; single-project RFQ gets the site address.
- `convertQuotationToPo` (`procurement/rfq.ts`): one quotation → draft PO with quoted rates, GST, freight (charges), delivery days → expected date, payment terms/advance/credit; enquiry items, project, delivery, requirement links. Partial / split across suppliers; never beyond each enquiry line's open qty (RFQ row lock). Enquiry → AWARDED when all lines are on POs. UI: **Create PO** per quotation on the enquiry page; comparison / award stay optional.
- Award flow: POs created from an approved award are **APPROVED** (approver = award approver) — no second approval.
- PO **Finalize** (`poAction "finalize"`): approves in one click when the user passes `assertCanApprove` against the creator (permission, SoD, limit; Super Admin exempt), else → PENDING_APPROVAL. Returns `{ approved }`. `getPo().can.finalize / finalizeApproves / pay`.
- PO detail page simplified: summary cards (ordered, received, pending, expected delivery — overdue flag, purchase value, paid), items table (ordered / received / pending / rate / GST / amount, "for" project or general stock per line), supplier-delivery-payment panel, related docs (incl. sales orders traced via requirement links), attachments. Actions: Finalize, PDF + Share (DocShare), Receive material, Record supplier bill, Record supplier payment.
- Allocations: open RFQ lines now count only their part not yet on a live PO (partial conversions keep the rest allocated); a PO line from a quotation takes over the enquiry's open qty instead of adding to it.
- Requisitions are not needed anywhere (wording updated in the shortage hint).

**Changed files**: `src/modules/procurement/{po,rfq,trace,actions}.ts`, `src/modules/planning/{allocation,ordering,service}.ts`, `src/modules/insights/workspace.ts`, `src/components/procurement/{po-actions,rfq-workflow}.tsx`, `src/components/planning/mrp-table.tsx` (export `OrderDialog`, new `PlanOrderButtons`), `src/app/(dashboard)/{purchase-orders/[poId],rate-enquiries/[rfqId],sales-orders/[soId]}/page.tsx`, tests `tests/integration/purchasing-v2.test.ts` (new), `tests/integration/procurement-stores.test.ts` (award POs now approved).

**Verification**: see Log. **Not browser-tested.**

**Remaining**: alternative-brand quotations still drop the planning link (PO line has no requirement); freight is copied in full on each partial conversion (edit the draft if splitting); PO PDF still lists one line per requirement on combined orders (Phase 9).

## Phase 4 — Material receiving with mandatory proof (done 2026-11-26)

**Built** (no migration)
- PO page **Receive material** → `/site-receipts/new?poId=` → receiving form (PO ref, item–brand, ordered / previously received / pending, received today, damaged, rejected, accepted shown, date, delivery location, receiver name, supplier challan ref, remarks, optional GPS). "Next: add photos" saves a **draft GRN** automatically and opens its page at the proof checklist.
- Proof rules `src/modules/stores/proof-rules.ts` (shared by UI + server): supplier receipts need ≥1 **material photo** (image), **delivery proof** (DELIVERY_CHALLAN / SIGNED_CHALLAN / SUPPLIER_INVOICE, image or PDF), and **damage photo** when any line has damaged or rejected qty. Enforced in `stores/grn.ts`: createGrn(submit) refused, updateGrn(submit), grnAction submit, and re-checked in postGrn. `getGrn()` returns `proof`.
- `components/stores/receipt-proof.tsx`: one box per required proof, camera capture, picker, image previews, per-file progress (XHR), retry / remove on failure; Submit button disabled with "Add first: …" until complete (`GrnActions proofMissing`).
- Posting unchanged and reused: stock RECEIPT at the PO's delivery location (project SITE for project POs = direct supplier-to-site; WH-MAIN for general stock), PO line counters + status, planning (issued / incoming) via existing aggregates, idempotent movements `grn:<id>:<line>`, row-locked over-receipt guard, SoD on posting, evidence locked after posting, audit rows.
- Supplier bills never post stock (verified by test). Legacy audit: `src/modules/inventory/integrity.ts` + `scripts/audit-stock-postings.ts` (read-only; run `DATABASE_URL=<local> npx tsx --conditions=react-server scripts/audit-stock-postings.ts`). Local dev DB: **0 errors, 0 warnings**. Production not audited (needs approval).

**Changed files**: `src/modules/stores/{grn,proof-rules}.ts` (proof-rules new), `src/modules/inventory/integrity.ts` (new), `scripts/audit-stock-postings.ts` (new), `src/components/stores/{grn-form,actions,receipt-proof}.tsx` (receipt-proof new), `src/app/(dashboard)/site-receipts/[grnId]/page.tsx`, tests: `tests/integration/receiving-v2.test.ts` (new), `commercial-helpers.ts` (`addReceiptProof`, `receiveWithProof`), PO-receipt call sites in `procurement-stores`, `payables`, `insights`, `complete-training-workflow` now go draft → proof → submit.

**Remaining**: internal transfer (challan) receipts have no proof rule yet (Phase 5); not browser-tested (camera / XHR progress need a device check).

## Phase 5 — Stock management & site challans (done 2026-11-26)

**Built**
- **Stock overview** tab (Inventory page, first tab): per item–brand physical (warehouse + sites), reserved, available (warehouse − warehouse reservations), incoming (approved POs open), in transit, site, damaged (quarantine), reorder qty (target/minimum when available + incoming ≤ minimum). `src/modules/inventory/overview.ts`.
- **Issue material to site** (project header button → `/projects/[id]/issue`): SO material requirements with required / issued (incl. in transit) / remaining / available at the chosen warehouse (minus other projects' reservations) / reserved here; select items, **Save draft** (no stock movement) or **Issue challan** (create + dispatch in one transaction: warehouse → TRANSIT). Idempotent via new `challans.client_key`. `src/modules/stores/site-issue.ts`, `components/stores/site-issue-form.tsx`; challan service split into `createChallanTx` / `dispatchChallanTx`.
- **Site receipt proof** (`stores/proof-rules.ts`): challan receipts need material photo + **signed challan** (SIGNED_CHALLAN / DELIVERY_CHALLAN) + damage photo when damaged; enforced like PO receipts (create-with-submit refused, submit, edit-submit, post re-check). Receiving form for challans now "Next: add photos".
- Partial receipts, damage (→ QC-HOLD), shortages (close discrepancy: return / write off), returns (RETURN_TO_STORE / RETURN_TO_SUPPLIER), direct supplier-to-site (Phase 4), reversals (GRN reverse puts stock back in transit) — existing engine, now covered by tests.
- **Manual stock changes owner-only**: `stock.adjust` is `superAdminOnly` (role grants ignored). Every manual INWARD / OUTWARD / ADJUSTMENT needs a reason + evidence file stored in the same transaction (`storeEvidenceTx`, entity `stock_txn`, resolver `stockTxnAccess`, evidence never deletable). Movement form sends FormData (input JSON + file). Reversal of manual entries: Super Admin + reason.
- Planning: in-transit / issued-to-site / damaged figures normalised (were raw "60.000").

**Changed files**: `prisma/schema.prisma`, migration `20261126120000_workflow_v2_site_issue/`, `src/lib/permissions/definitions.ts`, `src/modules/inventory/{overview,validation,service,repository,locations,actions}.ts` (overview new), `src/modules/documents/{attachments,access}.ts`, `src/modules/stores/{site-issue,challan,grn,proof-rules,actions}.ts` (site-issue new), `src/modules/planning/service.ts`, `src/components/stores/{site-issue-form,grn-form}.tsx` (site-issue-form new), `src/components/inventory/movement-form.tsx`, `src/app/(dashboard)/{stock,projects/[projectId],projects/[projectId]/issue}/page.tsx` (issue page new), tests `tests/integration/stock-site-v2.test.ts` (new), `inventory.test.ts` + `foundation.test.ts` (manual moves now Super Admin + evidence), `procurement-stores.test.ts` (challan receipts via proof), `commercial-helpers.ts`.

**Deploy notes**: run `npm run db:seed` (RBAC sync) after migrating so the `stock.adjust` description updates; the owner-only rule is enforced in code either way. **Remaining**: client-delivery (external) challans still confirm delivery without mandatory POD; not browser-tested.

## Phase 6 — Automatic cumulative running bills (done 2026-11-26)

**Built**
- Schema (additive): `ra_bills.client_po_id` nullable + `so_id` (CHECK exactly one), `previous_value`, `previous_billed`, `previous_outstanding`, `received_to_date`, `is_final`; `ra_bill_lines.client_po_line_id` nullable + `so_line_id` (CHECK exactly one), `delivered_qty`. Unique `(so_id, ra_number)`, `(ra_bill_id, so_line_id)`.
- `src/modules/sales/so-running-bill.ts`:
  - `soBillingPosition`: delivered material per SO line = posted site receipts (RECEIPT / TRANSFER_IN at the project site) − site transfers out / returns to supplier + client deliveries from a warehouse (reversals net). It is shared FIFO across the project's approved orders and capped at the order qty.
  - Already billed = live running-bill lines (certified qty once certified, else claimed) + tax invoices raised outside running bills.
  - Services and installation are billable up to the order qty.
- `generateSoRunningBill`:
  - Builds the next bill at the SO selling rates (net of discount, SO GST). One DRAFT per order: generating again **refreshes / consolidates** it.
  - Defaults: material = all unbilled delivered; services = 0, or the rest on a **final** bill.
  - Retention % and other deductions. Advance recovery is automatic (proforma advance received × share billed; everything left on the final bill) or entered, capped at the advance still to recover.
  - Contract and delivery limits are enforced under a row lock on the SO. Nothing can be billed after the final bill.
- Cumulative statement snapshot: previous value / current / cumulative, previously billed, previous outstanding (issued invoices net − received − adjusted, draft invoices, previous bills not yet invoiced), received to date, **total payable = previous outstanding + this bill**. The invoice carries only this bill → no duplicate receivables or taxes. `previousBillsWithOutstanding` lists earlier bills.
- `ra-bill.ts`, `invoice.ts`, `pdf.ts` handle both bases. Certification refreshes SO-bill deductions and the statement. RA → invoice copies certified SO lines (with `soLineId`) and increments `so_lines.invoiced_qty`; cancelling the invoice reverses it.
- One billing basis per SO: SO delivery invoices are refused once running bills exist; milestone **tax** invoices are refused (advance proformas are allowed and recovered); running bills are refused after milestone tax invoices. SOs linked to a client PO keep billing on the client-PO running bill.
- UI:
  - SO page **Running bill** → `/running-bills/new?soId=` (`components/sales/so-ra-ui.tsx`: statement, lines with order / delivered / billed / can-bill / this bill, deductions, final).
  - Bill page: cumulative statement, previous bills with outstanding, refresh form for drafts.
  - PDF: statement strip, previous / this / cumulative columns, delivered qty, previous bills section, total payable.

**Changed files**: `prisma/schema.prisma`, migration `20261126150000_workflow_v2_running_bills/`, `src/modules/sales/{so-running-bill (new),ra-bill,invoice,milestone-billing,pdf,shared,client-po,actions}.ts`, `src/modules/insights/workspace.ts`, `src/components/sales/{so-ra-ui (new),tables}.tsx`, `src/app/(dashboard)/{running-bills/new,running-bills/[raId],running-bills/[raId]/edit,sales-orders/[soId]}/page.tsx`, tests `tests/integration/running-bills-v2.test.ts` (new, 7 tests incl. the owner's ₹1,00,000 → ₹2,00,000 example).

**Remaining**:
- Retention release (a final retention invoice) is not built.
- Running bills are not offered for SOs linked to a client PO (by design: bill on the client PO).
- Not browser-tested.

## Phase 7 — Client payments & outstanding balances (done 2026-11-26)

**Built**
- **Record client payment**, one reusable action (`components/payables/client-account.tsx` `RecordClientPaymentButton` → `/payments/new?direction=IN&projectId&partyId[&invoiceId]`). It appears on the project Accounts tab, sales order, running bill (once invoiced), client invoice and Accounts page.
- **Payment form** (existing, extended): client, project, amount, date, method, reference, **Settle invoices / Keep as advance** toggle, auto-suggested allocation (oldest due first) or manual, remarks, **supporting proof** (saved with the payment in one transaction via `storeEvidenceTx`, category PAYMENT_PROOF).
- Already supported and now tested:
  - partial payments;
  - several payments on one invoice;
  - one payment across several invoices;
  - idempotent submit;
  - allocation caps (invoice outstanding, same project and client, no duplicates);
  - advance allocation later ("Allocate advance");
  - allocation reversal;
  - payment cancellation.
- **Authorised refunds** of client advances: `refundClientAdvance` needs `invoice.approve`, a person other than the receipt's recorder (unless Super Admin) and the REFUND approval limit. It's recorded as an OUT payment with `refund_of_id` (series RFND) and increments `payments.refunded_amount` (DB CHECK: allocated + refunded ≤ received). Cancelling the refund restores the advance; a receipt with a live refund can't be cancelled. Refunds are excluded from supplier "paid" and subtracted from "received" in project financials and payment-list advances.
- **Client account summary** (`src/modules/sales/client-account.ts`), per project or per sales order:
  - contract value, total invoiced (issued tax invoices), received (allocated), outstanding billed, overdue;
  - unbilled = contract − invoiced;
  - client advances = unallocated receipts − refunds + proforma advance not yet adjusted;
  - payment received = allocated + advances held + advances adjusted (each rupee counted once);
  - remaining contract payment = contract − payment received;
  - next payment milestone, driven by payments (first milestone not covered by cash received).
- `ClientAccountCard` appears on the project Accounts tab and the sales order page.
- **Payment Receipt PDF** (`payables/pdf.ts`): titled Payment Receipt / Refund Voucher, with an account-position strip, allocations, advance note and refunds list.

**Changed files**: `prisma/schema.prisma`, migration `20261126170000_workflow_v2_client_payments/`, `src/lib/doc-numbering.ts` (RFND), `src/modules/payables/{payments,actions,pdf}.ts`, `src/modules/sales/client-account.ts` (new), `src/modules/insights/finance.ts`, `src/components/payables/{client-account (new),payment-form,payment-actions}.tsx`, `src/app/(dashboard)/{payments/[paymentId],projects/[projectId],sales-orders/[soId],running-bills/[raId],client-invoices/[invoiceId],accounts}/page.tsx`, tests `tests/integration/client-payments-v2.test.ts` (new, 6 tests incl. the owner's 10L / 6.5L / 4L example).

**Remaining**:
- A single-order view cannot attribute project-level unallocated receipts to that order; they are shown separately.
- Not browser-tested.

## Phase 8 — Supplier bills, payments & project accounts (done 2026-11-26)

**Built**
- **From the PO:**
  - "Record supplier bill" (existing prefill: PO, supplier, receipts, project, material lines; partial quantities; invoice attachments on the bill page).
  - "Record supplier payment", which now opens with `poId`: supplier, project or general stock and the PO link are pre-filled, and anything not set against bills stays as a **supplier advance on that PO** (`payments.po_id`, CHECK OUT only).
  - The PO page shows those payments and the advance on the PO.
  - A PO-linked advance can only settle that PO's bills.
  - Payment proof works as in Phase 7.
- **General-stock purchases:** bills for a general / combined PO have no project. Supplier payments may have no project when made against such a PO; otherwise a project is still required. They are never charged to a project.
- **Bills never move stock:** re-verified in this phase's tests.
- **Fixed:** proforma invoices were counted as billed revenue in `projectFinancials` (now tax invoices only). Client refunds are excluded from supplier "paid".
- **`src/modules/insights/project-accounts.ts`:**
  - `projectAccountsDashboard`, client side: reuses Phase 7 `clientAccount`.
  - Supplier side: PO value (commitment, incl. combined-PO lines allocated to the project), supplier bills, payments made, advances, outstanding.
  - Material cost (actual attributable): site receipts at purchase cost + issues / client deliveries from stock at average cost − returns. General stock counts only when issued.
  - Other expenses: non-stock bill lines + freight / charges.
  - Estimated remaining cost: open requirements × last rate (unpriced lines counted).
  - Estimated profit = contract excl. GST − costs.
  - Recognised revenue = issued tax invoices excl. GST. Actual margin shown once invoiced.
- `projectTransactions`: chronological history (invoices, proformas, receipts, refunds, running bills, supplier bills, supplier payments, notes, posted receipts with value, challans), each linked and with a proof count.
- `accountsReconciliation`: invoice received / bill paid / payment allocated / refunded vs live allocations and refunds. It is also printed by `scripts/audit-stock-postings.ts` (local dev DB: 0 mismatches).
- **Project Accounts tab:** rebuilt as a simple dashboard (client side with Record client payment, supplier side, financial summary, transaction history).

**Changed files**: `prisma/schema.prisma`, migration `20261126190000_workflow_v2_supplier_accounts/`, `src/modules/payables/{payments,bills}.ts`, `src/modules/procurement/po.ts`, `src/modules/insights/{finance,project-accounts (new)}.ts`, `src/components/payables/payment-form.tsx`, `src/components/procurement/po-actions.tsx`, `src/app/(dashboard)/{payments/new,purchase-orders/[poId],projects/[projectId]}/page.tsx`, `scripts/audit-stock-postings.ts`, tests `tests/integration/accounts-v2.test.ts` (new, 5 tests).

**Remaining**:
- Expenses not on supplier bills (site labour paid in cash, overheads) have no entry form yet — "other expenses" covers what is recorded on supplier bills.
- Damaged stock written off is not yet charged as project cost.
- Not browser-tested.

## Phase 9 — Enterprise UX simplification & PDFs (done 2026-11-26)

No schema change, no new dependency, no new route.

- **Sidebar** (`components/layout/app-sidebar.tsx`), grouped as:
  - Dashboard / Approvals / Projects / Tasks
  - Sales: sales orders, quotations, client POs, running bills, client invoices, clients
  - Purchases: material planning, POs, rate enquiries, requisitions, supplier bills, suppliers
  - Inventory: stock, material receipts, site challans, items, brands
  - Accounts: project accounts, payments & receipts, credit/debit notes
  - Reports: reports, documents
  - Settings: departments, team, administration

  Permissions are unchanged, and Help is still Super Admin-only inside Settings.
- **Project tabs:** Overview, Tasks, Sales Orders, Materials, Purchases, Site Challans, Running Bills, Accounts, Documents. Each is a group over the existing tab keys, so old `?tab=` links still work.
- **Action Required** (`modules/insights/action-required.ts`, shown first on the project Overview). It has seven cards, each permission-gated and each opening the filtered records:

  | Card | Opens |
  |---|---|
  | Materials needing ordering | planning tab `status=TO_ORDER` (new filter) |
  | Ready to issue | `/projects/[id]/issue` |
  | POs awaiting delivery | `/purchase-orders?pending=1` |
  | Receipts awaiting proof | `/site-receipts?status=DRAFT`, checked with `evaluateProof` |
  | Deliveries ready for billing | new running bill for the SO, or the running-bills tab |
  | Client outstanding | `/client-invoices?outstanding=1` (new filter, also in the filter bar) |
  | Supplier payments due | `/supplier-bills?view=unpaid` |

  Billing positions are computed in parallel.
- **Next actions:**
  - Supplier bill: draft → submit, waiting for approval, to pay (opens "Record supplier payment" pre-filled), paid.
  - Payment: advance held / fully set.
  - Challan: delivered → running bills.
  - Approved SO: adds "Issue material to site" and "Running bill".
- **Forms:**
  - Advanced fields are collapsed under "More details":
    - receipt: vehicle, supplier invoice, GPS;
    - payment: bank account;
    - PO: terms, internal remarks, rounding.
  - Receipt lines show item thumbnails (`receiptSource` returns `image`).
- **PDFs:**
  - PO / requisition without a project now read "General stock (no project)" instead of "Central store".
  - Site challans carry an "On receipt at site" checklist (count, note damage, sign and upload photo proof). The challan's "Received by" is filled from the posted site receipt.
  - First running bills no longer print zero "previous outstanding / total payable" rows, so the signatures stay on page 1. Those rows still print when there is a previous balance.
  - New **Project Accounts Statement** (`modules/insights/accounts-pdf.ts`, type `project_accounts`, needs `accounts.view`). It has a Preview/Download/Print button on the project Accounts tab.
- **Visual check:** `tests/integration/pdf-render-v2.test.ts` builds a real flow (general-stock PO → issue challan → site receipt → running bill → invoice → receipt) and renders the PO, Challan, Running Bill, Payment Receipt and Accounts Statement. With `RENDER_PDF_DIR=<dir>` it keeps the files. They were converted with `node scripts/pdf-to-png.mjs` and inspected: branded layout intact, figures consistent, one page each.

**Changed files**:
- `src/components/layout/app-sidebar.tsx`
- `src/app/(dashboard)/`:
  - `projects/[projectId]`
  - `supplier-bills/[billId]`
  - `payments/[paymentId]`
  - `challans/[challanId]`
  - `sales-orders/[soId]`
  - `client-invoices` page
- `src/components/`:
  - `insights/command-center.tsx`
  - `planning/mrp-section.tsx`
  - `stores/grn-form.tsx`
  - `payables/payment-form.tsx`
  - `procurement/po-form.tsx`
- `src/modules/`:
  - `insights/{action-required,accounts-pdf}.ts` (new)
  - `planning/service.ts`
  - `sales/{invoice,pdf}.ts`
  - `stores/grn.ts`
  - `documents/pdf-models.ts`
- Tests: `tests/integration/pdf-render-v2.test.ts` (new)

**Remaining**:
- Combined POs still print one line per requirement.
- Searchable dropdowns: the existing combobox pickers are kept; no new picker was added.
- Not browser-tested at phone width. The receipt form already stacks on mobile.

## Simplification v3 (owner brief 2026-11-27: "only amendments need Super Admin")

Policy: helpers in `modules/commercial/core.ts` (`isSuperAdmin`, `requireSuperAdmin`, `requireAnyPermission`). No schema change.

### Batch 1 — approvals & permissions (done 2026-11-27)
- **One-step finalize, no second person** (no SoD, no approval limit) for any user with the document's create/manage permission:
  - quotation → APPROVED;
  - SO "Confirm order" → APPROVED (contract-ceiling check + requirement sync + project status);
  - client PO → ACTIVE;
  - requisition → APPROVED;
  - rate-enquiry award → AWARDED;
  - PO "Finalize PO" → APPROVED (keeps receipt status on re-finalized amendments);
  - receipt "Confirm receipt" → POSTED to stock in the same transaction (proof still mandatory; `postGrnTx`);
  - running bill "Submit to client" → SUBMITTED (internal review removed);
  - invoice: the drafter may issue.
- Supplier bill "Save & finalize" → APPROVED when it matches the PO/receipts. On match exceptions it is held (PENDING_APPROVAL) until a user with `bills.override_match` accepts it with a reason, or it is returned for correction.
- Old `approve` actions stay so records left PENDING / SUBMITTED / INTERNAL_REVIEW / AWARD_PENDING can be cleared by the document's users. The Inbox (`/approvals`, was "Approvals") lists those, plus SO amendments and held bills.
- **Super Admin only** (finalized stock/money):
  - SO close/cancel;
  - client PO amend/variation/close/cancel (when active);
  - PO amend / cancel (once final) / short-close;
  - receipt reversal;
  - cancel of an approved bill;
  - cancel of a certified running bill;
  - cancel of an issued invoice;
  - credit/debit note approve and cancel;
  - payment cancel and allocation reversal.

  Drafts stay editable and cancellable by their users. Manual stock adjustment and write-off stay owner-only.
- **Request change** (`modules/commercial/change-request.ts` and `-actions.ts`, `components/commercial/request-change.tsx`): non-Super Admins on a finalized PO, receipt, bill, running bill, invoice, payment or client PO send a reason. Every active Super Admin is notified (link) and an audit row `change.requested` is written on the document.
- UI labels: Finalize / Confirm order / Confirm receipt / Submit to client / Return for changes. Status badges: Final, Waiting, Returned, Ready to submit. "Awaiting approval" banners were replaced by next-step text, and workspace counters now read "to finalize" / "to confirm". Permission descriptions were updated (run `npm run db:seed` to refresh them in the DB).
- Tests: approval-era assertions rewritten to the new rules; new `tests/integration/simplified-workflow.test.ts`. **Full Vitest 286/286**, tsc clean, eslint 0 errors.

### Batch 2 — SO & procurement (done 2026-11-27)
- One-click save + finalize:
  - SO form "Save & confirm order" (`createSalesOrderAction` / `updateSalesOrderAction` `{ confirm }`);
  - PO form "Save & finalize PO" (`createPoAction` / `updatePoAction` `{ finalize }`);
  - Material Planning order dialog "Create & finalize PO" (`createPoFromPlanningAction` `{ finalize }`).

  The finalize step runs server-side right after the save, with a fresh version. If it fails, the draft is kept and the reason is shown.
- Requisitions moved to the end of the Purchases menu as "Requisitions (optional)".

### Batch 3 — receiving & challans (done 2026-11-27)
- A client-delivery challan can be confirmed **only after** a signed challan / POD (SIGNED_CHALLAN or DELIVERY_CHALLAN) is uploaded on it. This is checked on the server (`hasDeliveryProof`), and the button stays hidden until then (`getChallan().podMissing`, page banner).
- Receipts confirm straight to stock (Batch 1). Phase 4/5 proof rules unchanged.

### Batch 4 — running bills & payments (done 2026-11-27)
- **"Client accepted — invoice now"** on a bill with the client (`modules/sales/quick-bill.ts` `acceptRaBillAndInvoice`, action `acceptRaBillAndInvoiceAction`). In one click it:
  - certifies every line at the claimed quantity (existing deductions kept);
  - creates the invoice;
  - issues it.

  Each step reuses the existing checked service. If issuing fails (e.g. no place of supply), the invoice stays as a draft with a warning. Partial certification still uses "Record certification".
- Payment recording, milestones (50/40/10) and the account summary are unchanged from Phases 7–8; recording payments needs no approval.

### Batch 5 — navigation & UI (done 2026-11-27)
- Sidebar follows the daily flow: Sales (SO → Running Bills → Invoices, then Quotations / Client POs); Purchases (Planning → POs → Rate Enquiries → Supplier Bills); "Approvals" renamed "Inbox".
- Remaining approval wording replaced on dashboards / lists (to confirm, to finalize, Award to confirm, Waiting for Super Admin).

### Project "Order flow" panel (2026-11-27, owner request)
- `projectOrderFlow` now shows 8 steps:
  1. Client quotation / PO (**optional**; never picked as "Next");
  2. Sales order;
  3. Material planning;
  4. Rates & purchase orders;
  5. Receive material;
  6. Issue to site (challans, in transit, site receipts, client deliveries);
  7. Running bills & invoices;
  8. Client payments.
- The Requisitions step was removed (requisitions are optional).
- Actions jump to the real next screen: Order from planning, Finish receipts, Issue material to site, Confirm site receipt, Generate running bill (`?soId=`), Record client payment. Full Vitest 288/288.

### Batch 6 — guides & regression (done 2026-11-27)
- In-app Help (`src/modules/help/content.json`): approval steps rewritten (Finalize / Confirm / Request change / Client accepted). Markdown guides (`docs/user-guide/*.md`) regenerated from it.
- **Not regenerated:** `WATCON_USER_GUIDE.pdf/.docx` and `QUICK_START_GUIDE.pdf` — `scripts/build-user-manuals.py` could not load `.audit-tools` (permission denied in this session). Run it locally to refresh them. Screenshots still show the old button names.
- Regression: `next typegen` ok, `tsc --noEmit` clean, `eslint src tests` 0 errors (the 11 old warnings), **full Vitest 288/288 (35 files)**.
- Not browser-tested this round. No commit, push, deploy or migration. No schema change in v3.

## SO / PO driven workflow correction (2026-11-27)

**Client-PO dependencies removed**
- `so-running-bill.ts`: an SO linked to a client PO is no longer refused. Only a client PO with its own live running bills (legacy) keeps billing there. The client-PO line ceiling is applied inside `soBillingPosition`. The lock order is client PO → SO.
- `shared.ts` `cpoLineBilled` also counts SO running-bill lines of linked orders. `ra-bill.ts` refuses a client-PO bill once its orders are billed on SO bills. `legacyClientPoBilling()` was added.
- `/running-bills/new` picker is now project → confirmed sales orders, plus a "legacy client-PO" list. The client-PO page's "New running bill" link leads to that picker.
- SO page: the running-bill button is no longer hidden for orders with a client PO. The client PO shows only when one is linked.

**Contract value** (`client-account.ts`, `insights/finance.ts`, `insights/project-accounts.ts`): confirmed SOs + client POs with no confirmed SO. `action-required.ts` and `workspace.ts` also offer billing for client-PO-linked orders.

**Site challan traceability**
- `site-issue.ts` takes an optional `soLineId` per line. It is validated, or auto-linked when only one confirmed order carries the item.
- The issue form shows an order picker when several orders carry the item; rows are keyed by requirement.
- `challan.ts` validates SO-line links on internal challans.
- `soBillingPosition` assigns traced site receipts first, then FIFO.

**Client receipts against an SO**
- Migration `20261127100000_so_po_driven_payments`: `payments.so_id` + FK + CHECK (receipts only) + partial index. Applied to the **local dev DB and test/e2e DBs only**.
- `payments.ts`: `soId` validation; an SO receipt settles only that SO's invoices; `outstandingInvoices(..., soId)`.
- `/payments/new?soId=` and `RecordClientPaymentButton soId`.

**Summaries**
- `ClientAccount` adds `deliveredValue` and `runningBillValue`. The SO view counts receipts recorded against the order.
- SO page: "Order financial summary", original vs revised value, actions (Generate running bill, Create invoice when billing by delivery, Record client payment, View accounts), running bills and receipts in related docs.
- `getPo().financial` and the PO page "Financial summary" + "View accounts".
- Running bill PDF prints "Client PO (ref.)" only when the order has one.

**Backfill**: `scripts/backfill-so-links.ts` (dry run by default; `--apply`). It links site-issue challan lines when exactly one order line matches. It reports ambiguous lines and receipts without an SO, and never assigns those. On the local dev DB nothing needed linking.

**Tests**: `tests/integration/so-po-driven.test.ts` (8 tests, owner's Tests 1–9). Full Vitest **296/296 (36 files)**. `tsc` clean. `eslint` 0 errors (the 11 old warnings).

**Not done / blockers**
- Browser workflow not run. Another `next dev` from this folder (port 3000, using `.env` = production DB) was already running, and Next refuses a second dev server. It was left untouched.
- Production migration not applied.
- Test 10 (PDFs): the running-bill PDF reference was changed, but PDFs were not re-rendered and inspected this round.

## Final verification (2026-11-27)

**Setup / isolation**: `tests/e2e/prepare-db.mjs` reset `watcon_e2e` (refuses any DB not ending `_e2e`), migrations applied there only. Seed: E2E Super Admin, org GST (state 06), 2 item–brands (scratch script via app services), `scripts/test-data.ts seed` ([TEST] parties + PRJ-0001). Production build run with `DATABASE_URL`/`DIRECT_URL` = `watcon_e2e`, served by `next start -p 3100`. Isolation confirmed: only the E2E-only account could sign in; direct query `current_database() = watcon_e2e`. `.env` / production DB never used. Note: a `next dev` on port 3000 (PID 31152, uses `.env` = production) was **still running** and was left untouched.

**Browser walk-through (Playwright, production build) — all PASS**
| Area | Result |
|---|---|
| SO (no client PO): 2 material + 1 installation line, 50/40/10 milestones, "Save & confirm order" | ✅ one step, requirements synced |
| Client advance ₹1,00,300 against the SO (proof attached) | ✅ held as SO advance |
| Project PO from SO ("Create & finalize PO") | ✅ PO-0001 final in one click |
| Receipt with damage: proof boxes 3 → 2 → 1, Confirm locked until complete | ✅ posted to site stock (3 pumps accepted, 1 damaged, 60 m) |
| RA-1 (no client PO) → Submit → "Client accepted — invoice now" | ✅ INV-0001 issued |
| Duplicate billing: billed lines show "Max 0", Prepare disabled | ✅ |
| Advance allocated; partial ₹5,000; RA-2 previous outstanding ₹4,440, total payable ₹18,600, invoice only ₹14,160 | ✅ |
| General inventory: "Add stock purchase" → combined PO (no project) → WH receipt with proof → issue challan → site receipt with signed-challan proof | ✅ |
| Supplier bill from PO (3-way match) → finalize → part payment ₹50,000 with proof | ✅ |
| Final bill RA-3 (installation) → INV-0003; final payment ₹55,800 auto-allocated to 3 invoices | ✅ all invoices PAID, outstanding ₹0 |
| Reconciliation: `scripts/audit-stock-postings.ts` on `watcon_e2e` | ✅ 0 errors, 0 warnings, 0 account mismatches; stock WH 160 m / site 100 m + 3 pumps / transit 0 |
| PDFs (SO, 2 POs, GRN, challan, RA-2, RA-3, invoice, receipt, payment, supplier bill, accounts statement) rendered & inspected | ✅ after fixes below |

**Bugs / UX fixed this round**
1. `so-running-bill.ts` `soStatement`: "Received to date" ignored unallocated receipts recorded against the SO (showed ₹0 with ₹1,00,300 received). Now adds their unallocated part (allocated rupees already counted via invoices). Test added (so-po-driven Test 4). RA-1 in the E2E DB keeps the old snapshot (created before the fix).
2. `payment-form.tsx`: opened from an invoice/bill, allocation stayed at full outstanding when a smaller amount was typed → "Allocated more than the amount", submit disabled. Now follows the amount until the user edits allocations (client and supplier).
3. SO page Fulfilment and PO summary cards added quantities of different units ("Pending 105"). Now per unit ("4 Nos · 100 Mtr"); SO progress is the average share per line.
4. SO Fulfilment "Delivered" read only client-delivery challans (showed 0 while ₹1,05,000 delivered to site). `getSalesOrder` now uses `soBillingPosition` (site receipts + client deliveries; services = billed).
5. PDF: short sections no longer leave their heading alone at a page foot (`TextSection` keeps short sections together); "Previous running bills (status today)" label clarifies live vs snapshot figures.
6. Planning PO line note de-duplicated ("General stock · General stock").

**Manuals**: `WATCON_USER_GUIDE.pdf/.docx`, `QUICK_START_GUIDE.pdf` and Markdown regenerated (edition 27 Nov 2026). `.audit-tools` is unreadable (Windows ACL), so the libraries were installed to a temp folder and pre-imported; the script is unchanged apart from the edition date. `screenshots/README.md` overwrite reverted. Screenshots still show older button names.

**Regression**: final `npm run build` ✅; `tsc --noEmit` clean; `eslint src tests` 0 errors (11 old warnings); full Vitest **296/296 (36 files)**; suites touched after that (sales, so-po-driven, running-bills-v2, pdf-render-v2) re-run 30/30.

**Open observations (not fixed)**: RA strip label "New material value" also covers services/installation; SO milestone panel (50/40/10) still shows "next milestone" text when billing runs on running bills; stock issued from the warehouse is costed at item-wide average, not location cost; supplier-bill form saves draft first, then "Save & finalize" on the bill page (2 clicks); challan page shows "Against —" for SO-linked site issues. Production migrations (5 v2 + `20261127100000_so_po_driven_payments`) still not applied.

## Running bills from dispatched challans; payment on the bill (owner request 2026-11-27)

Owner decisions: material billable **on challan dispatch**; direct supplier-to-site receipts **still billable**; client **pays on the running bill**.
- `so-running-bill.ts` `soBillingPosition`: billable material = dispatched ISSUE_TO_SITE / SITE_TO_SITE challan lines into the project site (status not DRAFT/CANCELLED), net of `written_off_qty` (shortfall returned / written off) and damaged + rejected on posted receipts (`received − accepted`), + confirmed direct site receipts (RECEIPT), + client deliveries, − transfers / returns out of the site. Challan receipts (TRANSFER_IN) no longer add (the dispatch already counted). Netted per item before flooring at zero; SO-line-traced challan lines go to their line first, then FIFO. Over-billed damage/shortage is deducted from the next bill.
- `quick-bill.ts` `prepareRaBillPayment` + `prepareRaBillPaymentAction`; `RaBillPayButton` on the running-bill page (statuses SUBMITTED / DISPUTED / CLIENT_CERTIFIED / INVOICED / PARTIALLY_PAID): bill with the client → certified as claimed → invoice → issued (existing services), then opens the payment form preset to that invoice and SO. Part payments leave the balance as "previous outstanding" on the next bill. Paid bills refuse.
- Wording: new-bill page, bill column "Dispatched", PDF "How this bill is calculated", next-step text; help `running-bills` article + training steps 15–16; manuals regenerated.
- Tests: 3 new in `so-po-driven.test.ts` (dispatch-only billing, damage deducted next bill, direct delivery, returned shortfall, cancelled/draft ignored, pay-on-bill + carry-forward + paid). Full Vitest **299/299**; tsc clean; eslint 0 errors; production build ✅. Browser (production build, `watcon_e2e`): SO-0003 → challan DC-0002 dispatched, not received → RA billable 20 m → Submit → Record client payment (INV-0004 auto) ₹3,000 → next bill previous outstanding ₹4,080, total payable ₹7,620 ✅.
- No schema change. Not committed / deployed / migrated.

### Final-bill shortage credit (owner request 2026-11-27)
- Migration `20261127120000_ra_shortage_credit` (additive: `ra_bills.shortage_credit` DECIMAL(18,2) default 0, CHECK ≥ 0). Applied to **local dev / test / e2e only**; `migrate diff` vs schema empty.
- `so-running-bill.ts` `shortageCredit(pos)`: on a **final** SO bill, every material line with billed > delivered (damage / shortage recorded after dispatch-based billing) is credited at order rate + GST. Stored in `shortage_credit`, deducted from net payable, auto note in deduction notes (regenerated on refresh, user notes kept, never doubled). Kept through certification (`certifySoRunningBillTx`) and added to the invoice's other deductions (`invoice.ts`), so the client's net receivable drops. A final bill with nothing left to bill (or a credit larger than the bill) is refused with "raise a credit note".
- UI: notice on the bill form when Final is ticked; "Shortage / damage credit (incl. GST)" row on the bill page and PDF. Help + manuals updated.
- GST note: the credit reduces what the client pays on the final invoice; the GST already charged on earlier invoices is not reversed by it (a GST credit note is the statutory route if needed).
- Tests: 2 new (credit ₹5,900 incl. GST, refresh not doubled, invoice net ₹17,700; nothing-to-bill refusal). Full Vitest **301/301**; tsc clean; eslint 0 errors; build ✅. Browser (`watcon_e2e`): SO-0004 → dispatch 10 → RA-1 → receipt 8 + 2 damaged → final bill credit ₹708, net ₹5,192, total payable ₹8,732; PDF row checked.
- Deploy: add this migration to the pending production list.

### Automatic GST credit note for the final shortage (owner request 2026-11-27) — supersedes the deduction above
- The final bill **keeps its full value** (no deduction). `ra_bills.shortage_credit` now records the credit; the bill page / PDF show "Less: GST credit note (shortage / damage)" after the net, and `totalPayable` = previous outstanding + net − credit.
- When the final bill's **tax invoice is issued** (`clientInvoiceAction` "issue", incl. "Client accepted — invoice now" and "Record client payment" on the bill), `finalBillCreditNotesTx` (invoice.ts) recomputes the credit from current positions and `raiseShortageCreditNotesTx` (payables/notes.ts) creates **APPROVED client credit notes (series CN)**, one per GST rate and per invoice set against: the final invoice first, then the order's other open invoices (oldest first); each applied via `applyInvoiceSettlement` (adjusted amount). Reason lists the order, final bill and damaged/short lines. Audit `note.auto_raised`. The bill stores the amount actually credited; anything that cannot be set off (all invoices settled) is put in the bill's status note.
- Policy note: these notes are applied by the person issuing the invoice, without the Super Admin step that manual credit notes need — the figures come from confirmed site receipts with photo proof. Cancelling them still needs the Super Admin (existing rule; the invoice cannot be cancelled while they exist).
- Invoice from a final bill no longer adds the credit to other deductions (no double credit).
- Tests: credit-note test rewritten (bill ₹23,600 kept, CN ₹5,000 + ₹900 = ₹5,900 APPROVED on the final invoice, adjusted ₹5,900, client pays ₹17,700 → PAID) + new spill-over test (final invoice ₹1,180 → CN ₹1,180 on it, ₹4,720 on RA-1's open invoice). Full Vitest **302/302**; tsc clean; eslint 0 errors; build ✅. Browser (`watcon_e2e`): refreshed final RAB-0007 → submit → Record client payment → INV-0005 issued, CN/2026-27/0001 ₹708 (₹600 + ₹108) applied, outstanding ₹5,192; credit note PDF checked. No new schema beyond `20261127120000_ra_shortage_credit`.


## Super Admin only for the Sales Order (owner request 2026-11-28)

Owner: all users are Admins; the Super Admin approves only SO amendments (SO close / cancel too). No click merging requested.
- `requireSuperAdmin` removed from PO (amend → `po.approve`; cancel / short-close → `po.cancel`), client PO (amend / variation / close / cancel active → `cpo.approve`), receipt reversal (`grn.reverse`), supplier bill cancel (`bills.approve`), running bill cancel when certified (`rabill.approve`), invoice cancel when issued (`invoice.approve`), credit / debit note apply / cancel (`bills.approve` / `invoice.approve`), payment cancel / allocation reversal (`payments.manage`). Reasons still required; audit unchanged. `sales-order.ts` keeps `requireSuperAdmin`.
- `can.*` flags follow the same permissions; `requestChange` shows only to users lacking them (payments: never).
- Wording: confirm dialogs (receipt, PO, client PO), notes summary card, permission descriptions (run `npm run db:seed` to refresh in DB), `core.ts` policy comment, help `content.json` + `docs/user-guide/*.md` (PDF/DOCX not regenerated).
- Tests rewritten in client-payments-v2, payables, procurement-stores, purchasing-v2, sales. `tsc` clean; eslint 0 errors; unit 99/99. **Integration tests not run** — the local Postgres (port 5433) was not running.


## Client advances applied automatically on invoice issue (owner request 2026-11-28)

- `payments.ts` `applyClientAdvancesTx`: when a client TAX invoice is issued (`clientInvoiceAction` issue, so also "Client accepted — invoice now" and "Record client payment" on a running bill), unallocated POSTED receipts of the same client + project are allocated to it through `allocateTx` — receipts against the invoice's own SO first, then project-level (no SO) receipts, oldest first; receipts of another SO and refund rows are never used; proformas are skipped. Audit `payment.allocated` per receipt. Ordinary allocations (reversible).
- No double count: running-bill advance recovery uses only proforma receipts (`soStatement.advanceReceived`), not plain advances.
- `prepareRaBillPayment` returns `paidFromAdvance`; the bill's "Record client payment" button then just reports the invoice is paid instead of opening the form. Invoice "Issue" shows a toast with the advance used.
- Receipt page: greyed Allocate advance has a tooltip, and the advance banner explains it will be applied on the next invoice.
- Tests: so-po-driven Test 4 rewritten (auto allocation; other order's advance untouched) + new oldest-first test. `tsc` clean; eslint 0 errors. **Integration tests not run** (local Postgres on 5433 down).

## Reference

- Routes (dashboard): `/sales-orders /quotations /client-pos /material-planning /purchase-requisitions /rate-enquiries /purchase-orders /site-receipts /challans /stock /running-bills /client-invoices /payments (/receipts → ?direction=IN) /supplier-bills /notes /accounts /approvals /projects/[id]?tab=…`; public `/quote/[token]` (supplier), `/client-quote/[token]` (client); `GET /api/documents/pdf`, `/api/attachments`.
- Models: see PLAN.md table; schema `prisma/schema.prisma` (commercial models from line ~1128). Latest migration `20261126090000_workflow_v2_planning` (local only; hand-written partial index `material_requirements_general_open_key` + CHECKs — keep them).
- Tests touching v2: `tests/integration/{sales,procurement-stores,payables,accounts-completeness,complete-training-workflow,quotations}.test.ts`.
- Dependencies: none new planned.

## Log

- 2026-11-26 — Phase 1 audit complete. Created `docs/workflow-v2/{PLAN,PROGRESS,BUSINESS-RULES}.md`. Stopped before Phase 2 as instructed.
- 2026-11-26 — Phase 2 complete (local). 238/238 tests. Stopped before Phase 3.
- 2026-11-26 — Phase 3 complete. Full Vitest 245/245; tsc clean; eslint 0 errors (11 old warnings).
- 2026-11-26 — Phase 4 complete. Full Vitest 255/255; tsc clean; eslint 0 errors. Stock audit on local dev DB: 0 errors.
- 2026-11-26 — Phase 5 complete. Targeted suites green (stock-site 10/10, inventory, foundation, procurement-stores, planning); full Vitest 264/265 — the one failure was the old unit test expecting inward without a reason; updated to the new rule, unit suite 99/99 → 265/265. tsc clean; eslint 0 errors (11 old warnings).
- 2026-11-26 — Phase 6 complete. Full Vitest 272/272 (31 files); tsc clean; eslint 0 errors (11 old warnings).
- 2026-11-26 — Phase 7 complete. Full Vitest 278/278 (32 files); tsc clean; eslint 0 errors (11 old warnings). Stopped before Phase 8.
- 2026-11-26 — Phase 8 complete. Full Vitest 283/283 (33 files); tsc clean; eslint 0 errors (11 old warnings).
- 2026-11-27 — SO / PO driven correction. Full Vitest 296/296; tsc clean; eslint 0 errors.
- 2026-11-27 — Final verification: browser E2E on production build (`watcon_e2e`), 6 fixes, manuals regenerated, Vitest 296/296, build ✅.
- 2026-11-26 — Phase 9 complete. Full Vitest 284/284 (34 files); tsc clean; eslint 0 errors (11 old warnings). Five PDFs rendered and visually checked. Stopped before Phase 10.
