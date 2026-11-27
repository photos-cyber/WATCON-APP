# Workflow v2 — Business Rules

_Status: draft from Phase 1 audit (2026-11-26). "Current" = verified in code; "v2" = target. Items marked **[decide]** need owner confirmation._

## Kept from v1 (do not break)

- An approved Sales Order is locked; changes only via amendment request approved by a **Super Admin** (`sales-order.ts` `decideSoAmendment`).
- Separation of duties: creator/submitter ≠ approver when `OrgSettings.enforceSegregation`; **Super Admin exempt**; role approval limits per doc type (`ApprovalLimit`).
- Stock changes only through `inventory/engine.ts`; only GRN posting, challan dispatch/receipt, consumption, adjustments, reversals move stock. Bills never move stock. Never edit posted movements — reverse them.
- No negative stock; reserved stock can't be taken by another project.
- Over-receipt limited by `receiptTolerancePct`; billing limited by 2/3-way match (`billMatchMode`); client billing limited by contract/SO quantities.
- Contract value = confirmed SOs (client PO optional) + legacy active client POs that have no confirmed SO (changed 2026-11-27; never both for one contract). Margin = billed taxable − cost of material delivered/consumed (weighted average receipt cost).
- Client invoices need a place of supply; drafter cannot issue (unless Super Admin).
- Archive/cancel instead of delete; every action audited.

## Changed in v2

1. **Project scope.** v1 rule "every procurement document belongs to one project" is relaxed: **PR, RFQ, PO, GRN, stock transfer may have no project = general inventory**, delivered to a warehouse. Sales, billing, client payments and project accounts stay project-bound. Supplier bills/payments may be project-less (general stock purchases).
2. **Optional documents.** Client quotation, client PO, purchase requisition and rate enquiry are never prerequisites. Minimum chain: SO → planning → PO → receipt → challan → site receipt → running bill → invoice → payment.
3. **Material planning** is generated automatically from approved SOs (exists) and, for general stock, from reorder levels and manual entries. From shortages the user can create PR, RFQ or PO in bulk; preferred supplier, last rate and required-by date prefill.
4. **Proof is mandatory** before a receipt can be submitted/posted:
   - Supplier material receipt: supplier invoice or delivery challan **and** a material photo. **[decide]**
   - Site receipt (from challan): signed challan or material photo. **[decide]**
   - Client delivery challan: signed challan/POD before marking delivered. **[decide]**
   - Required categories configurable in Settings → Commercial; default for existing orgs = off until enabled (preserves behaviour). **[decide]**
5. **Running bills are cumulative per Sales Order** (client PO optional). Each bill shows previous certified, this bill and cumulative quantities; a line cannot exceed SO (or client PO) quantity. This-bill qty is prefilled from site-received/delivered quantity not yet billed; user may edit within the ceiling.
6. **Client payments** are recorded against the invoice created from the running bill (invoice draft auto-created when the bill is certified). Unallocated money is an advance and is offered automatically against the next invoice of the same client + project.
7. **Fewer approval clicks**: when the user may approve the document (permission, limit, SoD), "Submit & approve" does both in one step. POs created from an approved rate-enquiry award are already approved (the award approval used the PO limit).

## Implemented in Phase 2 (2026-11-26)

- **Sales Order is the starting point.** Quotation and client PO are optional links. Approving an SO (and approved amendments, close, cancel) re-syncs requirements automatically.
- **Line kinds.** `MATERIAL` lines need an item–brand and drive planning/purchasing; `SERVICE` and `INSTALLATION` lines are billed only (any item on them is dropped). Existing lines without an item were back-filled as SERVICE.
- **Payment milestones.** New SOs default to 50% advance / 40% on delivery / 10% on installation, fully editable or removable (removed = invoice by delivered qty). A schedule must total 100% of the order.
- **General inventory** = requirement without a project, at most one OPEN per item–brand, stocked in the warehouse.
  - Minimum stock = `reorder_level`; target stock = `target_stock` (≥ minimum).
  - Suggested = target (else minimum) − (available + incoming + on order), only when that projected stock ≤ minimum. Available = warehouse on hand − warehouse reservations.
  - Manual "still to buy" qty is stored as allocated + qty, so ordered quantities are never asked again. To order = max(suggested, manual still open) — never the sum.
- **Project lines.** Issued = at site + in transit + consumed/delivered. To order = required − issued − reserved − incoming − on order (draft/pending/rejected POs, open PRs, open planning RFQs) − free warehouse stock. Maximum orderable = same without subtracting free stock.
- **Allocation (no double ordering).** Every PR/RFQ/PO line may link one requirement. Σ allocated (PR lines, direct PO lines, open direct RFQ lines without a live PO; short-closed PO counts accepted; lines derived from a PR line counted once via the PR) ≤ required qty — enforced with row locks on every create/edit. A requirement can't be set below its allocated qty; SO sync never lowers it below that.
- **Combined documents.** One PO/RFQ may mix several projects and general stock; it then has no project and delivers to WH-MAIN. A document with a project may only carry that project's requirements. Ordering needs `po.create` / `rfq.manage` plus access to every project on it (Purchase role sees all projects by default).
- **Procurement scope.** RFQ and PO may have no project (general stock); requisitions still need a project.

## Implemented in Phase 3 (2026-11-26)

- **Requisition and comparison are optional.** Purchase can go SO / planning → PO, or SO / planning → rate enquiry → quotation → PO.
- **Rate enquiry → PO:** any supplier's current quotation can be ordered directly (rates, GST, freight, delivery, payment terms carried). Total ordered per enquiry line across all its POs ≤ enquiry quantity; split between suppliers allowed. A superseded quotation cannot be ordered.
- **One approval per purchase:**
  - Direct / quotation POs need the normal PO approval, done with **Finalize**: approved immediately if the finalizer may approve (has `po.approve`, is not the PO's creator unless Super Admin or SoD is off, within the role's PO limit); otherwise it goes to an approver.
  - POs from an approved award are approved automatically (the award was approved against the PO limit).
- **Allocations:** an open enquiry keeps its unordered remainder allocated; a PO made from its quotation moves that quantity from the enquiry to the PO (never double-counted). Cancelling a PO frees the quantity again.

## Implemented in Phase 4 (2026-11-26)

- **Receiving from a PO.** The receipt (GRN) is created as a draft automatically; drafts may be incomplete. Partial receipts are allowed (several receipts per PO).
- **Mandatory proof (supplier receipts), always on:** ≥1 material photo (must be an image) + supplier delivery challan / invoice / POD (image or PDF) + damage photo when anything is damaged or rejected. Without it the receipt cannot be submitted, and posting re-checks it. Files on a posted receipt can't be removed.
- **Posting** (by someone other than the recorder, unless Super Admin / SoD off) adds only the accepted qty, at the PO's delivery location: the project site for project POs (direct supplier-to-site), the main warehouse for general stock. Damaged / rejected qty is recorded on the PO line, not stocked. Receipts beyond the ordered qty (+ tolerance setting) are refused at posting, under row locks.
- **No double stock:** only receipts, transfers, consumption, adjustments and reversals move stock; supplier bills never do. One movement per receipt line (unique idempotency key). The read-only integrity audit flags ledger/balance mismatches, duplicate or orphan receipt postings, PO counters out of step, bill-sourced movements, and manual inwards that look like a re-entered delivery.

## Implemented in Phase 5 (2026-11-26)

- **Stock is per item–brand per location.** Physical = warehouse + site stores; available = warehouse − warehouse reservations; in transit, site and damaged (quarantine) are shown separately; reorder qty = target (else minimum) − (available + incoming) once that is ≤ minimum.
- **Site challan:**
  - A draft moves no stock.
  - Issuing moves warehouse → in transit.
  - The site receipt moves in transit → site (accepted) and damaged → quarantine. Any shortage stays in transit until it is closed, either returned to the source or written off.
  - Issues can't take stock reserved for another project, can't go negative, and a repeated tap creates one challan.
- **Site receipt proof** (always on): material photo + signed challan / delivery proof (+ damage photo when anything is damaged).
- **Manual stock changes are owner-only:** only the Super Admin can post manual inward, outward or adjustments, and only with a reason and an evidence file. Granting the permission to another role has no effect. All other stock movement goes through documents (receipts, challans, consumption) with idempotent, transactional postings. History is never edited; corrections are reversals.

## Implemented in Phase 6 (2026-11-26)

- **What a running bill charges:**
  - Material that reached the project: site receipts of challans, direct supplier-to-site deliveries, and client deliveries from a warehouse, net of returns.
  - Services and installation by quantity.
  - Always at the **sales-order selling rate** (net of discount) with the SO line's GST, never the purchase rate.
- **Limits:** per SO line, billed ≤ order qty; for material also ≤ delivered. Quantities already on earlier running bills or tax invoices are never billed again. Partial billing is allowed.
- **Cumulative statement on every bill:**
  - Previous material value + new material value = cumulative value.
  - Also shows previously billed, received to date and previous outstanding.
  - **Total payable = previous outstanding + this bill.**
  - Only this bill becomes a receivable (its invoice); outstanding amounts are shown, never re-billed or re-taxed.
- **Drafts:** one draft per sales order; generating again consolidates everything unbilled into it.
- **Deductions:**
  - Retention %.
  - Advance recovery, capped at the advance actually received (proformas) less what was already recovered. It's automatic in proportion to the share billed, and the rest is recovered on the final bill.
  - Other deductions with notes.
- **Final bill:** bills everything still billable, and nothing can be billed after it (unless it is cancelled).
- **One billing basis per sales order:** running bills, or milestone tax invoices, or SO delivery invoices — never a mix. Advance proformas can coexist with running bills. ~~Orders linked to a client PO are billed on the client PO's running bills~~ — superseded 2026-11-27, see "SO / PO driven workflow".
- **Certification and invoicing:** client certification stays (certified ≤ claimed). The invoice is created only from a certified bill, one live invoice per bill. Cancelling the invoice restores the bill and the SO counters.

## Implemented in Phase 7 (2026-11-26)

- **A client payment belongs to one project and one client.** It settles only that project's issued tax invoices (or proformas), never more than each invoice's outstanding. Whatever is left is a client advance.
- **Settlement:** payments can be partial, several payments can settle one invoice, and one payment can settle several invoices. Allocation is suggested oldest-due first and can be edited. An advance is set against invoices later, or recovered on running bills or milestone invoices.
- **Duplicates:** the same submission (idempotency key) records one payment only. Allocations are reversed, never deleted, and cancelling a payment reverses all of its allocations.
- **Refunds:** only from a receipt's unallocated advance, by an approver who did not record the receipt (Super Admin exempt), within the approval limit, with a reason. Recorded as a linked refund voucher. A refund is not a supplier payment.
- **Client position (each rupee counted once):**
  - Outstanding billed = issued tax invoices' net − received − credit notes.
  - Unbilled = contract − invoiced.
  - Client advances = unallocated receipts (after refunds) + proforma advances not yet adjusted.
  - Payment received = allocated + advances.
  - Remaining contract payment = contract − payment received.
  - Overdue = outstanding past its due date.
  - Next payment milestone = the first milestone whose cumulative amount is not yet covered by money received.
- **Receipts:** a Payment Receipt PDF is available for every receipt.

## Implemented in Phase 8 (2026-11-26)

- **Supplier bills and payments from a PO:** a bill and a payment can be recorded straight from the PO. A payment made against a PO before its bill is a supplier advance on that PO and can only settle that PO's bills. Partial bills and partial payments are allowed. A bill never adds stock.
- **General stock:** a general-stock / combined PO is billed and paid without a project. Its cost reaches a project only when the material is issued to it, at the average purchase cost.
- **Project accounts (operational, not a general ledger):**
  - Commitments (PO value) are not expenses, and the contract value is not revenue.
  - Revenue = issued tax invoices excl. GST (proformas excluded).
  - Actual material cost = material that reached the project (site receipts at purchase cost; issues / deliveries from stock at average cost; net of returns).
  - Other expenses = non-stock supplier-bill lines + freight / charges.
  - Estimated profit = contract excl. GST − (material + other + estimated remaining material).
  - Actual margin = revenue − (material + other), shown once something is invoiced.
- **Reconciliation:** stored received / paid / allocated / refunded totals must equal the live allocations and refunds. The audit script reports any mismatch.

## Implemented in Phase 9 (2026-11-26)

- **Action Required:**
  - Every summary card opens the exact records it counts.
  - Cards are shown only to users who hold the matching permission; a zero count shows as "all clear".
  - "Needs ordering" means the quantity to order is greater than 0 after stock and open orders.
  - "Awaiting proof" means a draft or rejected receipt whose proof rules are not yet met.
  - "Ready for billing" counts material delivered or received and not yet on a running bill, at SO rates.
- **Permissions:** navigation regrouping changes no permission, and Help remains Super Admin-only.
- **Accounts Statement PDF:**
  - Needs `accounts.view` and project visibility.
  - Prints the same figures as the Accounts tab.
  - States that it is operational, not a ledger: POs are commitments and contract value is not revenue.
- **PDFs:**
  - Documents without a project say "General stock (no project)".
  - Site challans tell the receiver that photo proof in the app is required to confirm receipt.

## Simplification v3 (2026-11-27) — supersedes the approval rules above

- **No approvals for daily work.** Anyone holding the document's create/manage permission (and project access) finalizes it in one step. There is no second approver, no separation of duties and no approval limit for: quotation, sales order, client PO, requisition, rate-enquiry award, purchase order, material receipt (with mandatory proof), site challan, running bill (submit to client), client invoice (issue), supplier bill (when it matches), client and supplier payments.
- **Only changes to final documents need the Super Admin:**
  - SO amendment (request → Super Admin decides), SO close / cancel;
  - client PO amend / variation / close / cancel;
  - PO amend / cancel / short-close;
  - receipt reversal;
  - cancel of a final supplier bill, certified running bill or issued invoice;
  - credit / debit notes;
  - payment cancel / allocation reversal;
  - manual stock adjustments and write-offs.

  Everyone else uses **Request change** (notifies the Super Admins; audited).
- **Integrity checks are not approvals and stay:**
  - mandatory receipt proof;
  - client delivery POD before "Delivered";
  - supplier-bill 3-way match (a mismatching bill is held until corrected or accepted with a reason by a user with `bills.override_match`);
  - quantity / contract / billing ceilings, idempotency and row locks.
- Settings `enforceSegregation` and approval limits no longer affect daily documents; they remain only for client-advance refunds.

## SO / PO driven workflow (2026-11-27)

- **Sales order = the client side.** Running bills, invoices, client receipts and accounts work on a confirmed SO with no client PO. Quotation and client PO are optional references.
- **Running bills:** raised on the SO, also when the SO is linked to a client PO.
  - The client PO line quantities stay a shared ceiling for every billing path.
  - Exception (legacy): a client PO that already has its own live running bills continues there. SO bills for its orders are refused.
  - The reverse also holds: a client-PO bill is refused once its orders are billed on SO running bills.
  - "New running bill" picks project → confirmed SO. Legacy client-PO contracts are listed separately.
- **Site challans → SO line:**
  - A site-issue line is linked to the SO line chosen on the issue screen.
  - When only one confirmed order of the project carries the material, the link is automatic.
  - Billing gives traced site receipts to their own SO line first. Untraced deliveries (direct supplier-to-site, client deliveries, legacy challans) are shared oldest order first.
- **Client receipts against an SO** (`payments.so_id`, receipts only):
  - Money received before any invoice is that order's advance.
  - It can only settle that order's invoices.
  - It is counted once: in "advance" until allocated, then in "received".
- **SO financial summary:** order total (original / revised after amendments), material delivered (at SO rates), running bills, invoiced, received, outstanding, unallocated advance, unbilled, remaining to receive, next milestone. Running bills are shown, never added to invoiced.
- **PO financial summary:**
  - PO value is a commitment, not a payable.
  - Received / pending value is at PO rates.
  - Billed = finalized supplier bills.
  - Paid = bill payments + unallocated PO advance (each rupee once).
  - Also shown: outstanding bills, unbilled commitment, remaining to pay.
- No new approval step. Finalized-record changes stay Super Admin only.

## Open decisions **[decide]**

| # | Question | Proposed default |
|---|---|---|
| D1 | Which proof categories are mandatory at each receipt type? | **Decided for supplier receipts (Phase 4)**: photo + delivery proof + damage photo. Challan / site receipts: Phase 5 |
| D2 | Enable mandatory proof immediately for all, or via setting? | **Decided: always on** (owner, Phase 4 brief) |
| D3 | Running bill qty basis | **Decided (Phase 6):** delivered (site receipts / direct-to-site / client deliveries), editable down; services by qty |
| D4 | Keep client certification step mandatory? | **Kept for now** (existing flow). One-click "certify as claimed" is a possible Phase 9 UI shortcut |
| D5 | Auto-issue invoice on certification, or only auto-draft? | **Unchanged:** invoice drafted from a certified bill, issued by a second person (SoD) |
| D6 | Retention: show only, or add retention-release invoice? | Show held amount in accounts now; release invoice later |
| D7 | General stock cost: when issued to a project, charge at warehouse average cost? | Yes (moving average at issue) |
| D8 | Who may "Submit & approve" (any approver within limit, or Super Admin only)? | **Applied for POs (Phase 3):** any approver within limit who did not create the PO; Super Admin always. Confirm, or restrict |
| D9 | Supplier advance against a PO needed? | **Done (Phase 8)** |
| D10 | Record site expenses that are not on supplier bills (cash labour, overheads)? | Not built — add a simple expense entry if wanted |

## Known existing issues (fix in Phase 8, verify first)

- ~~Proforma invoices counted in billed revenue~~ — fixed in Phase 8.
- ~~Advances not shown separately~~ — shown separately on the client side (Phase 7) and supplier side (Phase 8).
- ~~`poSchema` null-project branch dead code~~ — fixed in Phase 2 (RFQ/PO accept no project). PR still requires a project.
