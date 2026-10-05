# AUD-OPUS-661D-120 — Claude Opus 5.5 lens, backend #661 + #702 (secrets stack, operator agent 120)

Status: DONE (09:29-10:01 PDT 10-05). #661 bc399edd REQUEST CHANGES 0/1/7; #702 9ddda117 APPROVE 0/0/1.

- Job: conflict-resolution main refresh delta (JOBS120.md entry AUD-OPUS-661D-120 / AUD-SOL-661D-120).
- Heads to audit: #661 bc399edd5911c9c1e83e4bb1051fde05bfeda64d, #702 9ddda117d89f72c8d4a7a5b58a2c7ba6173053a2.
- Claims: ops/lanes120/claims/backend-661-bc399edd-opus, backend-702-9ddda117-opus.
- Notes: ops/aud-120/AUD-OPUS-661D-120/.
- Last Opus APPROVE: #661 f80f0088 (5982407688), #702 20d2eb4f (5982408645) (AUD-OPUS-661-118).

## Progress
- 09:29 read _COMMON_120/119/118/116, AGENT_RULES, JOBS120 entry, AUD-OPUS-661-118 report and verdicts.

- by 09:38 (date) conflict hunks of 010f9b57 read (remerge diff saved: ops/aud-120/AUD-OPUS-661D-120/remerge-010f9b57.diff). #661's net patch vs main is identical to f80f0088's except (a) endSubscriptionPurchase erases unconditionally (recurring's unpaid-only erase removed), (b) `purchase &&` guard on the recurring PI-succeeded early return. #702 files blob-identical to 20d2eb4f.
- by 09:38 (date) candidate B: native first grant (invoice.paid / customer.subscription.updated) never clears PaymentSheet credentials on the composed tree (C-661-3 obligation, #661 lands second).
- INDEPENDENCE NOTE (honest record): shortly before 09:38 (date) an `rg 'C-661-3|CLEARED_PAYMENT_SECRETS|first grant' reports/*120*.md` over ops/reports unintentionally printed ONE line (line 18) of the Sol lens's report for this round (AUD-SOL-661D-120.md), which names a Sol finding B-661-14 on the same grant-path credential issue. This lens had already identified the issue from the code before that line printed (entry above). No other Sol content was read; later greps exclude AUD-SOL-*. Disclosed in the verdict.
- 09:46 (date) exposure check: no route returns ClientPurchase credentials on the composed tree (planView / alreadyActive / alreadyIncluded are allow-lists; data-export has no purchases). The B is retention at rest, not a response leak.
- 09:46 head CI read: #661 bc399edd 18 success / 1 skipped (deploy-readiness-gate) / 0 failed; build-and-test 773 suites / 13,255 tests; mwb-3 main group 8 suites / 71 tests. #702 9ddda117 10 success / 1 skipped; build-and-test 774 / 13,264; mwb-3 8 / 74 (adds round-7 cases 9/10/12). Job logs saved in notes dir.
- 09:48 (date) lane run 1 started: probe commit 91111131 on 9ddda117 (new test/aud-opus-661d-120-hunks.spec.ts + 118 Opus live probe + dead Sol R6 probe verbatim + lane-only PG setup ao120 + .ci-lane-tsc), branch audit/AUD-OPUS-661D-120/1-head-probe, run 37343688493.
- 09:49 (date) lane run 2 (control) started: hunks spec only on main ee55f814 (probe commit 1e66584e), branch audit/AUD-OPUS-661D-120/2-control-main-ee55f814, run 37343795035.
- 09:51 (date) run 1 result: 13 suites, 3 failed / 244 passed, tsc green, PostgreSQL 16.15. The only failures are G1/G2/G3 (B-661-15: credentials kept after native first grant). H1a-e, H2a-c, H3a-d, G4 pass. 118 Opus live probe, dead Sol R6 probe, checkout-settlement.live / round5 / hosted-activation-once, checkout.service, checkout-webhook-handler, b-recur3-117, b-recur-subscription-webhooks, b-recur-fix-round-1, b-recur-subscription-checkout, b-secrets-3 all PASS.
- 09:51 (date) run 2 (control main ee55f814): 8 failed / 8 passed. H1a/b/d/e fail (main keeps credentials on paid/ended plans: the resolution changed this, per #661's rule), H3d fails (no #661 prefetch on main), G1-G3 fail (same gap on main). H1c, H2a-c, H3a-c, G4 pass.
- 09:53 (date) run 3 (fix sketch, lens validation only): 91111131 + 2 lines `...(entitled ? CLEARED_PAYMENT_SECRETS : {})` at handler :1653 / :2290 (commit ac7c8b9d; diff saved probe/fix-sketch-B-661-15.diff), branch audit/AUD-OPUS-661D-120/3-fix-sketch, run 37344323196: 36 suites / 539 tests pass, tsc green (all 33 specs touching the handler/subscription checkout + checkout.service + b-secrets-3 + b-recur7a-119-r1).
- 09:57 and 10:00 (date) heads re-read unchanged (#661 bc399edd, #702 9ddda117, main ee55f814), both PRs clean.
- 10:00 (date) posted verdicts:
  - #661 @ bc399edd REQUEST CHANGES 0/1/7: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5999168270
  - #702 @ 9ddda117 APPROVE 0/0/1: https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/702#issuecomment-5999168870
  - Bodies: ops/aud-120/AUD-OPUS-661D-120/verdict-661.md, verdict-702.md.
- 10:01 (date) cleanup: worktrees AUD-OPUS-661D-120-1 and -ctl-ee55f814 removed; branches audit/AUD-OPUS-661D-120/{1-head-probe,2-control-main-ee55f814,3-fix-sketch} deleted (0 remain). Probe commits 91111131 (head probe), 1e66584e (control), ac7c8b9d (fix sketch) are unreferenced; probe files saved under ops/aud-120/AUD-OPUS-661D-120/probe/.

## Findings
- **B-661-15** (`src/checkout/checkout-webhook-handler.service.ts:1643-1655` subscription.updated grant write; `:2285-2296` invoice.paid grant write): no CLEARED_PAYMENT_SECRETS on the native first grant; active/trialing plans keep the first-invoice `pi_..._secret_...` or trial `seti_..._secret_...` and `ek_` at rest until the plan ends. Violates the body's C-661-3 promotion trigger (second lander keeps CLEARED "on the stack's activation path (invoice.paid -> active / trialing)"); #661 is second. Not A: no route returns them. Probe G1-G3 fail at head (run 37343688493), G4 control passes. Fix rule: `...(entitled ? CLEARED_PAYMENT_SECRETS : {})` in both writes, never on an unentitled $0 trial invoice; tests G1-G4 (+ H1a/H1d). Fix sketch green (run 37344323196). Likely the same defect as the other lens's B-661-14 (see the independence note).

## Follow-ups (C)
- C-661-15 test gap on conflict hunk (a): nothing pins the unconditional erase on paid/ended native plans (`checkout-webhook-handler.service.ts:1808`); control run 37343795035 shows the behaviour changed vs main. Rule: add H1a/H1d with the B-661-15 tests.
- C-661-16 `checkout-webhook-handler.service.ts:1096-1124` prefetchFailedPaymentIntentStatus reads Stripe for settled native rows; result unused (recurring return :2072-2086 precedes the fence). Rule: return {} when billing_type recurring && stripe_subscription_id (C-661-3 item 2).
- C-661-17 `checkout-webhook-handler.service.ts:1885-1888` settlement bump also bumps active native rows -> one redelivery of a concurrent invoice.payment_failed (writeVersion :2418). Rule: add `billing_type: { notIn: ['recurring'] }, stripe_subscription_id: null`.
- C-661-18 `src/checkout/checkout.service.ts:544` recurring guard precedes the `pi-` replay (:567-577): a finished one-time key whose package became recurring (billing_type is editable, packages.service.ts:410) answers RECURRING_REQUIRES_SUBSCRIPTION instead of its 409 replay code. Rule: classify a finished `pi-` row before the guard; keep the guard ahead of any PaymentIntent create.
- Carried: C-661-2 (backfill; scope now includes native subscription rows already holding credentials), C-661-10, C-661-13 (#661 body stale: round 7, 3,121, no restack), C-661-14, C-702-1 (#702 body stale: one file / 235 lines).

## Operator decisions (recommended default first)
- D1 where the B-661-15 tests go: default = the 2 source lines in #661, tests G1-G4 + H1a/H1d in #702 (tests-only, as in round 7; keeps #661 at about 2,851 / 3,000). Alternative: all in #661 (about 2,920 / 3,000).
- D2 C-661-2 backfill scope: default = include native subscription rows (entitled or ended) that already hold credentials in the deploy-window backfill; operator item, no production action by a lens.
- D3 #702 verdict: APPROVE of its own content at 9ddda117 with a landing note; the stack stays blocked by B-661-15, and the next push or restack voids it.

## HANDOFF
- Verdicts posted at exact heads: #661 bc399edd REQUEST CHANGES 0/1/7 (5999168270); #702 9ddda117 APPROVE 0/0/1 (5999168870).
- Next for the builder: B-661-15 fix rule above (2 lines + tests), then restack #702; both heads need a new dual lens round. Reuse: hunk probe file ops/aud-120/AUD-OPUS-661D-120/probe/aud-opus-661d-120-hunks.spec.ts (G1-G3 should flip to pass; G4 must stay).
- CI at heads green (#661 18/1 skipped/0 failed; #702 10/1 skipped/0 failed). Lane runs: 37343688493 (head probe, 3 expected failures), 37343795035 (main control), 37344323196 (fix sketch, green).
- No worktrees or audit branches remain. Claims ops/lanes120/claims/backend-661-bc399edd-opus and backend-702-9ddda117-opus can be released.
