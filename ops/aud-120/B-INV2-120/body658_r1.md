Builder: TGP annex lane A2-COACH-TOOLS

## Tier header
- **Tier:** T4
- **Why:** codes decide which coach a client attaches to (tenancy), the ledger is coach-scoped data under new RLS, the attach transaction (the one canonical `User.coach_id` writer) gains a write, and a CI gate file (`.github/workflows/ci.yml`, community-live-tests job) gains one spec path.
- **T4 trigger scan:** tenancy / RLS (new table `InviteRedemption`, new policies) — yes; attach path (`attachUserToCoachByCode`) — yes; CI gate file — yes (one added spec path, nothing removed or weakened); money — no (no Stripe calls; package bindings reuse the `InviteGrantService` rules via `assertBindablePackage`); PII — ledger stores ids, code string, package id, timestamp only; consent / AI — no.
- **T3 trigger scan:** new public API routes (5, all coach-only, flag OFF); new env flag; migration.
- **Bounded T1:** README, runbook kill-switch line.
- **Builder-owner:** TGP annex lane A2-COACH-TOOLS (Claude Opus 5.5). Never self-audited.
- **Acceptance evidence:** targeted jest (below) + required checks at head; live RLS + exact-count proof runs in `community-live-tests`.
- **Promotion triggers:** none above T4.
- **Fix round 1 (B-INV2-120, agent 120) @ `4de7a6dccaabd8ead5aabbfa276ebcf847a114c0`:** tier stays T4 (tenancy: Team Mode attribution now applied to `/coach/codes`). Main `ee55f814` merged. Size 2,960 / 3,000 (grandfathered). Closes B-658-1, B-658-6, B-658-7; C-658-2 and the same-lines part of C-658-5 closed with them; other Cs listed as follow-ups in the fix round comment.

## What this does (owner ask: catch a leaked clinic code; create, rotate, revoke, QR)
1. **Code management** (`/coach/codes`, `FEATURE_COACH_CODE_TOOLS`, default OFF → `404 coach_code_tools_disabled`):
   - `GET /coach/codes` — coach link first, then shareable codes with `status` (`active` / `retiring` / `revoked` / `expired` / `used_up`), `join_url` = `qr_payload` = `https://app.trygrowthproject.com/join/<code>` (universal links for `/join/*` are live), package, rotation lineage and exact usage from the ledger (`signups_total`, `signups_7d`). Single-recipient emailed invites are excluded (bound to one email, cannot leak).
   - `POST /coach/codes` — `GP-XXXXXX`, unlimited and open-ended unless `max_uses` / `expires_at` are set; optional `label` and package + grant mode (checked first by `InviteGrantService.assertBindablePackage`, the same rules `setBinding` uses, then written in the same INSERT as the code, so no caller ever sees an unbound code). `Idempotency-Key` header (malformed -> `400 idempotency_key_invalid`): a retried or overlapping create returns the first, complete code (`replayed: true`; unique `(coach_id, idempotency_key)`, key namespaced per issuer).
   - Team Mode: an active team sub-coach's codes are stored under the head coach with `invited_by_user_id` = the sub-coach (same `resolveTeamAttribution` as the legacy create), so clients attach to the head coach. A sub-coach lists, rotates, revokes and counts only their own codes and has no coach link (`403 coach_link_head_coach_only`); the head coach sees and manages every team code.
   - `POST /coach/codes/:id/rotate` `{grace_hours 0..168}` — successor copies label, limits, live expiry, package binding and sub-coach attribution; `rotated_from_id` (unique) links it. Grace 0 revokes the old code now; grace N keeps it working until now+N h, then `code_expired`. A retried or concurrent rotate returns the one successor. `:id = coach-link` (body `expected_code` = the link on screen, required) rotates the permanent coach link and archives the old link code as an InviteCode row (revoked, or live for the grace window, binding copied, `successor_code` recorded) so it keeps resolving to this coach; a retried or overlapping duplicate returns that first successor and writes nothing.
   - `POST /coach/codes/:id/revoke` — idempotent; the coach link can only be rotated (`409 coach_link_not_revocable`).
   - Audit row per action: `invite_code.created`, `invite_code.rotated`, `invite_code.revoked`.
2. **Daily signup counts** `GET /coach/codes/signups?days=1..90` — exact counts of ledger rows bucketed by calendar day in the coach's time zone (`CoachProfile.timezone`, else `America/Los_Angeles`; DST-safe via Intl), zero-filled, overall + `by_code` + `by_package`, with `unusual_today` (today >= 3 and >= 3x the trailing 7-day average) as the leak signal.
3. **Signup ledger** `InviteRedemption` (always on, not flag-gated, so history exists when the flag flips): one row per NEW redemption, written inside the attach transaction (code string, `coach_link` / `invite_code`, package bound at that moment). Replays, refusals and lost races write nothing.
4. **Specific refusals:** a NEW redemption of a code that exists but cannot take a signup answers `code_revoked`, `code_expired` or `code_exhausted` (copy says what to do next). Unknown codes stay `invite_code_invalid`; the public preview / validate stay collapsed (`{valid:false}`), so enumeration posture is unchanged. The legacy `POST /coaches/me/invite-link/regenerate` now archives the old code the same way (so it answers `code_revoked`, not a bare invalid). Already-shipped mobile signup paths map these via `src/lib/inviteAttachOutcome.ts` (`revoked|expired` → expired copy, `exhausted` → used-up copy); the day-one pairing step (`src/screens/day-one/api.ts` `classify`) reads only `reason` and shows "not recognized" for them. The mobile A2 PR adds exact copy.

**Rotating never breaks a client's coach link:** no route touches `User.coach_id`; an attached client replaying the old code still gets the idempotent `already_attached` success (tested in unit and live).

## Inventory (what existed, what is reused, what is new)
| Exists on main | Use here |
|---|---|
| `InviteCode` rows + `POST/GET/DELETE /coach/invite-codes` (14-day single-use defaults) | Kept unchanged; legacy revoke now also stamps `revoked_at` |
| `CoachProfile.invite_code` + `/coaches/me/invite-link(/regenerate)` | Regenerate now archives the old code (see 4) |
| `attachUserToCoachByCode` (canonical writer) | + ledger write in its transaction, + specific lifecycle refusals |
| `InviteGrantService.setBinding` / `PUT v1/invite-codes/:code/package-binding` | Reused for package binding on create |
| `listRedeemersForCoach` (best-effort time window, no ledger) | Untouched; the ledger is the exact source from now on |
| Nothing for daily counts, rotation lineage, idempotent create, QR payload | New |

## Flags / env / migration / dependencies
- **Flag added (default OFF):** `FEATURE_COACH_CODE_TOOLS` (`values: ['true','false']`, `unsetIs: 'off'`), registered in `ENV_RULES`, in `.github/fly-env-desired-state.json` as `"unset"` with a gate line, and in the runbook kill table.
- **Migration prefix:** `20270302000000_coach_code_tools` (reserved for A2, unapplied anywhere). Additive only: 5 nullable `InviteCode` columns (fix round 1 adds `successor_code`) + 2 unique indexes; new `InviteRedemption` with RLS (service_role ALL; SELECT owner or own `coach_id`; no public writes; RESTRICTIVE anon deny). `down.sql` included. `schema.prisma` matches (`prisma migrate diff` from main's schema produces exactly the DDL in the migration).
- **CI gate change (T4, read line by line):** `.github/workflows/ci.yml` community-live-tests job runs one more spec, `test/invite-codes/coach-code-tools.live.spec.ts` (same env gate and DB as the other community live suites; nothing removed).
- **Dependencies:** none to merge first. Mobile A2 PR (Codes screen, QR, signups view, export button, comp action) builds on these routes. Comp access ("stop billing, keep access") is a separate backend slice that reuses B-RECUR's cancel route; not in this PR.
- **Deletion manifest:** #608 is on main, so `InviteRedemption.coach_id` and `InviteRedemption.client_user_id` are now `del` entries in `ERASURE_MANIFEST` (fix round 1; `erasure-manifest-coverage` and `manifest-fk-order` pass). Ledger rows carry no PII (ids, code, package id, time).
- **Size:** ~750 lines of service/controller, the rest tests (unit + stateful + live). One slice, because the ledger, the refusals and the routes are proven together.

## Tests (each fails before: none of this existed at 53b6d472)
- `test/coach-code-tools.service.spec.ts` — kill switch; QR payload; DST bucketing; leak signal; create (GP- shape, idempotent replay per coach, refused binding leaves no code, expiry in past); rotate (grace 0 / grace 24h / idempotent retry / tenancy 404 / revoked cannot rotate / coach link archive); revoke (idempotent, one audit, coach link 409); list (own codes only, exact usage); signups (exact per day / code / package across DST, zero-fill, tz fallback).
- `test/invite-attach-ledger.spec.ts` (stateful DB double) — one ledger row per new redemption with code/source/package; none on replay, refusal or lost race; `code_revoked` / `code_expired` / `code_exhausted`; coach-link rotation keeps attached clients, replay succeeds, new signup refused; grace window; legacy regenerate archives.
- `test/coach-code-tools.controller.spec.ts` — guards, every route 404 while OFF and touches nothing, tenancy from `req.user` only.
- `test/invite-codes/coach-code-tools.live.spec.ts` (CI community-live-tests) — counts equal `GROUP BY` on the real table; rotation + revoke on real rows; another coach 404; RLS as `authenticated` / `anon`: own rows only, client none, no insert/update/delete.
- Updated (intended behaviour change, exhausted code now names its state): `test/invite-attach-idempotent-replay.spec.ts`, `test/invite-attach-reliability.spec.ts`; ledger delegate added to prisma doubles in `auth-signup-role-choice`, `e2e-saas-smoke`, `invite-grant`, `onboarding-audit-regressions`, `invite-codes.service` specs (no assertion weakened).

Local (through heavy.sh, `--runInBand`): the 4 new specs + `roles-enforced`, `fly-env-manifest`, `env-registration`, `env-discovery` and the 13 invite/attach/auth specs above — all pass (live spec skips locally by design). ESLint clean on changed files; R75 checker: no positive banned-token change.

## Fix round
| Finding | Change | Commit | Test |
|---|---|---|---|
| B-658-1 (Opus, Sol) | `/coach/codes` scope from `resolveTeamAttribution`: sub-coach code -> `coach_id` head, `invited_by_user_id` sub; issuer-scoped list/rotate/revoke/signups; no coach link for sub-coach (403); team feed event; `issued_by_user_id` in view | f97c621a | unit `B-658-1: a sub-coach code lives in the head tenant…`; live `B-658-1: a team sub-coach code attaches its client to the head coach and head ledger` |
| B-658-6 (Sol) | package checked first (`assertBindablePackage`, shared with `setBinding`), binding in the same INSERT; no delete-after-refusal; P2002 loser returns complete winner | f97c621a | unit `B-658-6` x2 (undecided package hidden from list/replay, refusal leaves nothing; overlapping retry gets the same bound code) |
| B-658-7 (Sol) | coach-link rotate requires `expected_code`; archived row stores `successor_code`; retry/overlap replays the first successor, writes nothing | f97c621a | unit `B-658-7` (sequential retry, late retry, grace 0/24); live `B-658-7` (overlapping `Promise.all`, late grace-0 retry, old link still in grace) |
| C-658-2 | `InviteRedemption` both User FKs in `ERASURE_MANIFEST` (#608 on main) | f97c621a | `erasure-manifest-coverage`, `manifest-fk-order` |
| C-658-5 (same lines as B-658-6) | malformed `Idempotency-Key` -> `400 idempotency_key_invalid` | f97c621a | unit `C-658-5` |
| merge | main `ee55f814` merged, no conflicts | fd8a0008 | all required checks |

