# B-DUNFIX-122 — dunning fix round (agent 122)

Started 15:44 PDT 2026-10-05. Time box 18:15 PDT. Builder: Claude Opus 5.5.
Read: _COMMON_122 (all), JOBS122 entry B-DUNFIX-122, SoT A1, A2 overrides 1-11, A5 rules 11-12.

## Trigger and rulings
- Verdicts at the B-DUNR3 READY heads: Opus + Sol APPROVE #687 #688 #704 #705 #724 #689 #691 and #725; both REQUEST CHANGES #690
  c15f157c (Opus B-690-8 6005165998, Sol B-690-S1 6005217116: no HTTP route for the coach dispute restart).
- Operator 16:15: fix B-690-8 in #690; fix C-689-6 / C-689-S1 (two copy strings) in #689. Operator 16:2x: SetupIntent must omit an
  empty on_behalf_of (one line + one assertion); keep D4's lock rule, keep decline code in last_error, D4 skipping v1 resolution for
  a dispute-paused plan = follow-up C.
- Lock `dunning` taken 16:18:29 PDT (released by B-DUNR3-122).

## Work
- #689 68796f675df9c67c0618145efff58caf32a26b04 (from 0fbd18ca; size 2,956):
  46fe43f7 test + 84643f7f fix: card / cancel replies say "payment dispute or inquiry", never a bank reversal (2 fail -> 15/15).
  18f3e106 test + 68796f67 fix: createSetupIntent omits on_behalf_of when '' (1 fail -> 4/4).
- #690 5d41f7678438c11865762a7925ad53520948fe75 (from c15f157c; size 2,969):
  79601701 clean merge of #689 (tree == merge-tree). d46ea900 test + 5d41f767 fix: DunningRestartController
  POST /v1/coach/purchases/:id/dispute-restart (JwtAuthGuard + CoachOrOwnerGuard, @Roles coach/owner) -> restartAfterDisputePause;
  coded 404/409/503. Module registers it. 4 fail -> 4/4. Route-table allow-list spec 36/36 locally.
- #691 3dc0e9472954bdd8381d3394aeb79ab0d5712514 (from 17cfa566; size 2,914): clean merge of #690 (tree == merge-tree).
- Pushes: #689 16:24:32, #690 16:25:44, #691 16:26:57 PDT. Spacing missed the 2-minute rule (72 s, 71 s): my error, no effect on
  content; noted for the operator.
- Lane ci/B-DUNFIX-122-1 run 37388562724 at #691 3dc0e947: tsc + 23 dunning specs + b-recur-subscription-wire, roles-enforced,
  openapi-spec.
- Local evidence: ops/aud-122/B-DUNFIX-122/{689,690,setupintent}-{failing-before,after-fix}.log. Comment drafts c689/c690/c691.md.

## Comments (16:33 PDT)
- #689 FIX ROUND 4: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/689#issuecomment-6005485883
- #690 FIX ROUND 3: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690#issuecomment-6005486208
- #691 RESTACK: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691#issuecomment-6005486528
- Notify: ops/lanes122/notify/dunning-fix.txt. Lane 37388562724 GREEN (tsc; 26 suites / 571 tests); branch ci/B-DUNFIX-122-1 deleted.
- PR CI: all checks green on all three heads at 16:38 PDT.

## Edge items for the operator
- none new.
- Note: Opus's fix rule suggested 409 for billing_unavailable / billing_resume_failed; built as 503 BILLING_UNAVAILABLE (temporary
  outage). Default keep.

## Re-review (DUN2, 17:0x PDT)
- #689 68796f67: Sol APPROVE 0/0/4 (6006102425), Opus APPROVE 0/0/1 (6006108561; C-689-6 closed).
- #690 5d41f767: Sol APPROVE 0/0/6 (6006102827), Opus APPROVE 0/0/1 (6006109041; C-690-9 edge: after a flag rollback a still-paused
  plan answers flag_off with "not paused" copy, deferred to 10k clients).
- #691 3dc0e947: Sol APPROVE 0/0/0 (6006103220), Opus APPROVE 0/0/0 (6006109468).
- PR CI: all checks green on all three heads.

## HANDOFF
DONE 17:10 PDT (operator WRAP UP 17:1x). Dunning train is dual-APPROVE at every exact head with green CI: #687 c140575c, #688 610c5254,
#704 524c4025, #705 346b7757, #724 410fb1b3, #689 68796f675df9c67c0618145efff58caf32a26b04,
#690 5d41f7678438c11865762a7925ad53520948fe75, #691 3dc0e9472954bdd8381d3394aeb79ab0d5712514; #725 1dbc59b6 (base main) separate.
Operator lands the train (A5 rule 11). Lock `dunning` released 17:09. Worktrees wt/B-DUNFIX-122-{689,690,691} removed, local branches
deleted, lane branch ci/B-DUNFIX-122-1 deleted. Nothing left open for this job.
Operator notes: (1) pushes were 72 s and 71 s apart, not 2 minutes (my error; content unaffected). (2) 503 vs 409 for
billing_unavailable kept (default keep). (3) Follow-up Cs: C-690-9 (edge), D4 skipping v1 resolution for a dispute-paused plan
(operator ruling: follow-up C).
