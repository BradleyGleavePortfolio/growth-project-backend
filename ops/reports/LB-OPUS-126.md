# LB-OPUS-126 — backend lens (Claude Opus 5.5), agent 126 fleet
Started 18:00 PDT 10-06 (from `TZ=America/Los_Angeles date`). The report was last updated 19:34 PDT. The queue is empty and the lane has stopped.

## Verdicts posted (exact heads)
| PR | Head | Verdict | B | C | Comment |
|---|---|---|---|---|---|
| backend#808 AIB-4 | 9487faa216ac9fd79cffc704a9e1ac4ce3c09b1d | APPROVE | 0 | 4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/808#issuecomment-6028650380 |
| backend#810 B-CRON | 9ee51c0b16fa139b32532ac16450896188c8967f | APPROVE | 0 | 1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/810#issuecomment-6028883162 |
| backend#812 FU-FIRSTRUN | 91ab6aa7aecedfe69a66ce7d50dba73883fac1ee | APPROVE | 0 | 0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/812#issuecomment-6028936692 |
| backend#809 AIB-2 (T4) | 8b82ead8d3d4598ba6f416e69a13f63c1fc55b6e | APPROVE | 0 | 5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/809#issuecomment-6029042749 |
| backend#816 B-GUEST (T4 money) | 16d1602810f45d61516479febe4209105712a8bd | APPROVE | 0 | 2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/816#issuecomment-6029057897 |
| backend#815 AIB-2b subset approve (T4) | b83e035776624d4b76d3e94c9b3a43433c3b9101 | APPROVE | 0 | 2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/815#issuecomment-6029110268 |
| backend#813 AIB-3 (T4), round 1 | c3eae417dcb5d8c429463ba18ec3a19e89194c8d | APPROVE (MISSED B-813-1) | 0 | 4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/813#issuecomment-6029110696 |
| backend#818 FU-WORKLOG2 | 2e7d8de69cef6d13bedbd8e4cedc2dc4f7151802 | APPROVE | 0 | 0 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/818#issuecomment-6029248830 |
| backend#817 B-AIBSUB (T4 tenancy) | 6e8616f5057e18bf7f7e01c7e9f43bbc9c9cf08b | APPROVE | 0 | 2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/817#issuecomment-6029282538 |
| backend#813 AIB-3, round 2 re-review | dee67d534ac927c2c87ab0960d50185ed9cb3b5f | APPROVE | 0 | 4 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/813#issuecomment-6029350520 |
| backend#821 B-CONNECT (T4 money) | b9ada9f888107b6977387d3b56cdbc7dda19259f | APPROVE | 0 | 2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/821#issuecomment-6029427103 |
| backend#814 FU-WORKLOG push, round 3 (B-814-1 fixed, gate spec) | 7275acd4a90f4326d0dcb107904a62d2447f2e5d | APPROVE | 0 | 1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/814#issuecomment-6029570591 |
| backend#819 B-EMAILFROM (operator-named, CI green) | 1fcd9330c76e5629db4f06cd49b49d9f397a9c53 | APPROVE | 0 | 2 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/819#issuecomment-6029677594 |
| backend#822 BILLING_ENFORCEMENT unset (operator, owner-approved 19:23) | b4f48a76fb0e65ab26eab7c9d60a0b21e436812d | APPROVE | 0 | 1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/822#issuecomment-6029585872 |

Verdict files are at ops/aud-126/LB-OPUS-126/backend-<n>.md, and notify lines are in ops/lanes126/notify/LB-OPUS-126.txt.

## Misses (the other Opus lens caught them; I did not)
- B-813-1 at c3eae417: any mention of an exercise name in focus or notes ("avoid back squat") exempted it from the injury filter. It was fixed at dee67d53, and I verified the fix there.
- B-814-1 at e27aa237: `workout_assigned` fell through to the `digest` prefs (default false), so the new push and the inbox row were both dropped. I noted the gate but did not check the kind-to-preference mapping. It was fixed at b6e40ad8 (operator) and pinned by a spec at 7275acd4.
- The same mention-based exemption as B-813-1 is in b#809 (`named = instruction.includes(ex.name)`). It is lower risk there (a red warning on each change card, and the coach approves each change), so I log it as C-809-6. Follow-up: reuse `coachAskedToKeep` in AIB-3b.

## B list
none (posted). U list: none.

## C one-liners
- C-808-1: the status read can create a default budget row, although the PR body says it "never writes".
- C-808-2: the history route answers 403 on a tenant-shared program master.
- C-808-3: the gates note gives the wrong secrets-list run time.
- C-808-4: remaining_pct is 0 with state on when a pool total is 0 (edge).
- C-810-1: the static forRoot guard scans src only.
- C-811-1: a v5 grant with no copy_sha256 is accepted (main behaviour). Require it in the R11-F1 flip PR.
- C-809-1: the draft rationale stores the raw model reply (first 1,000 characters).
- C-809-2: `add_exercise` is not blocked under the screening flag.
- C-809-3: the 429 uses the generic throttler copy.
- C-809-4: the "paused for maintenance" copy is also shown while the switch is simply unflipped.
- C-809-5: weekly caps are not enforced, and a plan with no head revision answers 409.
- C-809-6: mention-based exemption (see Misses).
- C-815-1: a subset with an unticked add plus a kept update on that row fails the dry run.
- C-815-2: the draft payload is overwritten with the applied subset.
- C-813-1: substitutions ignore equipment.
- C-813-2: a day can come back with zero exercises.
- C-813-3: the generator has no server-side medical-claim strip.
- C-813-4: the style cache is never evicted.
- C-816: refunded terminal row plus a very late webhook; the losing transaction commits its find-or-create writes. Both edge.
- C-817-1: a lookup error gives 500, so the entry stays visible.
- C-817-2: an `@Optional` scope could be silently skipped by a future wiring.
- C-821-1: the cooldown Map is per process and never evicted.
- C-821-2: a slow Stripe re-read adds up to about 10 s, at most once a minute per account.

## Operator decisions (recommended defaults)
1. FLIP of FEATURE_MWB_AI_LIVE_CREATE. Recommended: add b#815 (subset approve) and b#817 (sub-coach 404) to the manifest gate, which today names only AIB-1a, AIB-2 and AIB-4. Without b#815, Apply applies every change even when the coach unticked some.
2. b#819 deploy order. Recommended: merge b#819, then the manifest PR pinning `EMAIL_FROM_ADDRESS` (github-secret = `The Growth Project <[redacted email]>`), then one deploy, then unset `RESEND_FROM_EMAIL`. Check the Fly log line `outbound sender domain=growthprojectapp.com`.
3. b#822 BILLING_ENFORCEMENT unset (owner approved 19:23). Every SubscriptionGuard tier and status denial becomes observe-only. Client package checkout, payouts and dunning do not read the flag. The custom-domain (white-label) direct Pro check at `custom-domain.service.ts:235-243` stays. Env Truth proves the variable is present, not that its value is `enforce`.

## HANDOFF
Not reviewed by me (nothing is left in my queue):
- backend#820 @ e6cf9316 (B-SHARE consent owner_access): HELD for owner wording approval. Not reviewed; it goes to the LX pair after the owner approves.
- Skipped by rule, because an Opus verdict already existed at the head: backend#811 @ e1d804b7 (LX-OPUS, merged) and backend#814 @ e27aa237 (LX-OPUS REQUEST CHANGES; I re-graded later heads).
- backend#819 was posted at 1fcd9330 as operator-named, because no builder READY existed at that head. If the builder pushes again, the LX pair re-grades the new head. CI history: red at 5c5e5957 and at e63a5bba, both caused by the PR and fixed by the builder.
- Mobile was out of lane scope. I read mobile m#439 @ 63076852 only, to confirm the 404 hide for b#817.
- No worktrees or probe checkouts were created by this lane. I used only the read-only wt/RO-backend and wt/RO-mobile, plus `git fetch` refs in the main clone. Nothing was pushed, merged or deployed.
