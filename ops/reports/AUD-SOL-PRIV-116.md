# AUD-SOL-PRIV-116 — privacy publication pair

Lens: GPT-6.1 Sol. Independent read-only T4 audit.

## Scope and initial state

- Backend #611 claimed at `5eac8f21bb70460da7dea7be5ce9f84f40870afb`; full FIX ROUND 7 audit underway. Prior Sol APPROVE at `1af96efa0ac3bcfc67b4685d96c71b779c1df365` carried zero code A/B/C, but retained external publication hold B-611-1. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5964309856)
- FIX ROUND 7 applies O-611-1..6 and supplies a six-fail/one-pass before-test run; current work will distinguish static content tests from external settings and manual-procedure evidence. [FIX ROUND 7](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5972222465)
- Mobile #315 stays reserved for the named main refresh after #611 approval; prior approved head is `8fff3f8f3829aab4079973b38428e2d266bc3f3b`. [Mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/315)

## Evidence workspace

`/home/user/workspace/ops/aud-116/AUD-SOL-PRIV-116/` contains collected PR bodies, comment histories and review metadata. Isolated backend worktree: `/home/user/workspace/wt/AUD-SOL-PRIV-116-611`.

## Backend #611 — full-depth audit progress

- The merged-main commit `d280d73ed632e535164dd1ea233ce1a1b5be6c82` is mechanically reconstructed from prior approved `1af96efa0ac3bcfc67b4685d96c71b779c1df365` and main `0d33c4d4adfb1819f0007a5efbc101c3d8362414`; both committed and computed trees equal `f369d37e6d19710b786b8b9719b967991a29abeb`, and policy/document/tests from the prior approval are byte-identical before the owner-answer commit. [Merge commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d280d73ed632e535164dd1ea233ce1a1b5be6c82)
- Read all owner-answer source, procedure and test changes; reconfirmed the full public privacy/consumer-health/terms copy, public route exclusions, shared footer/link escaping, deletion-page content, all relevant added regression tests and restore split boundary. [Candidate change](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611/files)
- O-611-1..6 otherwise preserve the approved deletion paragraph, correctly disclose the Anthropic exception, name Mux without account metadata, adopt plan-agnostic backup/dump bounds, record owner-confirmed vendor settings, and state the deidentified-data/health-use commitments. [Owner-answer commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/5eac8f21bb70460da7dea7be5ce9f84f40870afb)
- External documentation was re-read for Anthropic, Stripe, Sentry, Resend, PostHog, Supabase, RCW 19.373 and Apple 5.1.3; vendor/API retention facts align with the new text but public documentation does not independently prove this customer's dashboard settings. [Anthropic](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Stripe](https://docs.stripe.com/privacy/deletion-requests), [Sentry](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/), [Resend](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [PostHog](https://posthog.com/docs/privacy/data-storage), [Supabase](https://supabase.com/docs/guides/platform/backups), [RCW deidentification](https://app.leg.wa.gov/RCW/default.aspx?cite=19.373.010), [RCW deletion](https://app.leg.wa.gov/RCW/default.aspx?cite=19.373.040), [Apple guidelines](https://developer.apple.com/app-store/review/guidelines/)
- Exact-head build logs confirm the four privacy/restore/deletion suites execute; total 713 passed suites / 12,334 passed tests, with 23 skipped suites / 239 skipped tests / 5 todo separately disclosed. All 11 required checks succeed; deployment-readiness-gate is informational/skipped, and branch is behind main. [Exact-head build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144089154/job/111264343463)
- Confirmed the owner's before-test run actually fails all six O-611 assertions while its voice-constant test passes. [Before run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144067930)

### Candidate finding B-611-7 — false Sentry email collection disclosure

`src/public-pages/trust-pages.html.ts:154` publicly states crash/performance reports include account ID **and email address**; its own procedure of record at `docs/privacy/vendor-deletion-and-backups.md:181` says the mobile boundary sends only opaque ID, never email. The current mobile `setSentryUser` and event scrubber enforce id-only, and the public sentence still claims the old behavior. This is a public PII category/recipient statement, not a style preference. [Public disclosure](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/trust-pages.html.ts#L145-L154), [procedure of record](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/docs/privacy/vendor-deletion-and-backups.md#L177-L189), [current mobile setter](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/367e6c48dac676151400d4d4b9959c4cc3c7586a/src/services/sentry.ts#L160-L172), [current event scrubber](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/367e6c48dac676151400d4d4b9959c4cc3c7586a/src/services/sentryPrivacy.ts#L169-L178)

Minimal fix: remove the email-attachment claim from the diagnostic bullet; keep the truthful opaque-ID disclosure and existing id-only privacy boundary. Update the stale PR-body vendor mapping, add a rendered-disclosure regression that fails before the copy correction and passes after, without loosening telemetry controls. [Candidate disclosure](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/trust-pages.html.ts#L154)

Independent probe commit `0130d2f0dd78c1ad57d12c24133bac4f6514a78d` adds only `test/audit-611-sol-sentry-disclosure.spec.ts` above the exact PR head; the one-job lane commit is `b404d489ff1c107ba21082f6477acea8aef5fafc`. CI completed with **1 expected assertion failure / 1 pass**: the rendered public diagnostic item still includes email while the procedure-of-record assertion correctly says id-only. This is a policy/procedure consistency proof, not a live mobile payload test. [Probe run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171443037)

### Posted verdict

**REQUEST CHANGES — A/B/C = 0/1/0**, head `5eac8f21bb70460da7dea7be5ce9f84f40870afb`, B-611-7. Head was re-read immediately before posting and had not moved. The full verdict is saved to `ops/aud-116/AUD-SOL-PRIV-116/backend-611-verdict-5eac8f21.md`. [Posted Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459)

## Mobile #315 — refreshed-head stage blocked

The instructed refreshed-head phase requires #611's dual approval, which is not available while B-611-7 remains open; no refreshed #611 or #315 head was supplied during this audit. The original mobile approval remains the prior model evidence at `8fff3f8f3829aab4079973b38428e2d266bc3f3b`, not a new attestation from this job. [Backend blocker verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459), [prior mobile Sol approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/315#issuecomment-5972016148)

The prior mobile canonical URL constants are exactly `https://app.trygrowthproject.com/privacy` and `https://app.trygrowthproject.com/consumer-health-privacy`, matching #611's unchanged bare root paths; a future refresh must preserve those constants and the previously approved no-PII failure/recovery composition. This observation is context only, not a refreshed-head verdict. [Mobile URL contract](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/8fff3f8f3829aab4079973b38428e2d266bc3f3b/src/config/env.ts#L63-L72), [backend policy paths](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5eac8f21bb70460da7dea7be5ce9f84f40870afb/src/public-pages/trust-pages.html.ts#L37-L45)

## Operator recommendation

Default: assign the minimal backend copy/body correction and retain the regression probe; do not weaken id-only telemetry and do not treat the known false email disclosure as an approved current fact. A content-fix head requires the risk-scoped fresh independent verdicts before the originally planned mechanical main refresh and paired publication. No new owner policy decision is needed to describe already-approved id-only behavior accurately. [Finding and verification rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459)

## Evidence preservation / cleanup

The probe is additionally preserved at `ops/aud-116/AUD-SOL-PRIV-116/audit-611-sol-sentry-disclosure.spec.ts`, and its CI log is `backend-611-sol-disclosure-probe.log` in the same directory. The completed throwaway remote branch was deleted; its immutable run remains the proof receipt. The local worktree/commit/files are retained under the higher-priority shared-workspace preservation rule. No candidate source change exists: the local difference from the PR head contains only the independent probe spec. [Completed probe receipt](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171443037)

## HANDOFF

Backend #611: REQUEST CHANGES, exact head `5eac8f21bb70460da7dea7be5ce9f84f40870afb`, A/B/C 0/1/0, B-611-7 open; 11/11 required checks green but BEHIND. Next: builder corrects the false Sentry-email disclosure and PR-body mapping, retains failing-before/passing-after evidence, then fresh independent exact-head closure and mechanical main refresh. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5975837459)

Mobile #315: no new verdict; prior approved head `8fff3f8f3829aab4079973b38428e2d266bc3f3b`. Next: after #611 clears the material disclosure blocker, operator refreshes the pair and assigns the named merge-only deltas, preserving the exact root-policy URL contract. The requested stay-for-refresh phase is blocked on a content fix, not a merge-only input; this job ends with complete evidence so the operator can route that fresh head. [Publication pair prerequisite](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/611#issuecomment-5972222465), [prior mobile approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/315#issuecomment-5972016148)
