<!-- AUDIT-2026-11-24 -->
# Production readiness

Verdict: **NO-GO** for declaring the complete ERP production-ready. Existing production was not changed, pushed or deployed.

Evidence readiness score: 80.4%. This is the arithmetic mean of eight category scores; each is passed applicable checks / all applicable checks × 100. Failed, blocked and unexecuted checks receive zero. It is a conservative evidence score, not the probability that the app is correct, not branch coverage and not certification. Render checks have narrow expected results. Reclassifying or expanding the checklist changes the score.

- Functionality: 96.9% (127/131 credited checks).
- Security: 82.9% (58/70 credited checks).
- Database integrity: 87.5% (14/16 credited checks).
- Financial accuracy: 92.6% (50/54 credited checks).
- Inventory: 97.8% (44/45 credited checks).
- UI/UX: 91.9% (34/37 credited checks).
- Performance: 0.0% (0/3 credited checks).
- Documentation: 93.5% (29/31 credited checks).

## Release blockers

1. Decide and sign off the stock-posting rule (currently GRN). Keep one physical posting per receipt.
2. Review the high dependency chain with a patched supported version or a documented reachability assessment; rerun audit/build/regressions.
3. Reconcile production bills, receipts, inventory and dashboards using authorized read-only exports.
4. Prove SMTP password reset and a managed-database backup restore in isolation.
5. Execute remaining commercial UI flows, all role/action/API combinations, offline/save recovery, cross-browser and load checks in staging.
6. Review the new help/manual downloads and screenshots in the final staging build; Word rendering status is stated in COMPLETE_APP_AUDIT.md.

## Safe next steps

Review local git diff. Start scripts/audit-db.mjs to create the isolated local cluster. Set TEST_DATABASE_URL to the dedicated local regression database for integration tests. Do not use a real organization database. Build and run the application against an isolated target, repeat the checklist, then obtain owner approval for deployment. Never run test resets, demo seeding or bootstrap against production.
