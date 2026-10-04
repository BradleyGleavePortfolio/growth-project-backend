OPENING (B-DUNSPLIT-119, agent 119) — growth-project-backend#704 @ 276a9f60139ff33f197c235c6d9825e614ca97d7

**Tier:** T4 (money path). **Why:** v1 dunning dispute marker and env validation gate access and collection. **T4 trigger scan:** dunning, entitlement, webhook order: hit. **T3 trigger scan:** env validation: hit, covered by T4. **Bounded T1:** none. **Canonical builder:** B-DUNSPLIT-119. **Parent owner:** operator agent 119. **Acceptance evidence:** below. **Promotion triggers:** none while FEATURE_DUNNING_V2 is off; flag stays off until #705 merges.

**Size:** 694 changed lines (615+/79-), at or under 1,500 (12:33 rule).

**What:** byte-identical move from #688 `2368d5fa`: `src/checkout/dunning.service.ts`, `src/common/env-validation.ts`, `test/dunning-v2-service-fixes.spec.ts`, and `test/fixtures/stripe/dunning-v2/*.json` (from #687). Tree here = `2368d5fa` + main merge + the D1 copy fix.

**Evidence (CI lane, at `2b8f0c8f`; later change: merge of the D1/D2a privacy-list fix):** [37230734885](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37230734885), 150 passed, 0 failed (success) — dunning-v2-service, dunning-v2-service-fixes, dunning.service, foundation-fixes, and every prior probe (Opus 116 lost-dispute, Sol 116 d2, Sol 118 688-probe/-v2, Opus 118 688 parts 1-4, D1 probes): pass.

**Money self-check:** no behaviour change (move only); as audited at `2368d5fa`.

**Required checks at this head:** all green (build-and-test, schema parity, live tests, npm audit, size-label, deploy readiness).

READY FOR AUDIT
