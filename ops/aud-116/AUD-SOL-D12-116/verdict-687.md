AUDIT GPT-6.1 Sol — growth-project-backend#687 @ c2a901a8f2552a166edc81b97454c9b7cd55df1c — VERDICT: REQUEST CHANGES
A/B/C = 0/2/1

T4 independent full-piece audit: schema/migration/down path, effective-access and money helpers, Stripe adapter, email additions, flag/Jest configuration, all fixtures/fakes, importing call sites and split boundaries reviewed; the operator's 1,840-line KEEP assessment applies. [D1 scope and assessment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5975773063)

### Prior findings and evidence applicability

The original Sol B-628-11 remained open at `33e0696a`; its settlement classifier belongs to D3, so this verdict does not close it or block D1 on another piece's implementation. D1 adds the operation-replay header required by FIX ROUND 8, and both header-present/header-absent real-adapter controls pass; end-to-end closure still requires the D3/D5 review. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972111414) [FIX ROUND 8](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418) [Adapter controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171405978)

No original Sol APPROVE is reused: this is a full audit, not copied approval; a path-scoped git diff confirms D1's 22 files are byte-identical to the same files at original split head `dc47e0ef`, which proves provenance only. [Original split/fix head](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/628#issuecomment-5972389418)

### B-687-1 — the effective-access existence check truncates before excluding locked alternatives

`src/checkout/dunning-v2/dunning-effective-access.ts:34–48` takes 20 otherwise eligible purchases, then discards those whose own dunning cycle is locked; no continuation or database-side unlocked-cycle predicate establishes that no other live entitlement exists. [Effective-access helper](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c2a901a8f2552a166edc81b97454c9b7cd55df1c/src/checkout/dunning-v2/dunning-effective-access.ts)

**Executed schema-valid counterexample:** one debt lock, twenty non-waiving alternatives, then an unexpired entitled $0 grant for the same client yields `locked=true, waived=false`; moving that grant within the first twenty yields the correct waiver. The acceptance assertion fails while the cardinality control and both adapter controls pass: **1 failed / 3 passed**. This is a synthetic cardinality boundary, not a production-row claim. [Exact-head D1 probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171405978)

**Minimal fix rule:** push the entire “live, unexpired, not this purchase, not itself locked” predicate into a bounded database existence query, or paginate completely; never interpret a truncated prefiltered page as proof of absence. Preserve client scoping and free/code-grant waiver, and add the 20/21 boundary regression.

### B-687-2 — new migration is ordered behind existing main migrations

`prisma/migrations/20270215000000_dunning_billing_actions/migration.sql:1` is a new addition dated before main's already-existing `20270301000000_notification_zone_provenance_reminder_generation`; a fresh-database apply success is not the standing order's monotonic rollout prerequisite. [New dunning migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c2a901a8f2552a166edc81b97454c9b7cd55df1c/prisma/migrations/20270215000000_dunning_billing_actions/migration.sql) [Existing main migration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/d23fa31773f2e7f14781d243db35067d949f421a/prisma/migrations/20270301000000_notification_zone_provenance_reminder_generation/migration.sql) [Merge dependency guide, rule 7](https://github.com/BradleyGleavePortfolio/tgp-agent-context/blob/main/MERGE_DEPENDENCY_GUIDE.md)

**Minimal fix rule:** obtain/coordinate an unused migration timestamp newer than the wave floor `20270316000000` and the then-current applied tip; rename this new directory and its down-file header/references without modifying a shipped migration. Re-run forward/schema-parity/reversibility checks and retain the additive SQL and server-only RLS. The rollback intentionally drops new journals; its warning must not be presented as restoration of lost data.

### C-687-1 — small product-copy correction

`src/email/templates/dunning-v2-client.hbs:13` says “our team”, contrary to the binding narrator-copy rule; replace it with neutral wording such as “a support specialist”, preserving a real support path. [Client email template](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/c2a901a8f2552a166edc81b97454c9b7cd55df1c/src/email/templates/dunning-v2-client.hbs)

### Gates, boundaries and limits

All **11 required checks pass** at the reviewed head; the deliberately red audit-only lane proves the reported boundary and does not change candidate source. D1's added billing services/routes remain unwired here, the flag stays off, and the operator's **land-as-one / deploy-after-D5** rule remains mandatory; this verdict is not merge or deploy authorization. [Candidate CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37152165227/job/111288101271) [Audit-only CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171405978) [Operator landing rule](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/687#issuecomment-5975773063)

The audit lane executed only `test/aud-sol-d12-116-d1.spec.ts`; two supplemental path arguments named nonexistent files and therefore matched no additional suites. No supplemental-suite execution is claimed. [Executed suite summary](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171405978)
