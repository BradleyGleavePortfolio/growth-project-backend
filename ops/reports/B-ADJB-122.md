# B-ADJB-122 — Roman approve-to-adjust backend fix round 1 (b#655), agent 122

Status: DONE 17:28 PDT. FIX ROUND 1 posted, READY FOR AUDIT: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006482768
Time box 16:50-17:50 PDT.
Lock: ops/lanes122/locks/roman-adjust-be. Mobile half: B-ADJM-122 (m#337); contract notes in ops/lanes122/notify/adjust.txt.

## Heads
- Before: bf9120c1178c28b54256d41afed05a25578353f3 (2,058 lines, base main, behind).
- Merge origin/main 6aff479cd09f1afdeafedf47684cb34f4ef0584e (clean, no conflicts) -> 356ccc8d.
- Fix commit 2d356da43e8c2e4472005c234bba5dadf937b7d0, then merge-only refresh of main a70533d5 (#734, 4-line coachless fix) because PR CI
  at 2d356da4 was red only on test/coachless/coach-code-redemption.spec.ts, inherited from main 6aff479c (run 37390793076).
  Second push = deviation from "one push" to get PR CI green; the PR's own files are unchanged by it.
- NEW HEAD 2902add5bb9f96c2ea488282ee1e6d727d203044. Size vs main: 2,156 lines (grandfathered cap 3,000).
- Worktree wt/B-ADJB-122-655 and local branch fix/B-ADJB-122-655 removed after push (nothing unsaved).

## Fixed (ordinary-use story; failing-before test in the same specs)
| Finding | Story | Fix |
|---|---|---|
| Opus B-655-1a / Sol B-655-8 | PR CI red at tsc, PR cannot land | prisma double held via txHolder (no self-reference) |
| Opus B-655-1b | R2b wiring spec red | consent read via AiEgressService.consentedClients (global module); no ai-consent imports |
| Opus B-655-1c / Sol B-655-7 | erasure coverage red after main merge; coach deletion left proposals | manifest: Proposal.client_id/coach_id/decided_by_id delete, Event.actor_id delete (trigger blocks UPDATE only) |
| Opus B-655-2 | coach edits workout, taps Approve, is told to refresh for a new suggestion that never comes | WORKOUT_CHANGED: "...so it was not applied. Open the workout to review it." (mobile fallback matches, c37add1) |
| Opus B-655-3 | suggestion made Friday evening reads "tomorrow's" on Saturday morning | sentence names the weekday ("Saturday's"), never today/tomorrow |
| Sol B-655-6 | coach approves "by 50%" but client gets a 25% cut (one-set floor) | volume_pct = realized reduction everywhere (text, view, audit) |
| Sol B-655-9 | every card says "I suggest ... Shall I apply it?" (owner copy rule) | "Roman suggests trimming ... Approve to apply it." |
| Sol B-655-5 (copy part) | "averaged X hours over the last 3 nights" when 2 nights were tracked | "...on the nights tracked in the last 3 days" |
| Sol A-655-1 | head coach reassigns a client (sub-coaches.service / team-mode); old coach still sees her HRV/RHR and can approve/undo | list shows, and own() allows, only the caller's current live client (coach_id = caller, deleted_at null); stale pending rows closed as withdrawn (client_not_current) |

Failing-before (old src + new specs, constructor arg patched for the old signature only):
ops/aud-122/B-ADJB-122/before_service_spec.log (7 failed: the 6 new B tests + the updated text/pct expectation),
before_rules_spec.log (4 failed), before_wiring_erasure.log (wiring 1 failed; erasure coverage 2 failed).
After (fixed head, heavy.sh one file each): service 42/42, rules 13/13, ai-consent-wiring 7/7, erasure-manifest-coverage 7/7,
manifest-fk-order 10/10; eslint clean on the 7 changed files.

## Proposed C (edge or scope) for the operator
- Sol B-655-1 fingerprint is a check, not a write fence: needs a completion/edit committed in the same instant as Approve. C (edge, deferred to 10k clients).
- Sol B-655-2 no server-side start claim: needs the client mid-workout at the exact moment the coach approves, plus a new start API and mobile wiring. C (edge, deferred to 10k clients).
- Sol B-655-3 undo/dismiss after consent withdrawal: needs withdrawal inside the 10-minute undo window or with the card open; list already closes withdrawn rows. C (edge, deferred to 10k clients).
- Sol B-655-4 direct approve of a passed workout: needs the card held open past the workout day without a reload; started/completed workouts are still refused. C (edge, deferred to 10k clients).
- Sol B-655-5 rule semantics (average vs count of short nights): needs an unusual input (one ~1-hour tracked night); copy is now true. C (edge, deferred to 10k clients).
- Sol B-655-10 / Opus C-655-2 sub-coach access: scope, not a break; head coach sees and decides everything. Operator decision below.
- Sol A-655-1 RLS half: SELECT policies still key on proposal.coach_id; the API (service role) now enforces the current-client boundary and anon is revoked. C.
- From mobile (adjust.txt): ADJUSTMENTS_UNAVAILABLE says "Your workouts are unchanged" and can show after an unconfirmed Approve if the reload 503s. C.
- Opus C-655-5 / mobile C-337-1: an Edit that raises sets shows a negative "% less volume". C.
- Opus C-655-1, -3, -4, -6 .. -13 and Sol C-655-1, -2 unchanged.

## Operator decisions (recommended defaults)
1. Sub-coach suggestions: defer; head coach only at launch.
2. Sentence voice: impersonal "Roman suggests ..." now; keep (closes Opus decision 2 and Sol B-655-9).
3. Migration name 20270227000000 sorts before applied migrations but commutes: keep (A6.2 precedent).
4. Erasure: proposals are deleted with the client and with the proposing/deciding coach (health signals); the applied sets stay in the client's snapshot: keep.

Flag FEATURE_ROMAN_ADJUST_ENABLED stays off (unchanged, default OFF).

## CI
- PR CI at 2902add5: all 10 workflows success; CI run 37392946592 (build-and-test full tsc + jest) success.
- PR CI at 2d356da4: CI failure only on the inherited coachless spec; all other workflows success.
- CI lane ci/B-ADJB-122-1 (5 specs + tsc): run 37391752566 success https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37391752566 (branch deleted).

## HANDOFF
- Done. b#655 head 2902add5bb9f96c2ea488282ee1e6d727d203044, PR CI green, FIX ROUND 1 comment posted (READY FOR AUDIT):
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006482768 (text: ops/aud-122/B-ADJB-122/comment-b655.md).
- Next: Opus + Sol delta re-review at 2902add5 (prior Bs + changed lines). Lands with m#337 (B-ADJM-122). Flag stays off.
- Cleanup done: worktrees removed, ci/B-ADJB-122-1 deleted, lock roman-adjust-be released, adjust.txt updated. No run in flight.
