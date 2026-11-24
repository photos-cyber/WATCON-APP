<!-- AUDIT-2026-11-24 -->
# Module status report

31 user-facing modules: 29 existing menu destinations plus Authentication and the new Help & User Guide. Clients and Suppliers share the party engine. Public supplier/client quotation links are subfeatures.

Status vocabulary: Fully working means the listed scope passed all planned checks. Partially working means some executed checks passed but the full workflow remains unverified. Unable to test means evidence is absent. Requires configuration means an external service or policy is needed. Not implemented means no corresponding implementation was found. Broken is reserved for reproduced failures. No entire business module is certified Fully working solely because it renders.

## Dashboard

Status: Partially working. Source route: /dashboard. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Viewing this page does not post stock or money. Totals follow your permissions.

## Projects

Status: Partially working. Source route: /projects. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Saving a project creates a job record. Approved orders and deliveries can later change its status and progress automatically.

## Tasks

Status: Partially working. Source route: /tasks. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Tasks do not post stock or payments. Completed means 100 percent. Reopening requires progress below 100 percent.

## Departments

Status: Partially working. Source route: /departments. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: No stock or account entry is created. A name must be unique.

## Team Members

Status: Partially working. Source route: /team-members. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: No stock or account entry is created. New members must change their temporary password. Deactivation keeps history and revokes sessions.

## Items

Status: Partially working. Source route: /items. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Creating an item does not receive material. Stock belongs to each item and brand combination.

## Brands

Status: Partially working. Source route: /brands. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: No stock is created by a brand name. Case-insensitive duplicate names are rejected.

## Suppliers

Status: Partially working. Source route: /parties?type=supplier. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A supplier profile creates no payable. Approved supplier bills create amounts to pay.

## Clients

Status: Partially working. Source route: /parties?type=client. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A client profile creates no receivable. Issued Client Invoices create amounts due.

## Material Planning

Status: Partially working. Source route: /material-planning. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A plan alone does not receive or issue stock. Reservations hold stock for a project.

## Requisitions

Status: Partially working. Source route: /purchase-requisitions. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A requisition does not receive stock or create a supplier bill.

## Rate Enquiries

Status: Partially working. Source route: /rate-enquiries. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: An enquiry and supplier quote do not change stock or create a payable.

## Purchase Orders

Status: Partially working. Source route: /purchase-orders. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A PO alone does not increase stock. Posted Site Receipts receive accepted material. An approved supplier bill records the payable.

## Site receipts

Status: Partially working. Source route: /site-receipts. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Posting a supplier GRN increases accepted stock at its receiving location. A draft does not. An internal transfer receipt moves material from transit to destination; it is not a second purchase.

## Inventory

Status: Partially working. Source route: /stock. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Only posted movements change balances. Manual adjustments need permission and a reason. Do not enter an adjustment to repeat a GRN.

## Supplier Bills

Status: Partially working. Source route: /supplier-bills. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Approval creates the payable and updates billed quantities. This version does not receive stock from the bill. Do not add stock a second time after a GRN.

## Quotations

Status: Partially working. Source route: /quotations. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A quotation does not issue materials or create an invoice receivable. Public quote links grant access to the offer; share them privately.

## Client POs

Status: Partially working. Source route: /client-pos. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: An active Client PO records the contract. It does not dispatch stock or issue a tax invoice.

## Sales Orders

Status: Partially working. Source route: /sales-orders. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A Sales Order alone does not reduce stock. Client-delivery challans update delivered quantities.

## Challans

Status: Partially working. Source route: /challans. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Dispatch reduces the source stock. Internal transfers remain in Goods in transit until receipt. Client delivery records supplied quantities. Returns and reversals have separate controlled actions.

## Running Bills

Status: Partially working. Source route: /running-bills. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: A Running Bill records measured and certified work. The separate Client Invoice creates the receivable. Do not treat certification as cash received.

## Client Invoices

Status: Partially working. Source route: /client-invoices. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: An issued invoice creates a receivable. Draft and cancelled invoices are excluded from live billed totals.

## Payments & Receipts

Status: Partially working. Source route: /payments. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Allocated amounts reduce the matching due. Unallocated money is an advance. Recording money does not move stock. Supplier TDS is recorded on the bill; client TDS is entered on the receipt.

## Credit / Debit Notes

Status: Partially working. Source route: /notes. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Approval adjusts the matching balance. A financial note does not physically return stock. Use a material return separately when required.

## Project Accounts

Status: Partially working. Source route: /accounts. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: This is an operational sub-ledger. Margin excludes labour and overheads. Received money and allocated invoice settlement are different measures.

## Reports

Status: Partially working. Source route: /reports. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Exporting does not change stock or accounts. Task Print, Export PDF and WhatsApp are also available on supported task report views.

## Documents

Status: Partially working. Source route: /documents. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Files do not change stock or financial totals. Verified and posted evidence has retention protections.

## Approvals

Status: Partially working. Source route: /approvals. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Approval has module-specific effects. You may need another approver when separation of duties is enabled.

## Administration

Status: Partially working. Source route: /settings. Production route rendering and local service/UI evidence are listed in TEST_CASES.csv. End-to-end coverage varies; render success is not transaction success.

Effect: Numbering, approval and tax settings affect later transactions. Do not change business rules without company approval.

## Authentication

Status: Partially working. Local login, reset tokens, expiry, inactivity, rate limits and logout tests passed. Production Super Admin login/logout passed. External password-reset email delivery is blocked.

## Help & User Guide

Status: Partially working until all final download/UI checks are recorded. 43 articles, searchable help, PDF/manual download, glossary, role guides and contextual links are implemented locally.

## Unsupported or conditional capabilities

- Item-level cost price and selling price fields: Not implemented in the inspected item input schema. Prices are entered on commercial lines.
- User-uploaded item catalogue photos: Not implemented in the inspected item form. ItemImage rows point to imported public assets; document evidence upload is a separate feature.
- Separate Sales Department system role: Not implemented; operational sales responsibilities map to PROJECT_MANAGER/ADMIN with so/cpo grants.
- Complete general ledger and expense-inclusive profitability: Not implemented in the inspected operational accounts engine.
- Supplier bill as stock posting event: Not implemented in this version; GRN posting is the actual event. Business-owner decision required before changing it.
- Dedicated PDF for every account statement/project summary/dashboard: Unable to test; no separate builder identified for every requested document.
- Production SMTP and recovery drill: Requires configuration/evidence.

FEATURE_INVENTORY.csv lists 391 exported module operations (including technical helpers), their source and direct test references. This is the reproducible feature-count definition, not a count of independently certified user features.
