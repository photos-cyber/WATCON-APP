<!-- AUDIT-2026-11-24 -->
# Bug report

This audit did not push or deploy code. Concurrent owner changes and commits were preserved. Fixed means a local code change with the stated regression evidence, not a production repair.

## B01: High — Fixed locally

Restricted attachment filenames and totals were visible through project/org document browsers. Added module permission filters before count/pagination, including supplier/client note separation.

Evidence: document-visibility.test.ts.

## B02: Low — Fixed locally

Malformed upload Origin could throw before structured error handling. Invalid/missing/non-HTTP origins now return rejection.

Evidence: upload-origin.test.ts.

## B03: Medium — Fixed locally

Browser fixture inherited production CA and could not bootstrap local PostgreSQL. E2E_DB_SSL_CA explicitly isolates TLS settings.

Evidence: E2E bootstrap and 9 passing browser tests.

## B04: Low — Fixed locally

Browser login selected both Password and Show password. Selector now uses an exact accessible label.

Evidence: 9 passing browser tests.

## B05: High — Open

Dependency audit reports 8 affected packages, including 4 high entries. No automatic fix available in the audited tree.

Evidence: dependencies.json.

## B06: High — Decision required

Requested supplier-bill stock rule differs from implemented GRN posting. Never silently change the stock trigger.

Evidence: complete-training-workflow.test.ts.

## B07: Medium — Open

Upload sniffing accepts XLSX based on ZIP signature and extension; CSV is only a lightweight NUL check. This does not establish safe workbook/text contents or malware freedom.

Evidence: src/lib/storage/sniff.ts.

## B08: Medium — Fixed locally

Removed the silent 1000-project cap from Project Accounts; regression verifies 1003 projects and restricted scopes.

Evidence: accounts-completeness.test.ts.

## B09: Low — Open

ESLint initially reported 10 unused-variable warnings; final check records the remaining warning count.

Evidence: lint-initial.txt and lint-final.txt.

## B10: Medium — Fixed locally

Unlabelled item/brand comboboxes were unnamed in the accessibility tree. SingleSelect now accepts explicit labels and uses its placeholder when no field label exists; the commercial UI workflow selects the named item field.

Evidence: scripts/audit-procurement-ui.mjs and accessibility snapshot.

## B11: High — Decision required

RA claims are limited by contract quantities and certification, without a mandatory delivered-challan link. Confirm whether measured work may be billed independently of delivery. No eligibility rule was silently changed.

Evidence: src/modules/sales/ra-bill.ts and running-bill service tests.

## B12: Medium — Fixed locally

Dynamic filesystem storage paths caused Turbopack to trace the entire project into server output. Runtime data paths are now explicitly excluded from static tracing without changing storage behavior.

Evidence: filesystem-storage.test.ts and final production build.

## B13: Medium — Fixed locally

Windows standalone image optimization could not load Sharp because adjacent native DLLs were omitted from tracing. The platform image-library folder is now explicitly included, with a real optimized-logo request in the standalone regression.

Evidence: next.config.ts and scripts/audit-built-help.mjs.

## Test infrastructure incident

One regression run overlapped another schema-reset test run and produced missing-table failures. It is retained as integration-final.json and receives no passing credit. The clean run uses a separately named watcon_regression_test database and is integration-verified.json. The original development cluster remained in recovery; the audit used a fresh separate cluster without deleting its files. Windows browser-server teardown required stopping only the known audit Next process after all 9 tests completed; the browser JSON records that waiting time.
