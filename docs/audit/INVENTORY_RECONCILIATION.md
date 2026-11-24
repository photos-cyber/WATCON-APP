<!-- AUDIT-2026-11-24 -->
# Inventory reconciliation

Confirmed implemented rule: supplier GRN posting adds accepted stock. Supplier bill approval does not add stock. This differs from the requested supplier-bill stock trigger and requires a business-owner decision before any rule change.

ABC Hotel test: new filter/brand has zero opening stock; PO approval leaves zero; supplier receipts of 6 and 4 posted to Central Warehouse yield 10; approved supplier bill leaves 10; SO approval leaves 10; client deliveries of 4 and 6 leave zero. The saved balance and financial cost match the expected values. Evidence: complete-training-workflow.test.ts, training-test.json, training/reconciliation.json.

Other local integration tests cover independent item/brand balances, location totals, reservations, simultaneous outward movement, retry idempotency, future/backdated movements, internal transit receipts, discrepancy write-offs, returns and reversals. The ledger engine locks balance rows and posts through a deterministic unique idempotency key inside the document transaction.

An internal transfer dispatch moves stock from source to transit. Destination receipt moves transit to destination. Supplier receipt increases company stock; an internal receipt must not be counted as another purchase. Damaged/rejected supplier quantities do not become accepted stock.

Production accuracy: BLOCKED. No read-only production stock/ledger export was supplied. Reconcile each item-brand-location balance to signed ledger movements; sum locations to company quantities; compare GRN accepted counters, PO pending quantities, reservations and challan transit. Investigate every mismatch before an authorized adjustment with a reason. No production count was changed.
