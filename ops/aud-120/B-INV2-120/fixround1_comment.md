FIX ROUND 1 (B-INV2-120, agent 120) — growth-project-backend#658 @ 4de7a6dccaabd8ead5aabbfa276ebcf847a114c0

Audited head 08534e17c686602415f0836abc66db0182aeea3f (Opus [5964473420](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-5964473420), Sol [5964522757](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658#issuecomment-5964522757), both REQUEST CHANGES). Main `ee55f814` merged (fd8a0008, no conflicts). Size vs main: 28 files +2,888 / -72 = **2,960 / 3,000** (grandfathered). Tier T4 unchanged. Flags unchanged (`FEATURE_COACH_CODE_TOOLS` default OFF).

## Findings -> change -> commit -> test
| Finding | Change | Commit | Test |
|---|---|---|---|
| **B-658-1** (Opus, Sol) team attribution bypassed | `CoachCodeToolsService` resolves scope with `InviteCodesService.resolveTeamAttribution` (the legacy create's rule, now public). Sub-coach code: `coach_id` = head, `invited_by_user_id` = sub. Sub-coach lists, rotates, revokes and counts only own codes (`invite_code: { is: { invited_by_user_id } }` on the ledger); no team coach link (`403 coach_link_head_coach_only`); head coach sees and manages every team code; row rotation keeps tenant and issuer; team feed event `invite_sent_by_sub_coach`; `issued_by_user_id` in each view; audit `tenantCoachId` = head | f97c621a | unit `B-658-1: a sub-coach code lives in the head tenant, scoped to its issuer` (stored attribution, head bound package, head list, sub list without link, sub-2 404 on rotate/revoke, rotation keeps attribution, head revokes, scoped signups, 403 on link); live `B-658-1: a team sub-coach code attaches its client to the head coach and head ledger` (real `TeamSubCoachAssignment`, `User.coach_id` = head, ledger row under head, head list, sub signups 1, other coach 404) |
| **B-658-6** (Sol) code published before binding decided | Package checked first by new `InviteGrantService.assertBindablePackage` (the `PACKAGE_NOT_FOUND` / `PACKAGE_REQUIRES_CONTRACT` rules, now shared by `setBinding`), then `package_id` / `grant_mode` written in the same INSERT as the code. The delete-after-refusal path is gone; a same-key P2002 loser and any replay read the complete row | f97c621a | unit `B-658-6: while the package is undecided no caller sees the code; a refusal leaves nothing` (list empty, same-key retry refused identically, 0 rows); `B-658-6: an overlapping retry gets the same, fully bound code` |
| **B-658-7** (Sol) coach-link rotation not replay safe | Rotate body `expected_code` (the link on screen), required for `coach-link` (`400 expected_code_required`). In the transaction: current link != expected -> no write; the archived row records `successor_code`; a retry or overlapping duplicate returns that first successor (`replayed: true`) as it stands, whatever its `grace_hours`. New nullable column `successor_code` in this PR's own unapplied migration + `down.sql` | f97c621a | unit `B-658-7: a retried coach link rotation returns the first successor and changes nothing` (sequential retry, one archive row, intentional rotation from the new link with grace 24 -> previous `retiring`, late retry, missing expected -> 400); live `B-658-7: overlapping and late retries of one coach link rotation keep one successor` (`Promise.all` on Postgres -> one `replayed: false` + one `true`, same code; late grace-0 retry leaves the grace-24 archive live and attachable) |
| **C-658-2** (Opus, Sol) erasure manifest (now required: #608 on main) | `InviteRedemption.coach_id` and `.client_user_id` as `del` entries before the InviteCode entries | f97c621a | `erasure-manifest-coverage`, `manifest-fk-order` |
| **C-658-5** part (same create lines as B-658-6) | malformed `Idempotency-Key` -> `400 idempotency_key_invalid`; keys namespaced per issuer | f97c621a | unit `C-658-5: a malformed Idempotency-Key is refused, not ignored` |
| README | team scope, atomic binding, `expected_code` | 4de7a6dc | — |

## Failing-before evidence
- Probe commit b5f583b8 = merge fd8a0008 + the new tests only, no fix. [ci/B-INV2-120-1-probe run 37346038154](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37346038154): **6 failed / 24 passed** — B-658-1 (stored `coach_id` sub-1), B-658-6 undecided (list shows `ic-1`), B-658-6 overlap (replay `package: null`, `grant_mode: none`), B-658-7 (second successor, `replayed: false`), C-658-5, controller `expected_code` pass-through. Every pre-existing test passes.
- [ci/B-INV2-120-2-probe run 37348156524](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37348156524) at b5f583b8: `erasure-manifest-coverage` **2 failed** naming `InviteRedemption.client_user_id` / `.coach_id`; `manifest-fk-order` passes.
- At 4de7a6dc all of the above pass (local heavy.sh: coach-code-tools.service 27/27, controller 3/3, invite-attach-ledger 10/10, invite-grant 25/25, erasure-manifest-coverage 7/7, manifest-fk-order 10/10; tsc clean; ESLint clean; R75 net 0).

## Probe replay (both lenses, at 4de7a6dc)
| Lens | Probe | Before (08534e17 / b5f583b8) | Now |
|---|---|---|---|
| Opus | B-658-1 stored attribution / attach to head / head visibility / non-owner mutation denial | fail (run 37346038154) | pass (unit + live) |
| Opus | C-658-2 manifest coverage after #608 | fail (run 37348156524) | pass |
| Opus | C-658-5 malformed key | fail (run 37346038154) | pass |
| Opus | C-658-5 replay during binding | fail (B-658-6 probes) | pass |
| Opus | C-658-3, C-658-4, C-658-5 owner profile | not fixed (FREEZE, C) | follow-up |
| Sol | 5 targeted candidate suites (64 tests) | pass | pass (inside build-and-test: 774 suites, 13,227 tests) |
| Sol | 3 offline real-service probes (B-658-1/-6/-7); `ops/aud-sol-114b/658-*` not retained, rewritten as committed probes above | fail | pass |
| Sol | C-658-8 leak baseline depends on `days` | not fixed (FREEZE, C) | follow-up |
| Sol | 11 required checks at exact head | green at 08534e17 | green at 4de7a6dc |

## Money-list self-check
- Webhook order / redelivery: no webhooks or Stripe calls; client retries are the redelivery case: create replays by `(coach_id, idempotency_key)`, row rotate by unique `rotated_from_id`, coach-link rotate by `expected_code` + `successor_code`.
- Concurrency and lock order: no new locks; races settle on unique indexes (idempotency key, `rotated_from_id`, `InviteCode.code` for the link archive) plus the profile CAS; the loser reads the committed winner (live `Promise.all` proof).
- Terminal states: revoked stays revoked (rotate of a revoked code refused); an archived link row ends revoked or at grace end; a replay never revives or re-times a code.
- Pagination and fail-closed completeness: list cap unchanged (200); every query carries tenant and, for a sub-coach, issuer filters; out-of-scope ids answer the non-leaking `404 code_not_found`.
- Currency and minor units: none handled (package ids and grant mode only).
- Copy truth: new copy is specific and second person: `idempotency_key_invalid`, `expected_code_required`, `coach_link_head_coach_only`, `code_rotation_conflict` (text in `coach-code-tools.service.ts` / `invite-codes.service.ts`).

## Not fixed in this round (C, FREEZE)
C-658-3 (legacy list shows archived link rows), C-658-4 (row rotation copies a binding without re-check), C-658-5 owner `getOrCreateDefaultForCoach` in list, C-658-8 (leak baseline window). File, line and fix rule are in the builder report.

## Overlap
- #657 (coach-code redemption) maps only `invite_code_invalid` from `attachUserToCoachByCode` to its lifecycle refusals (`ATTACH_TO_COACHLESS`). With this PR on main, attach answers `code_revoked` / `code_expired` / `code_exhausted` (400) directly and #657 re-throws them raw instead of its 410 envelope. The second to land adds the three `INVITE_ATTACH_ERROR.CODE_*` keys to that map. Team attribution agrees (#657 attaches via `row.coach_id` = head). No schema overlap.
- Mobile main cc4ceeed has no `/coach/codes` caller yet (coach screen `InviteCodesScreen.tsx` is on legacy `/coach/invite-codes`); the day-one pairing `classify` reads only `reason`, so these three refusals show "not recognized" there. The mobile A2 PR must send `Idempotency-Key` and `expected_code`.

Required checks at 4de7a6dc: all 11 green (Banned cast tokens, CodeQL JS/TS, Schema parity, build-and-test, build-sbom, community-live-tests, danger, mwb-3-live-tests, npm audit, rls-floor-guard, rls-live-tests). [Checks](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/658/checks)

READY FOR AUDIT
