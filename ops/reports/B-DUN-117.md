# B-DUN-117 — dunning stack restack D1 -> D5 (#687-#691), merge-only

Builder: Claude Opus 5.5, operator agent 117. Started 2026-10-04 04:58 UTC (21:58 PDT 10-03).
Inputs read: _COMMON_117.md, _COMMON_116.md section 7, JOBS117.md entry B-DUN-117, reports B-D12-116.md and B-D34-116.md,
AGENT_RULES.md, every AUDIT / FIX ROUND comment on #687-#691 (copies in ops/aud-117/B-DUN-117/comments_<n>.md).

## Starting state (GitHub, 04:58 UTC)
| PR | Piece | Head | Base | Last round |
|---|---|---|---|---|
| #687 | D1 | f8e47bf40fe81064d679fc2831cedf3b1cd90b2c | main (643817b3; PR BEHIND, mergeable, no conflict) | FIX ROUND 1 + READY (comment 5976568403) |
| #688 | D2 | 6718d211fa6e64ccdde284a790f5bd440aa3d119 | D1 | FIX ROUND 1 + READY (5976393847) |
| #689 | D3 | 6cead7ec88e2ba17aa6418cf2636874a024bdf4a | D2 | FIX ROUND 1 + READY (5976301258) |
| #690 | D4 | 0681babdbe3125d7a9920b855c06d5285eeeb864 | D3 | FIX ROUND 1 + READY (5976653111) |
| #691 | D5 | 0f24a8fa15e5b13d86527fcafa6ee29fe171276a | D4 | FIX ROUND 2 (restack, merge-only), no READY (5976575121) |

No lens verdict exists at any FIX ROUND 1 head; the latest verdicts are the 116 lenses' REQUEST CHANGES at the pre-fix heads.

## B findings from the 116 lenses: closure check
Every B has a closing commit, a named test, and a failing-before CI-lane run. Each run below was checked on GitHub:
conclusion `failure`, and the jest summary matches the count the FIX ROUND states (so it failed on tests, not infra).
| Finding(s) | PR | Closing commit(s) | Test | Failing-before run (jest summary) |
|---|---|---|---|---|
| Sol B-687-1 (truncated live-grant page) | #687 | 41404998, 7d7e7db4 | test/dunning-v2-foundation-fixes.spec.ts "B-687-1 (Sol)" | 37172705221 (9 failed / 5 passed) |
| Opus B-687-1 (first person in email footer) | #687 | 41404998 | same spec, "dunning email copy" | 37172705221 |
| Sol B-687-2 (migration 20270215000000 ordering) | #687 | none: kept under operator ruling OR-113-4 (no dependency-order defect) | same spec, "OR-113-4" pins (pass before and after by design) | n/a (ruling) |
| Sol B-688-1 (stale Day-10 lock on a reopened cycle) | #688 | 09d4038f | test/dunning-v2-service-fixes.spec.ts "B-688-1 (Sol)" | 37173207695 (9 failed / 2 passed) |
| Sol B-688-2 (sweep starvation) | #688 | 09d4038f (+ D1 schema groundwork 41404998) | same spec, "B-688-2 (Sol)" | 37173207695 |
| Sol B-688-3 (coach transport failure recorded as sent) | #687/#688 | D1 41404998 via merge 37657b7d | same spec, "B-688-3 (Sol)"; D1 foundation spec | 37173207695, 37172705221 |
| Sol B-688-4 (raw diagnostics) | #687/#688 | 09d4038f, D1 41404998, f8e47bf4 | same spec, "B-688-4 (Sol)"; D1 class-name test | 37173207695, 37174326704 (1 failed / 22 passed) |
| Sol B-688-5 / Opus B-688-1 (lost dispute stops protecting the cycle) | #688 | 09d4038f | same spec, "B-688-5 (Sol) / B-688-1 (Opus)" | 37173207695 |
| Sol B-689-1 / Opus B-689-1 (card update settles an open dispute) | #689 | 67096788, 2edc9826 | test/dunning-d3-fix-round.spec.ts B-689-1 cases | 37173650946 (7 failed / 3 passed), 37174160085 (12 failed / 3 passed) |
| Sol B-689-2 (free-form diagnostics) | #689 | 67096788 | same spec, sentinel no-leak | 37174160085 |
| Sol B-689-3 (paid invoice credited without attribution) | #689 | 67096788 | same spec, B-689-3 | 37174160085 |
| Sol B-689-4 / Opus B-689-2 (cancel during dispute keeps period) | #689 | 67096788 | same spec, B-689-4 it.each | 37174160085 |
| Sol B-690-1 (in-flight subscription.updated resurrects 2A) | #690 | 821d943f, 0681babd | test/dunning-d4-fix-round.spec.ts | 37174150526 (9 failed / 2 passed) |
| Sol B-690-2 / Opus B-690-1 (failed dispute read resolves cycle) | #690 | 821d943f | same spec | 37174150526 |
| Sol B-690-3 (dispute effects lost) | #690 | 821d943f | same spec, BillingService.handleEvent redelivery | 37174150526 |
| Sol B-690-4 (free-form diagnostics) | #690 | 821d943f | same spec, sentinel no-leak | 37174150526 |
| Sol B-690-5 (unpaid excluded from grace) | #690 | 821d943f | same spec, unpaid Day 7 / Day 10 | 37174150526 |

Result: no unanswered B. Nothing to fix in this job; the round is merge-only on every moved piece.
Sol B-687-2 is closed by ruling, not by code; the lenses decide whether OR-113-4 disposes of it (operator item 1 below).

## Restack (lock `ops/lanes117/locks/dunning` held 04:58:25Z-05:01:37Z, released)
#687 left alone: it is mergeable against main 643817b3 (state BEHIND, no conflict), and the D1 -> D2 merge does not need main.
The operator's mechanical update-branch covers BEHIND when the stack lands.

Merge commits (identity TGP Agent 117, `git merge --no-ff`, every merge clean with no conflicts, all pushes fast-forward):
| PR | Old head | New head | Merge commit content |
|---|---|---|---|
| #688 D2 | 6718d211 | b17f514ccd8da195d18588ca4b7ca407a789f20e | merge of D1 f8e47bf4 |
| #689 D3 | 6cead7ec | bb992fedf0095446f916f3261742bd262c3d94da | merge of D2 b17f514c |
| #690 D4 | 0681babd | 06307883100ec142aa2818fc30ee276cab26c1ec | merge of D3 bb992fed |
| #691 D5 | 0f24a8fa | e0afe6780e5954b20e88cfaefd63f12cd31d218d | merge of D4 06307883 |

Tree checks (ops/aud-117/B-DUN-117/patchid.txt):
- Each merge's delta against its first parent (`git diff <old head> <new head>`) is exactly D1 `7d7e7db4..f8e47bf4`
  (src/notifications/emitters/coach-alert.emitter.ts +4/-3, test/dunning-v2-foundation-fixes.spec.ts +23), patch-id
  e0690bf6126236fb62f3c5c93a67fb19057ea7cf on all four.
- Each piece's own diff (base -> head) has the same `git patch-id --stable` before and after:
  D2 f120facf (2,313+/613- = 2,926), D3 b9a6be4e (2,913+ = 2,913), D4 8df30062 (2,690+/223- = 2,913 by git shortstat; B-D34-116 reported 2,906 under the size-rule exclusions),
  D5 1f6254e4 (2,742+). Every piece's own files are byte-identical to its last FIX ROUND head; sizes unchanged and under 3,000.
- No piece D2-D5 touches either D1 file.

CI: the push triggered two CI workflow runs on each of D3/D4/D5 (head push + base-branch change, same merge tree). The earlier
duplicate of each pair was cancelled (37178687609, 37178686640, 37178686574) so the later run is the latest check per name.

## CI per piece
All 7 checks that apply on a stacked base are green at every new head (CodeQL, banned casts, SBOM, danger run only on
main-based PRs; all 11 are green on #687 @ f8e47bf4, run 37174418115 and siblings).
| PR | Head | CI run (build-and-test + live suites) | npm audit | Schema parity |
|---|---|---|---|---|
| #688 | b17f514c | 37178687237 (build-and-test job 111366600908) | 37178687251 | 37178687240 |
| #689 | bb992fed | 37178688039 (job 111366602778) | 37178687988 | 37178687995 |
| #690 | 06307883 | 37178686881 (job 111366599436) | 37178686852 | 37178686843 |
| #691 | e0afe678 | 37178686661 (job 111368332024; attempt 3 job 111369562445, see below) | 37178686722 | 37178686665 |

#691 build-and-test is the composition proof: it runs the full suite on the whole D1-D5 tree. Result: 722 suites passed, 23 skipped,
12,521 tests passed, including dunning-v2-foundation-fixes, dunning-d3-fix-round, dunning-d4-fix-round,
dunning-r3-money-truth-e2e and dunning-v2-e2e-lifecycle.

Duplicate-run artefact on #691: the cancelled duplicate run 37178686574 left cancelled check runs whose start times tie with or
follow the passing ones, so `gh pr checks 691` first showed community-live-tests and then build-and-test as failing. Reruns:
- community-live-tests once (attempt 2, job 111368331199): green;
- build-and-test once (attempt 3, job 111369562445): green (completed 05:33:49Z); `gh pr checks 691` now shows every check green. The #691 comment was edited once to record this.
Each job was green in its first attempt as well, so these were not flake reruns.
Lesson for the next restack: when one push moves several stacked heads, cancel the LATER duplicate only if it has not started.
Otherwise let both finish (or push the heads one at a time) rather than cancel a started one.

## Comments
| PR | Round | Comment | PR body |
|---|---|---|---|
| #688 | FIX ROUND 2 (restack, merge-only) + READY FOR AUDIT | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/688#issuecomment-5976851597 | head line + Fix rounds row 2 |
| #689 | FIX ROUND 2 (restack, merge-only) + READY FOR AUDIT | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-5976887001 | tier header (builder, parent owner 117) + row 2 |
| #690 | FIX ROUND 2 (restack, merge-only) + READY FOR AUDIT | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-5976853953 | tier header + row 2 |
| #691 | FIX ROUND 3 (restack, merge-only) + READY FOR AUDIT | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691#issuecomment-5976887162 | tier header + row 3 (row for 0f24a8fa relabelled 2 to match its posted comment) |
| #687 | not moved; no comment (FIX ROUND 1 + READY already posted at f8e47bf4) | 5976568403 | unchanged |

## For the operator
1. Sol B-687-2 (migration 20270215000000 sorts before the applied tip 20270301000000) is disposed by ruling OR-113-4 with a
   pinning test, not by a rename. Recommended default: keep the ruling; the lenses state their disposition at the new heads.
2. Builder-noted items from B-D34-116 (not lens findings; outside a merge-only round, so not changed here):
   (a) #688 v1 `DunningService.recordResolution` has no tx and no dispute guard (millisecond window after the locked check);
   (b) #688 `resolvePurchaseFromCharge` swallows errors, so a transient failure acks `purchase_unresolved`;
   (c) #688 sweep skips locked rows, so a lost won-dispute effect is not repaired by the sweep (lower risk now that effects are
       redelivered); (d) #687 `src/email/templates/dunning-v2-client.hbs:9` still says the amount owed "is paid with it and your
       access stays on", the same untrue promise fixed on the card page in #690.
   Recommended default: the next dunning fix round (D1/D2 owner) takes (a), (b) and (d) with failing-before tests if a lens
   raises them, or proactively if the operator says so; (c) stays a C.
3. No lens verdict exists at any FIX ROUND 1 head. The 116 verdicts are all REQUEST CHANGES at pre-fix heads, so both lenses
   owe a full fix-round audit on all five pieces at the new heads (restack delta is D1 f8e47bf4 only; see tree checks above).

## Pre-push checklist (merge-only)
(a) no new log text (the only carried change makes the coach emitter log a closed code); (b)/(c) no new await-then-write;
(d) no copy change; (e) no new finding to prove; (f) sizes unchanged, all under 3,000.

## HANDOFF
State at 2026-10-04 05:36 UTC. All five pieces have READY FOR AUDIT at their current heads, and every applicable check is green.
| PR | Piece | Exact head | Round at head | READY | Checks | Next step |
|---|---|---|---|---|---|---|
| #687 | D1 | f8e47bf40fe81064d679fc2831cedf3b1cd90b2c | FIX ROUND 1 (B-D12-116; posted by operator 117) | yes (5976568403) | 11/11 green; BEHIND main b644198b, no conflict | Opus + Sol fix-round audit at this head; operator update-branch at landing |
| #688 | D2 | b17f514ccd8da195d18588ca4b7ca407a789f20e | FIX ROUND 2 (restack, merge-only) | yes (5976851597) | 7/7 applicable green | both lenses: FIX ROUND 1 audit + merge-only delta at this head |
| #689 | D3 | bb992fedf0095446f916f3261742bd262c3d94da | FIX ROUND 2 (restack, merge-only) | yes (5976887001) | 7/7 applicable green | same |
| #690 | D4 | 06307883100ec142aa2818fc30ee276cab26c1ec | FIX ROUND 2 (restack, merge-only) | yes (5976853953) | 7/7 applicable green | same |
| #691 | D5 | e0afe6780e5954b20e88cfaefd63f12cd31d218d | FIX ROUND 3 (restack, merge-only) | yes (5976887162) | 7/7 applicable green; full-suite composition 722 suites green | both lenses: merge-only delta at this head (no D5 verdict exists yet) |

- Restack delta on D2-D5 is D1 `7d7e7db4..f8e47bf4` only (patch-id e0690bf6), and every piece's own diff patch-id is unchanged.
  A lens can verify this with `git diff <old head> <new head>` and `git diff <new base> <new head> | git patch-id --stable`
  (values in ops/aud-117/B-DUN-117/patchid.txt).
- Unanswered B findings: none. Every 116-lens B has a closing commit, a test and a failing-before run (table above).
  Sol B-687-2 is closed by ruling OR-113-4 (operator item 1).
- Lock: `ops/lanes117/locks/dunning` released 05:01:37Z. Worktree /home/user/workspace/wt/B-DUN-117-1 removed.
  No ci/* or audit/* branches were created.
- Notes and drafts: ops/aud-117/B-DUN-117/ (comments_<n>.md copies, drafts/<n>.md as posted, patchid.txt, new_heads.txt,
  checks.py, body_edit.py).
- Landing: rule 11, land as one D1 -> D5 after APPROVE from both lenses on all five; deploy only after D5, with mobile #322 /
  #352-#354. FEATURE_DUNNING_V2 stays off. If any piece moves again, restack bottom-up under the `dunning` lock. Push heads
  one at a time, or let the duplicate CI runs finish (see the CI section).
- Operator decisions (defaults in "For the operator"):
  1. Keep OR-113-4 for migration 20270215000000. Default: keep.
  2. Builder-noted D1/D2 items (a)-(d) for the next dunning fix round. Default: fix (a), (b) and (d) with failing-before tests
     in the next D1/D2 round if a lens raises them.
