# Workflow v2 — Simplification Plan

_Audit: 2026-11-26 (Phase 1). Baseline commit `c3688e8`, working tree clean. No app code changed._
Companion files: [PROGRESS.md](PROGRESS.md) (status / resume point) · [BUSINESS-RULES.md](BUSINESS-RULES.md) (rules).
Older context: `docs/erp/PROGRESS.md` (safety rules for DB/tests — **read its "Safety rules" section before any migration**).

## Goal

Keep the existing app, design and data. Remove manual steps and connect documents so that:

```
Sales Order → Material Planning → (Rate Enquiry | Direct PO) → Material Receipt + proof
→ Site Challan → Site Receipt + proof → Cumulative Running Bill → Client Payment → Project Accounts
```

Optional (never blocking): client quotation, client PO, rate enquiry, purchase requisition.
Material Planning must also handle **general inventory (no project)** purchases.

## Constraints

Prisma 7 / PostgreSQL only (no Firebase) · additive migrations only, back-filled · no new dependencies unless unavoidable ·
preserve all data & behaviour (new paths are additions or settings, old paths keep working) · no deploy/commit/push ·
`.env` points at **production** — always override `DATABASE_URL`/`DIRECT_URL` to the local DB (see `docs/erp/PROGRESS.md`).

## Stack & conventions (verified)

Next 16.4.6 App Router (read `node_modules/next/dist/docs/` before Next-specific code), React 19.3, Prisma 7.10 +
`@prisma/adapter-pg`, Zod 4, RHF, TanStack Table, shadcn/Radix, `@react-pdf/renderer`, Vitest (unit + integration on real
Postgres), Playwright. Module pattern: `src/modules/<m>/{validation|service|actions}.ts`; authorization in services
(`src/lib/permissions/{definitions,scopes}.ts`); approvals/SoD in `src/modules/commercial/core.ts` (`assertCanApprove`,
`segregationBlocks`; SUPER_ADMIN exempt); stock only via `src/modules/inventory/engine.ts`; money via `src/lib/money.ts`;
numbering `src/lib/doc-numbering.ts`; PDFs registered in `src/modules/documents/pdf-models.ts` (all doc types already have one).

## Audit: stage-by-stage map

| Stage | Exists (reuse) | Gap → change needed |
|---|---|---|
| Client quotation | `sales/quotation.ts` (`convertToSalesOrder` :275), public accept `/client-quote/[token]` | Converted SO is DRAFT and drops `deliveryDate`; needs re-submit + approve |
| Client PO | `sales/client-po.ts`, `/client-pos` | Optional already for SO. `ClientPoLine` has no `itemBrandId` → SO lines prefilled from CPO miss MRP |
| Sales Order | `sales/sales-order.ts` (`soSchema` :49, approve → `syncRequirementsFromSo` :180), amendments (Super Admin) | Works without quotation/CPO. Submit+approve always 2 steps |
| Material Planning | `planning/{mrp,service}.ts`, `/material-planning`, `components/planning/mrp-table.tsx`; auto requirements from SO; bulk PR (`procurement/pr.ts` `createPrFromMrp` :163) | **No project-less planning** (`MaterialRequirement.projectId` required, `getMrp` keys by project). No bulk RFQ/PO; RFQ/PO row links don't prefill preferred supplier/dates |
| Purchase requisition | `procurement/pr.ts` | Optional for RFQ/PO already. Project mandatory via `projectIdField` (`commercial/pricing.ts:16`) |
| Rate enquiry | `procurement/rfq.ts`, supplier portal `/quote/[token]`, award → `createPosFromAward` :483 | Project mandatory. Award approval + PO approval = double approval; POs created DRAFT |
| Purchase order | `procurement/po.ts` (null-project → WH-MAIN logic exists in `buildPo` :110 but unreachable) | Project mandatory (`projectIdField`, `po-form.tsx:89`). Draft → submit → approve (3 clicks, 2 people) |
| Material receipt (GRN) | `stores/grn.ts` (prefill `receiptSource` :298, idempotent `clientKey`, post → stock RECEIPT, SoD), `/site-receipts`, attachments w/ camera+GPS (`components/documents/attachments-panel.tsx`) | **Proof not enforced anywhere.** Files can only be added after save. Same model for warehouse & site receipts (location decides) |
| Site challan | `stores/challan.ts` (ISSUE_TO_SITE via TRANSIT, CLIENT_DELIVERY updates `SoLine.deliveredQty`), prefill `?soId` / `?itemBrandId&qty` | No prefill from posted warehouse GRN / reservation; no auto-challan; delivery proof optional |
| Site receipt | GRN with `challanId` (TRANSIT → site, damaged → QC-HOLD) | Proof not enforced; separate create/submit/post |
| Running bill | `sales/ra-bill.ts` (cumulative via `cpoLineBilled` `sales/shared.ts:37`, retention/advance `raAmounts` :54, certify, → invoice) | **Hard-requires Client PO** (schema `RaBill.clientPoId`, `RaBillLine.clientPoLineId` NOT NULL; UI picks CPO first). Claimed qty typed, not prefilled from delivered/received. RA → invoice is a separate manual step |
| Client invoice | `sales/invoice.ts` (sources RA / SO / CPO), milestones `sales/milestone-billing.ts`, proforma | Draft → issue always 2 people |
| Client payment | `payables/payments.ts` (IN, TDS, FIFO auto-allocate button, advances), `/payments?direction=IN` (`/receipts` redirects) | Allocation only to client invoices (not RA/SO). Advances not auto-applied to new invoices |
| Supplier bill / payment | `payables/{bills,match,payments,notes}.ts`, 2/3-way match, TDS | No supplier advance against a PO |
| Project accounts | `insights/finance.ts` `projectFinancials` :58, `insights/accounts.ts`, `/accounts`, project hub Accounts tab (`projects/[projectId]/page.tsx` `AccountsTab` ~397) | **Bug:** proformas counted as billed (finance.ts invoice groupBy filters status only). Received mixes advances. No retention/advance outstanding, no income-vs-expense, no ageing, no drill-down, no period filter |

Stock/location facts: `ensureSiteLocation` (engine.ts:66) auto-creates `SITE-{projectCode}`; system locations WH-MAIN, TRANSIT,
QC-HOLD; balances per item-brand × location (warehouse stock needs no project); reservations per project; no stored moving-average cost.

## Key design decisions (proposed — confirm open ones in BUSINESS-RULES §Open decisions)

1. **General inventory** = documents with `projectId = null`, delivering to a WAREHOUSE location. Relax `projectIdField` per
   document via a new `optionalProjectIdField` (PR/RFQ/PO only; payments, CPO, SO stay project-bound). Planning gets a
   "General stock" scope driven by reorder levels + manual requirements → new nullable-project requirement rows.
   `MaterialRequirement.projectId` → nullable, replace `@@unique([projectId,itemBrandId])` with partial unique indexes.
2. **Running bill on SO**: make `RaBill.clientPoId` nullable, add `soId`; `RaBillLine.clientPoLineId` nullable, add `soLineId`;
   CHECK exactly one basis. Cumulative ceiling = SO line qty (or CPO line when linked). Claimed qty prefilled from
   site-received/delivered qty. Existing CPO-based bills untouched.
3. **Payments stay invoice-based**: on RA certification auto-create the invoice draft (optionally auto-issue per setting) so
   client payments allocate exactly as today. No allocation-to-RA schema change.
4. **Mandatory proof** via org settings (categories per step) checked in services (`grnAction` submit, `postGrn`,
   `createGrn/updateGrn` with `submit`, challan `deliver`). UI: upload inside the receipt form before submit (draft auto-saved first).
5. **Fewer clicks, same controls**: "Submit & approve" when the actor may approve (SoD/limits still enforced, Super Admin
   exempt); POs from an approved award created APPROVED; quotation → SO carries `deliveryDate` and opens PENDING_APPROVAL;
   GRN "Submit & post" where SoD allows. All behind `OrgSettings` flags defaulting to current behaviour.
6. Reuse existing pages/components; add buttons and prefills rather than new screens. Only new route considered: none required.

## Phases

| # | Phase | Main work | Files |
|---|---|---|---|
| 1 | Audit | This doc set | `docs/workflow-v2/*` |
| 2 | SO & Material Planning | Quote→SO carry-over; `itemBrandId` on `ClientPoLine` (nullable); general-stock planning (nullable project requirement, reorder-driven); bulk "Create PO / RFQ" from shortages with preferred supplier + dates; optional PR skip | `sales/{quotation,sales-order,client-po}.ts`, `planning/*`, `components/planning/mrp-table.tsx`, `commercial/pricing.ts`, schema |
| 3 | Rate Enquiries & POs | Project optional (PR/RFQ/PO); award → APPROVED POs; "Submit & approve"; supplier prefill | `procurement/{pr,rfq,po}.ts`, `components/procurement/*`, `commercial/core.ts` |
| 4 | Material Receiving | Proof settings + enforcement; upload-before-submit form; Submit & post; tolerance messages | `stores/grn.ts`, `components/stores/grn-form.tsx`, `documents/*`, `settings/commercial.ts`, schema (`OrgSettings`) |
| 5 | Stock & Site Challans | Challan prefill from posted GRN / reservation / SO pending; "Send to site" button on GRN; auto-reserve on project GRN; site receipt proof | `stores/challan.ts`, `components/stores/challan-form.tsx`, `inventory/locations.ts` |
| 6 | Cumulative Running Bills | SO-based RA (schema), prefill from received/delivered qty, auto invoice draft on certify, optional client-cert step | `sales/{ra-bill,shared,invoice}.ts`, `running-bills/*`, `sales/pdf.ts` |
| 7 | Client Payments | Receipt from RA/invoice page with auto-FIFO default; auto-apply advances; milestone status derived | `payables/payments.ts`, `components/payables/payment-form.tsx`, `sales/client-po.ts` |
| 8 | Supplier Payments & Project Accounts | Fix proforma-in-billed; split advances; retention/advance outstanding; income vs expense; ageing; drill-down; period filter; supplier advance vs PO (optional) | `insights/{finance,accounts,workspace}.ts`, `accounts/page.tsx`, project `AccountsTab` |
| 9 | UI/UX & PDFs | "Next step" CTAs along the chain, project order-flow guide update, plain labels, PDF updates (RA on SO, general-stock PO "Central store") | `components/commercial/*`, `projects/[projectId]/page.tsx`, `documents/pdf-models.ts`, `help/content.json` |
| 10 | Testing & Docs | Integration test of full v2 chain + general-stock chain; regression suite; user guide | `tests/integration/*`, `docs/user-guide/*` |

Each phase: schema change (if any) as its own additive migration → service + tests → UI → `next typegen`, `tsc`, `eslint`,
full Vitest → update PROGRESS.md.
