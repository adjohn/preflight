# Release Audit — Pre-Open-Source Review

**Scope:** Flat single-package repo (`src/`); shared code in `src/shared/` (read-only mirror from `nr-ai-typescript-shared`)
**Original audit:** 2026-05-06
**Re-audited:** 2026-06-03 — updated for monorepo breakup, product rename, resolved findings removed
**Reviewed by:** Claude Code (automated multi-agent analysis + manual code verification)

---

## Executive Summary

The codebase is well-structured and security-conscious, with zero committed secrets, comprehensive input validation, and strong documentation. All administrative blockers (LICENSE, CODE_OF_CONDUCT.md, package.json metadata) have been resolved. The only remaining action before publishing is confirming credential rotation in the `nr-ai-typescript-agent` repo.

---

## CRITICAL — Must Fix Before Publishing

---

### C2. Real Credentials on Disk in test-app/.env

**Severity:** CRITICAL
**File:** `packages/test-app/.env` _(now in `nr-ai-typescript-agent` repo)_

The file contained credentials matching the format of real New Relic keys. The file is NOT in git history (`.gitignore` is correctly configured), so this is not a historical leak. However, these keys must be rotated before either repo is made public.

**Status:** Rotation was due at original audit time (2026-05-06). Confirm the three keys (license key, account ID, user API key) have been rotated in the New Relic console and replaced with `your-license-key-here`-style placeholders. This action is in the `nr-ai-typescript-agent` repo.

---

## HIGH — Should Fix Before Publishing

## LOW — Minor Issues

### L2. Staging API Endpoints Exposed in Source

**Severity:** LOW (informational)
**File:** `src/shared/transport/http-client.ts`

The code references `staging-insights-collector.newrelic.com`, `staging-metric-api.newrelic.com`, and `staging-log-api.newrelic.com`. These are public-facing NR staging endpoints (not internal hostnames) used when a staging license key is detected. No action required, but external contributors will see that the project was developed against NR's staging environment.

---

## Open-Source Readiness Checklist

| Item                                  | Status       | Notes                                                                              |
| ------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| LICENSE file                          | ✅ Added     | Apache-2.0; `"license"` field added to `package.json`                              |
| No committed secrets                  | ✅ Clean     | `.env` not in git history                                                          |
| Rotate disk credentials               | ⚠️ Confirm   | `test-app/.env` (in `nr-ai-typescript-agent` repo) — confirm keys were rotated     |
| Internal URLs removed                 | ✅ Resolved  | `docs/ONBOARDING.md` deleted; `CONTRIBUTING.md` has no internal links              |
| CONTRIBUTING.md                       | ✅ Created   |                                                                                    |
| CODE_OF_CONDUCT.md                    | ✅ Created   | Contributor Covenant 2.1                                                           |
| npm scope                             | ✅ N/A       | Shared code is synced as source, not a published package; scope claim not required |
| `license` field in package.json       | ✅ Added     | `"Apache-2.0"`                                                                     |
| `engines` field in package.json       | ✅ Added     | `>=24.0.0`                                                                         |
| `repository` field in package.json    | ✅ Added     | `github.com/newrelic/nr-ai-coding-observability` — confirm org before publish      |
| GitHub org confirmed                  | ⚠️ Confirm   | Verify `newrelic` vs `newrelic-experimental` (or other) before publishing          |
| Workspace wildcard deps               | ✅ Resolved  | Flat repo — no workspaces                                                          |
| README quality                        | ✅ Excellent | Comprehensive                                                                      |
| Security practices                    | ✅ Strong    | Redaction, input validation, audit trail                                           |
| Test coverage                         | ✅ Good      | Co-located tests, clear patterns                                                   |
| Dashboard/alert JSON clean            | ✅ Clean     | No account-specific data                                                           |
| No private registry references (code) | ✅ Clean     | All deps on public npm                                                             |
| No postinstall hooks                  | ✅ Safe      |                                                                                    |
| GitHub Actions                        | ✅ Portable  | No internal CI references                                                          |

---

## Recommended Pre-Release Order

1. Confirm credential rotation in `nr-ai-typescript-agent` repo's `test-app/.env` (15 min)
2. Confirm GitHub org for public repo and update `repository` URL in `package.json` if needed (5 min)
3. Address remaining low-severity items at discretion
