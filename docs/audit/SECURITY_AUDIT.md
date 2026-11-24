> Historical audit retained below. The 18 November counts are historical; use the 24 November update later in this file and COMPLETE_APP_AUDIT.md for current results.

# Security Audit — 2026-11-18

Method: my own read of auth/session/schema/reports code, plus an independent read-only review of every server action, service, route handler and serializer by a separate reviewer. Findings below were each re-checked against the code before fixing. No black-box HTTP fuzzing was performed.

**Critical: 0. High: 0.**

## Findings

| # | Sev | Finding | Files | Status |
|---|---|---|---|---|
| 1 | Medium | Rate-limit IP taken from client-controlled left-most `X-Forwarded-For` (per-IP login/reset limits bypassable, audit IP forgeable) | `src/lib/auth/session.ts` | **FIXED** — prefers `X-Real-IP`. Requires the proxy to set it (docs updated) |
| 2 | Medium | Anyone knowing a username could lock that account (incl. Super Admin) out by failing 5 logins | `src/modules/auth/service.ts` | **FIXED** — lockout is per account+IP (5), plus a 20/15 min cross-IP cap. Residual: a distributed attacker can still hit the 20 cap |
| 3 | Medium | Unauthenticated `forgotPassword` deleted admin-issued 24 h reset links and could flood an inbox | `service.ts` | **FIXED** — self-service no longer revokes others; capped at 3/hour per email |
| 4 | Low-Med | Check-then-record rate limit beaten by parallel requests | `rate-limit.ts`, `service.ts` | **FIXED** — attempt reserved before password verify; regression test |
| 5 | Low | Reset-request timing reveals whether an email is registered (SMTP work only for real accounts) | `service.ts` | **OPEN** — needs queued/background mail |
| 6 | Low | No throttle on current-password check in change-password | `service.ts` | **FIXED** (5 failures / 15 min / user) |
| 7 | Low | Email/username change left old reset tokens valid | `members/service.ts` | **FIXED** |
| 8 | Low | Admin could add/remove a Super Admin's department memberships | `departments/service.ts` | **FIXED** |
| 9 | Low | `APP_URL` silently defaulted to localhost in production → broken reset links | `src/lib/env.ts` | **FIXED** — required in production |
| 10 | Low | No HSTS header | `next.config.ts` | **FIXED** (production only; effective once served over HTTPS) |
| 11 | Info | Roles/permissions are global, not per organization. Fine for a single company; a Super Admin of one org would change permissions for all in a multi-tenant setup | `schema.prisma`, `settings/service.ts` | **OPEN (conditional)** — only if multi-org is ever needed |
| 12 | Info | Tasks in archived projects can still be updated/commented | `tasks/service.ts` | **OPEN** — business-rule decision |
| 13 | Medium (functional) | Public logo files redirected to /login by auth proxy | `src/proxy.ts` | **FIXED** |

## Verified sound
Argon2id (19 MiB, t=2); session tokens 256-bit, stored only as SHA-256; httpOnly + SameSite=Lax + Secure in production; idle + absolute expiry enforced server-side; sessions revoked on role change, deactivation and reset; reset tokens hashed, single-use (atomic), 30 min / 24 h; generic login error with timing equalisation; every action authenticates via `runAction`/`requireActor` and re-reads permissions per request; IDs always AND-ed with scope builders (404 not 403 for invisible records); no mass assignment (Zod-parsed + explicit field maps); no `passwordHash`/tokens sent to the browser; raw SQL is only parameterised Prisma tagged templates; no user-controlled HTML (`dangerouslySetInnerHTML` is a fixed dev script); PDF route authorised, `no-store`; production dependency audit clean; `.env` is git-ignored; no hard-coded secrets found; `logging.serverFunctions=false` keeps passwords out of dev logs.

## Not tested
CSRF beyond Next.js server-action origin checks and SameSite=Lax; TLS configuration; HTTP header behaviour behind a real proxy; DB role least-privilege (single role used locally).

## Files changed by this audit
`src/proxy.ts`, `src/app/api/health/route.ts` (new), `src/lib/env.ts`, `src/lib/auth/session.ts`, `src/lib/auth/rate-limit.ts`, `src/modules/auth/service.ts`, `src/modules/members/service.ts`, `src/modules/departments/service.ts`, `next.config.ts`, `docker-compose.yml`, `.env.example`, `docs/DEPLOYMENT.md`, tests (`auth.test.ts`, `members-reports.test.ts`, `audit-coverage.test.ts`). Earlier in this session: company logo component and sidebar/auth layout.

---

<!-- AUDIT-2026-11-24 -->
# Security audit update 24 November 2026

Scope: source review, real local PostgreSQL tests, production Super Admin read-only navigation, signed-out API probes. This is not a penetration-test certification. No authentication bypass or production transaction was attempted.

## Verified controls

- Argon2 password hashing and database-backed, hashed opaque session tokens. HttpOnly, SameSite=Lax cookies; secure in production. Idle and absolute expiry, logout and deactivation have local tests.
- Password reset tokens are single-use; reset revokes sessions. Generic authentication errors and account/IP limits have local tests. Mailbox delivery remains blocked.
- Organization/project scopes are applied by services. All nine role defaults exist; individual local page probes and service authorization tests do not prove the entire role-by-action matrix.
- Attachment bytes use PostgreSQL attachment_blobs by default; filesystem is an alternative. Access follows the owning resource; hashes are checked before serving bytes. Version and evidence-retention controls are tested.
- Fixed metadata exposure and malformed-origin handling locally. Direct anonymous document endpoints return 401 in production.
- State changes use Server Actions with framework origin checks; upload handler also checks origin/host. Reverse-proxy trust configuration requires deployment review.
- SQL inputs normally use Prisma and tagged parameterized SQL. No dynamic untrusted SQL exploitation was demonstrated. The one reviewed dangerouslySetInnerHTML script is a fixed root-layout constant; this is not blanket XSS clearance.
- Security headers exist and are sampled on the deployed health response. A full app CSP is not configured.

## Remaining risks and configuration

- Dependency audit: {'info': 0, 'low': 0, 'moderate': 4, 'high': 4, 'critical': 0, 'total': 8}. Entries include transitive chains; eight package entries do not mean eight independent root vulnerabilities. Review runtime reachability and patched upstream releases before release.
- XLSX signature/extension checks and CSV NUL checks are not full content validation. No malware scanner is integrated or tested. Upload body buffering and platform limits need a capacity test.
- Database least-privilege grants, provider firewall policy, encryption configuration, backup retention and restore ability were not independently inspected. Do not assume Supabase RLS replaces app authorization; the actual app uses direct PostgreSQL via Prisma.
- Test database reset scripts guard database-name suffixes; run only against explicitly provisioned isolated targets. The new audit cluster uses local port 5544.
- No raw .env values, credentials, session tokens or real business records are included in these reports. Tracked-file inspection found only .env.example among environment files; this is not a full historical secret scan.
- Production credentials for roles other than Super Admin were not supplied.

## Release requirements

Resolve or formally assess the high dependency chain; review default grants against real departments; test protected document metadata after deploying to staging; validate SMTP with a test mailbox; perform a backup restore drill. No migrations or changes were made to production.
