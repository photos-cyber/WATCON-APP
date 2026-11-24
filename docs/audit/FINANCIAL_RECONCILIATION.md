<!-- AUDIT-2026-11-24 -->
# Financial reconciliation

Local fictional training scenario passed through real service logic and real PostgreSQL. Evidence: training-test.json and training/reconciliation.json. Six PDFs were built from saved training documents. The clean full suite also repeats the scenario.

Purchase: 10 × ₹1,000 = ₹10,000 taxable; CGST ₹900 + SGST ₹900 = ₹1,800; approved bill ₹11,800. Two payments ₹5,000 and ₹6,800 fully allocated; payable ₹0.

Sales: 10 × ₹1,500 = ₹15,000 taxable; GST ₹2,700; certified RA → issued invoice ₹17,700. Receipts ₹7,080 + ₹10,620 allocated; receivable ₹0. Contract value stays ₹17,700 because the linked SO is not counted a second time. Material cost ₹10,000; material margin ₹5,000 (33.33%). No labour, overheads, retention, recovery or TDS in this simple example. RA eligibility currently follows contract quantities and certification, not a mandatory delivery-challan link; this business-rule gap needs an owner decision. Separate suites test TDS, partial allocation, credits and reversals.

Project Accounts billed amounts come from issued client invoices, not RA claims. Amount received includes posted project receipts and client TDS; receivable is net invoice due less allocated receipts and notes. Unallocated advances are different from invoice settlement. Supplier payable is approved net bill amount less allocated payments/notes. Do not infer net receivables from cash alone.

Money uses decimal-scaled integer helpers and PostgreSQL Decimal storage. Intra/inter-state tax and rounding assertions passed locally. This is application arithmetic verification, not statutory GST advice.

Production reconciliation: BLOCKED. Obtain a read-only transaction export with statuses, allocations, credits, cancellations and project links. Compare per-document lines and tax, then reconcile party ledgers, project totals and dashboard figures. Never repair a difference with an unexplained adjustment.

Unimplemented/limited: operational sub-ledger, no verified general-ledger close or complete expense-inclusive project profit. The former 1000-project truncation has been removed and a 1003-project regression passed; large-portfolio load testing remains open.
