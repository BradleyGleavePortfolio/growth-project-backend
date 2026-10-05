# AUD-SOL-L3-120 — mobile lockout FIX ROUND 2

## Status
Independent T4 Sol lens, agent 120. Started 2026-10-05 11:22:41 PDT (date).
Read common 120/119/118/116/117, AGENT_RULES, model routing, standing orders,
merge guide, audit rules, assigned JOBS120 entry, B-LOCK2-120, both 119 lens reports
and DECISION_LOG 10-05 owner rulings.

## Exact candidates
- #352 c89f719cd8f5863c4150af1da5b96e273df319d6; base main cc4ceeed; 2,586 lines.
- #353 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85; base #352; 2,723 lines.
- #354 68c7f080c1e7e7708e7c3b213ae9278b57ba3649; base #353; 1,119 lines.
All created 10-03, grandfathered under the 3,000 cap. Current GitHub API snapshots
and comments preserved in ops/aud-120/AUD-SOL-L3-120/.

## Audit plan
Explicitly dispose prior Sol B-352-2/3 and B-353-2/3, inspect every fix-round
delta and inherited boundary, replay prior probes via unique CI lanes only.
Operator D1 supersedes the old “does not settle” string assertion; update only
that assertion, preserving paid-amount and no-global-restoration checks.
#354 receives merge-only test-blob/tree applicability check and targeted CI.
No candidate edits or heavy local commands.

## Follow-ups (C)
Prior frozen Sol Cs retained pending line mapping: #352 reference conventions
and Retry-After; #353 pending-bank restart continuity, composition with #334,
outside-diff first-person copy. Other-lens Cs remain in B-LOCK2-120.

## Evidence checkpoint
- L1 replay + new presentation-boundary probe: 45 pass / 2 fail;
  original B-352-3 initStripe probes pass, but the shared sheet is still unsafe
  after presentation starts. A's iOS completion clears the singleton after B
  initializes; B errors. Superseded-but-mounted A also confirms its old setup.
  [CI proof](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355830979).
- L2 replay: all 114 tests pass, including original Sol lifecycle/confirmation
  probes and both Opus dispute suites.
  [L2 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355825712).
- L3 native suite: 41/41 pass.
  [L3 CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37355800424).
- Owner 10-05 inquiry ruling has a remaining copy edge: D2c returns the same
  dispute-paused envelope for inquiries, but L1/L2 assert the bank reversed money.
  Stripe explicitly says inquiries withdraw no funds unless elevated to a dispute.
  [Stripe testing contract](https://docs.stripe.com/testing-use-cases?locale).
  Additional narrow inquiry probes prepared; no candidate source changes.
- Merge-tree proofs: 40706529 tree dfb53858 = ac244d22 + cc4ceeed;
  b587e20f tree b6d17a84 = 05d84f27 + c89f719c;
  68c7f080 tree 80b91206 = f084cc0f + 9d47045b. All clean.
  L3's only own blob is nativeCardUpdate.test.tsx at
  47b2207a9b8fa3735e96d73571597065a0ce3ad0, identical to Sol-approved #322.
  Evidence will be preserved in tree-proof.txt.

## HANDOFF
In progress; no verdict posted yet. Three first lanes complete. Native ownership
B-352-3 remains narrowed beyond the repaired initStripe counterexample.
Additional inquiry-copy proof next, then exact-head comments and cleanup.
No production actions or spending.
