# AUD-SOL-RADJ-121 — agent 121 — independent Sol audit

Scope: backend #655 at `bf9120c1178c28b54256d41afed05a25578353f3`; mobile #337 at `63be101394d996bd4475a8ad86c400925997092c`.
First full review, T4. Both heads claimed. No other lens notes or verdicts read.

## Verdict summary

| PR | Exact head | Sol verdict | A/B/C | Posted comment |
|---|---|---|---|---|
| backend #655 | `bf9120c1178c28b54256d41afed05a25578353f3` | REQUEST CHANGES | 1/10/2 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6001900785) |
| mobile #337 | `63be101394d996bd4475a8ad86c400925997092c` | REQUEST CHANGES | 1/4/2 | [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6001900495) |

Full finding text, file:line links, counterexamples and minimum fix rules are preserved in `/home/user/workspace/ops/aud-121/AUD-SOL-RADJ-121/backend-655-verdict.md` and `mobile-337-verdict.md`.

## Review and evidence

- Common 121 brief read fully; A1, A6, A7.2 and A9.1 read from the current source-of-truth clone.
- Both diffs and their test suites read; tracing tenancy, consent, concurrency, erasure and mobile lifecycle/error paths.
- Existing backend CI fails TS7022/TS7024 in the newly added self-referential Prisma fake: [build-and-test job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37081735821/job/111083526168).
- Existing mobile CI fails its vendor guard after npm ci because this PR tracks a node_modules symlink: [Typecheck, lint, test job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37081842688/job/111083846786).
- Backend probes submitted to [CI lane 37365523190](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37365523190); remained queued during the runner incident and cancellation completed at handoff without execution.
- Mobile initial probes submitted to [CI lane 37365530861](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37365530861); cancelled before running to comply with the newly added one-in-flight-lane-per-agent limit.
- Mobile probe updated locally to use the asynchronous APIs required by the pinned React Native Testing Library 14 package; all original PR card render calls are unawaited, an additional test/typecheck blocker beyond the tracked symlink.
- No local tests, builds, npm, tsc or lint run. No CI proof is claimed for an unstarted lane.
- Head check at `2026-10-05T12:52:53-07:00` matched both assigned heads; original PR sizes are within their grandfathered limits (backend 2,058, mobile 1,052 changed lines).
- Both heads rechecked immediately before their respective GitHub POSTs; both posted comment headers/counts verified by reading only the new own comments.
- Cleanup completed at `2026-10-05T12:55:52-07:00`: both own audit branches deleted remotely, both detached worktrees removed, no shared dependencies touched.

## Finding index

### Backend #655

- A-655-1: stored proposing-coach ownership is not current live client authorization; service reads/decisions and new RLS need the same current-client boundary.
- B-655-1: final fingerprint/start read followed by unconditional snapshot write is not a concurrency fence.
- B-655-2: client only reports `started_at` on completion, so active training remains adjustable; a durable assignment-start integration is needed.
- B-655-3: undo/dismiss lack box-2 gating and return full health-bearing proposal views after withdrawal.
- B-655-4: direct approve/edit accepts a stale, passed workout unless a list call previously expired it.
- B-655-5: average sleep is incorrectly treated as two short nights, and two measurements are described as three.
- B-655-6: minimum-set floor/rounding stores requested volume percent as actual reduction.
- B-655-7: missing erasure-manifest decisions for new user-id columns; deleting coach retains assignments on current main and does not cascade these new rows.
- B-655-8: TS7022/TS7024 in added self-referential Prisma fake break required CI.
- B-655-9: generated Roman copy contains prohibited first person.
- B-655-10: direct-roster-only scope excludes authorized delegated sub-coaches.

### Mobile #337

- A-337-1: raw Zod error/unknown error diagnostics can expose health-bearing received strings or unrecognized code text to Sentry.
- B-337-1: committed root node_modules symlink causes EISDIR in vendor guard.
- B-337-2: new acceptance tests treat the pinned async render/event APIs as synchronous.
- B-337-3: failed/invalid/lost mutation replies falsely assert that workouts are unchanged.
- B-337-4: approve/edit deliver stale parent callbacks after unmount, before mounted guard.

## Replay assets

- `ops/aud-121/AUD-SOL-RADJ-121/backend-655.probe.spec.ts`: eight proposed backend invariants; submitted in the unstarted backend lane.
- `ops/aud-121/AUD-SOL-RADJ-121/mobile-337.probe.test.tsx`: six mobile invariants; preserved corrected draft uses await for React Native Testing Library 14. The initial cancelled lane held an earlier draft with synchronous test calls.
- The probes intentionally encode safe expected behavior and need replay at the failing-before and fixed heads; no result is represented as runtime-proven.
- Builder should add integration regressions for live start/complete fencing, current-client/delegation revocation and erasure (those are static traces, not included runtime probes).

## Follow-ups (C)

- C-655-1 — `src/roman-adjust/roman-adjust.service.ts:155,189`: stable cursor/rotation needed for the 50-proposal/200-client silent caps.
- C-655-2 — `src/roman-adjust/roman-adjust.constants.ts:13`: strict exact-value flag equality and uppercase/whitespace tests.
- C-337-1 — `src/components/roman/adjust/RomanAdjustmentCard.tsx:89,328`: schedule deadline refresh to remove expired server Undo.
- C-337-2 — `src/components/roman/adjust/RomanAdjustmentCard.tsx:83-84,282`: reset discarded edit draft on Cancel/new edit session.

These are optional follow-ups, not builder freeze work unless a C touches the same lines as a B fix.

## Operator recommendations

- Assign one builder to this backend/mobile pair, replay both lenses' probes, preserve feature scope and keep the adjustment flag off.
- Refresh both old PRs onto current main before fixing erasure and retest strict typecheck/full required CI when GitHub runners recover.
- Recommended default for sub-coaches: canonical open-delegation access, separate tenant owner from decision actor, no team-wide access by membership alone.
- No new owner policy decision is required for the listed fixes.

## HANDOFF

Completed: both REQUEST CHANGES verdicts are posted at the assigned exact heads (comment URLs in the summary table). Both exact-head existing required CI checks are red; both new probe lanes were cancelled without execution during the runner-assignment incident, and no runtime results are claimed. Own remote audit branches and worktrees are removed. No PR branch, main checkout, production data, settings or flags were modified.

Next: a fresh builder handles A/B findings on this pair, incorporating the other independent lens only after its verdict is posted; replays the archived probes in CI at failing-before/fixed heads; adds start/delegation/erasure integration coverage; refreshes both old heads to main; and posts READY only at green exact-head required checks. Keep `FEATURE_ROMAN_ADJUST_ENABLED` off. Optional C items remain follow-ups under the freeze rule.
