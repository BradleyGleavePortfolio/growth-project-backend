## Summary
<!-- One-paragraph description of what this PR does and why. -->

## Linked plan / brief
<!-- Required: link to the plan doc, ticket, or brief that authorizes this work. -->

## Test plan
<!-- How was this tested? What evidence is in the PR? -->

## Rollback plan
<!-- How do you undo this if it breaks prod? -->

## Audit pack pointer
<!-- Link to audit report when available -->

---

## R-rule self-check (every checkbox required; N/A allowed with one-line justification)

- [ ] **R23 LOC cap:** net additions ≤ 400. Actual: ___
- [ ] **R18 lane scope:** this PR touches only the lane it was briefed against
- [ ] **R100 prod-readiness:** `test:deploy-readiness` passes (or N/A pre-H4)
- [ ] **R75 banned cast tokens:** zero net new `@ts-ignore`, `as any`, `as unknown as`, `as never`, `.catch(()=>undefined|null|{})`, "Coming soon"
- [ ] **R74 test:src ratio:** ≥ 2.0 over diff (test lines added / src lines added). Actual: ___
- [ ] **R92 RLS impact:** this PR does not weaken row-level security
- [ ] **R98 PII statement:** this PR does ___ touch PII; if yes, classified + redacted + retention documented
- [ ] **R82 + R106 migration safety:** any new migrations are reversible AND backwards-compatible (have `.down.sql`)
- [ ] **R83 feature flag:** any risky new path is behind a flag with kill-switch + cleanup deadline
- [ ] **R86 SLO:** latency target documented for any new user-facing endpoint
- [ ] **R90 idempotency:** mutation endpoints accept an idempotency key
- [ ] **R3 commit identity:** every commit authored AND committed as `Bradley Gleave <bradley@bradleytgpcoaching.com>`, no AI/Co-Authored tokens
- [ ] **R6 push cadence:** pushed at scaffold, after each file, before any long command, before ready-for-audit
- [ ] **R14 audit cycle:** dual auditor (Lens A + Lens B), CLEAN on both before merge

## Dependencies
<!-- Other PRs this depends on, or that depend on this -->

## Notes for auditor
<!-- Anything Lens A or Lens B should focus on or be aware of -->
