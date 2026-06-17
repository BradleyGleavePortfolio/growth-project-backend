# ADR 0002: Talent Marketplace rebuild — two-sided job board, Connect reuse, in-house verification & anti-bot

- **Status:** Accepted (operator-locked, 2026-06-17)
- **Date:** 2026-06-17
- **Author:** Bradley Gleave
- **Supersedes:** the admin-pool framing of PR #183
- **Superseded by:** —

## Summary

PR #183 (`feat/phase-11-talent-marketplace`, branch `714a69af`) is **rebuilt
fresh on current `main`, not patched**, and is closed. The good IP is ported
file-by-file (see Salvage manifest). This ADR records eight operator-locked
decisions, the still-open items, and the salvage manifest. The full sequenced
build lives in `plans/TM_REBUILD_CHAIN_V2.md` in the `tgp-agent-context` repo.

## Decisions (all final)

1. **Rebuild-not-patch.** #183 is rebuilt clean on `main`; logic is ported
   file-by-file from `714a69af`. Rationale: the old branch carries mis-dated
   migrations, wrong RLS, and duplicate Connect surfaces that are cheaper to
   re-derive than to untangle on a long-lived feature branch. #183 is closed.
2. **Two-sided PUBLIC job-board re-scope** (supersedes admin-pool framing):
   public SEO-indexed `JobListings`, browse without an account, pre-coach
   account + lightweight Applicant profile created at Apply, two-way fit,
   applicant-tracking for hirers, job-hunter portfolio/alerts, calendar reuse,
   auto-flip applicant→sub-coach with heavy onboarding. **Full web parity
   (Next.js/SSR) + mobile.** Rationale: a discoverable public marketplace is the
   product, not an internal admin pool.
3. **Connect = REUSE existing `/coach/connect/*` (ONE surface).** DROP the old
   `CoachConnectAccount` table and `/talent/connect/*`. A thin adapter (TM-10)
   maps talent onboarding onto the existing service; **append-only** on the
   shared Connect surface (R71). Rationale: one payout surface, no divergent
   onboarding logic.
4. **Migration re-date floor.** All new TM migrations MUST be dated AFTER
   `main`'s latest migration `20261219000000`. Do not replay old
   `20260507`/`20260524`/`20260703` timestamps. Rationale: mis-dated migrations
   reorder against `main` and corrupt the migration history.
5. **Background check = BUILD IN-HOUSE** (final). NO Checkr / NO Stripe
   Identity / no per-coach vendor fees, even though talent-side coaches may
   train clients in person. TGP owns the FCRA + PII-custody liability (ID /
   criminal-record storage, encryption, RLS write-scope, retention/deletion,
   audit). Resolves the prior open item; TM-12b onboarding-checklist follows the
   in-house path.
6. **Anti-bot on the public apply surface = IN-HOUSE** (TM-6): velocity/anomaly
   checks + rate-limits + duplicate-device/identity heuristics. NO vendor
   challenge provider (no Turnstile/hCaptcha). Rationale: keep the public apply
   path under our own controls and data.
7. **RLS idiom = spine idiom.** All new-table policies use
   `app.current_user_id()` / `app.is_owner()` + `service_role` bypass; anon →
   zero rows; published listings public-read only. Template =
   `prisma/migrations/20261215000200_contracts_rls/migration.sql`. The
   head-coach → applicant scope REUSES the existing `TeamSubCoachAssignment`
   non-archived predicate (no new team-scope expression).
8. **Operator-approval gate.** PII/RLS/auth-surface PRs (TM-1, TM-5, TM-8,
   TM-12, TM-13) require operator sign-off before merge.

## Still-open items (operator decides later — do NOT resolve here)

- **Web SSR lane:** shared web app/shell with the consumer marketplace, or a
  standalone talent web app? (Affects sequencing + RLS spine A1–A4 order.)
- **Gym-owner hirer identity model:** a `User` role vs a Gym affiliation
  entity? (Affects `HirerVerifiedGuard` + listing-ownership RLS.)
- **Chain B `ContractEnvelope` at offer-accept:** wire now, or keep as an
  extensible seam?

## Salvage manifest (port from `714a69af`, file-by-file)

**Port:**
- Idempotency ledger (`claimOrReplay` / `markCompleted` / `releaseClaim`) — and
  FIX the `releaseClaim` swallow-error stale-claim bug (P1-8) via a TTL sweep.
- Transactional offer-accept with withdraw-others.
- Partial unique indexes (one-pending-per-`(head_coach, application)`;
  one-accepted-per-application).
- Structured Stripe errors (`PAYMENTS_PROVIDER_*`,
  `CONNECT_ONBOARDING_UNAVAILABLE`) + 10s `AbortController` + deterministic
  idempotency keys.
- Replace hand-rolled `hashReturnUrl` with `crypto.createHash`.
- Keyset tuple pagination; PII omission; comp-term validation.
- Port/adapt the 6 existing test suites (~1500 LOC).

**Fix P1-4:** `canViewTalentPool` / offer-create must EXCLUDE sub-coaches — add
`HeadCoachOnlyGuard` + `NoActiveSubCoachGuard`.

**Drop:** wrong Supabase-style RLS; duplicate `CoachConnectAccount` /
`/talent/connect/*`; dead `WorkPreferences` alias + legacy `findReplay`/`record`;
mis-dated migrations.

## Reference

Full sequenced build chain: `plans/TM_REBUILD_CHAIN_V2.md` (in the
`tgp-agent-context` repo).
