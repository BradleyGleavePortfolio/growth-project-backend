# AUD-SOL-661CI-116 — independent T4 audits

Lens: GPT-6.1 Sol. Scope only backend #661 and #694.

## Final result

- #661 @ `a193d7e17b2d4daeb944891191824d08e280b437`: **REQUEST CHANGES, A/B/C = 0/1/0**; existing B-661-3 remains open for stale out-of-transaction provider evidence after an intervening successful retry. [Posted Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5976137883)
- #694 @ `14c84c75aba63236ef22ca3dea96f791dc75f247`: **REQUEST CHANGES, A/B/C = 0/1/1**; B-694-1 requires fail-closed effective project/options enforcement, and C-694-2 is optional numeric worker-limit hardening. [Posted Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976120709)
- Exact-head required checks were inspected and all 11 are green on both candidates; #694's two build-and-test attempts independently verify 714 passed suites, 12,313 passed tests and Jest times 137.8 / 235.069 seconds. [#661 CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172411659) [#694 attempt 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111348549769) [#694 attempt 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111349414644)
- Independent tests-only probes were committed in isolated worktrees; no candidate branch edits, production actions, merges or local heavy execution were performed.

## Independent evidence and scope

- #661: probe commit `0507cdec` adds only `test/aud-sol-661-r3-provider-snapshot.spec.ts` to the exact candidate; it delivers a delayed decline whose provider prefetch said `requires_payment_method`, lets another decline and then the same PI's successful retry commit, and finally enters the delayed decline's transaction with stale prefetch. The acceptance assertion requires paid/entitled access to survive. [CI-lane probe and seven-suite controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890)
- #694: probe commit `02086af1` adds only `test/ci/aud-sol-694-guard-mutations.spec.ts`; it executes the candidate guard unchanged in a VM with virtual workflow/TypeScript config inputs. Baseline and excluded-test-tree controls bracket two negative cases: Type-check `working-directory: scripts/secrets` and explicit `strictNullChecks:false` while `strict:true` remains. [CI-lane guard mutations](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)
- #661's automatic main merge was independently reproduced: both merge-tree and committed candidate tree are `ef3801c0dec0cb9450f3ba00ba78d19f21209afd`; the only own round-3 delta is webhook source plus its two test files, and prior replay/admin/redaction implementations are unchanged. [Exact candidate merge](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/a193d7e17b2d4daeb944891191824d08e280b437)
- The builder's failing-before #661 run is genuine: tests-only source equals `f4679fd8`, and the job records 13 failed / 50 passed; subsequent edits to those tests are formatting only. [Builder failing-before run](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37171991379)

## #661 completed — REQUEST CHANGES (0/1/0)

The complete own round-3 delta was read deeply: provider-status classification/prefetch, all decline write predicates, metadata fallback, fanout, the BillingService outer transaction/dedup path and the webhook controller's propagation of 503 errors. [Exact webhook implementation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a193d7e17b2d4daeb944891191824d08e280b437/src/checkout/checkout-webhook-handler.service.ts) [Transaction integration](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a193d7e17b2d4daeb944891191824d08e280b437/src/billing/billing.service.ts) [Controller propagation](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a193d7e17b2d4daeb944891191824d08e280b437/src/billing/stripe-webhook.controller.ts)

### Finding dispositions

| ID / lens | Disposition | Evidence |
|---|---|---|
| B-661-1 / Sol | Closed, unchanged replay status-first boundary | [Prior closure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5972103999), [current passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) |
| B-661-2 / Sol | Closed, unchanged poll/race-loser classification | [Prior closure](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5972103999), [current passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) |
| B-661-1 / Opus | Reported decline→success boundary still repaired; does not substitute for Opus's verdict | [Prior boundary verification](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5972103999), [current passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) |
| C-661-4 / Opus | Reported refunded/disputed copy boundary remains repaired | [Prior boundary verification](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5972103999), [current passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) |
| B-661-3 / Sol | **Open, partial repair only**: stale provider prefetch still undoes successful retry | [Independent failed acceptance assertion](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) |
| C-661-2 / Opus | Operator-owned historic backfill, no production action taken | [Existing nonblocking finding](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5964409597), [candidate contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661) |
| C-661-3 / Opus | Composition obligation now stated for split recurring stack; integration still required by whichever lands second | [Candidate promotion triggers](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661) |

### B-661-3 — stale provider snapshot is not bound to settlement version

File/lines: `src/checkout/checkout-webhook-handler.service.ts:556–573,1170–1183`; prefetch transports a status string only, and the later destructive update compares only the newly read purchase status, not any revision seen before provider lookup. [Exact-head source](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a193d7e17b2d4daeb944891191824d08e280b437/src/checkout/checkout-webhook-handler.service.ts)

Executed counterexample: provisionally paid/entitled hosted-async purchase; decline delivery A prefetches `requires_payment_method`; distinct delivery B commits real failure; same-PI successful retry commits paid/entitled/cleared credentials; A's delayed transaction reads that newly paid row and uses its old prefetch to revoke it. [Independent tests-only proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890)

The acceptance assertion fails with **Expected paid / Received payment_failed**, while **122 controls pass** over seven suites, including the fresh `succeeded` provider control, all round-3 tests and existing replay/admin/fanout controls. [Run 37173632890](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890)

Minimal fix: success for the same PI must dominate old failure evidence; bind a prefetched destructive result to the purchase/PI revision observed before the lookup and revalidate/CAS that witness in the transaction, redelivering on changes. Also ensure a successful PI event on a provisional already-paid row records distinguishable confirmed-settlement evidence, rather than leaving a stale failure predicate valid. An equivalent immutable successful-settlement witness is acceptable. Keep Stripe HTTP outside the DB transaction.

Verification: add prefetch→intervening failure/success→delayed old delivery and success-on-provisional-paid regressions; retain ordinary unpaid/async-real-failure controls and unknown-status rollback tests.

Ordinary pending/failed state guards, terminal-state no-rewrite behavior, Stripe lookup before the transaction, unavailable-status 503 propagation, and protection against adopting another open PaymentIntent are correctly repaired at their tested boundaries. [Round-3 source](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/a193d7e17b2d4daeb944891191824d08e280b437/src/checkout/checkout-webhook-handler.service.ts) [Current passing controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890)

Recommended C-661-2 default remains operator-approved backfill in the deploy window, not a unilateral lens action: `UPDATE "ClientPurchase" SET stripe_client_secret = NULL, stripe_ephemeral_key = NULL WHERE status NOT IN ('pending','payment_failed')`. [Existing recommendation](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5964409597)

Recommended C-661-3 default: whichever of #661 and #678–#680 lands second retains `CLEARED_PAYMENT_SECRETS` on activation and both subscription-deletion branches, with the recurring decline early return before the one-time failure fence. [Current composition contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661)

## #694 completed — REQUEST CHANGES (0/1/1)

Verdict at `14c84c75aba63236ef22ca3dea96f791dc75f247` was posted after re-reading the live head; the new guard's independent mutation run fails the two desired rejection assertions and passes 16 controls. [Sol audit comment](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976120709) [Negative proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)

### B-694-1 — replacement guard ignores effective project and strict-option overrides

`test/ci/jest-typecheck-gate.spec.ts:81–110` checks command text and parses a fixed repo-root config, but never checks the Type-check step's effective working directory or effective strict-family values. [Candidate guard](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/14c84c75aba63236ef22ca3dea96f791dc75f247/test/ci/jest-typecheck-gate.spec.ts)

Counterexamples: `working-directory:scripts/secrets` switches the unchanged `npx tsc --noEmit` to that narrow `strict:false` project; `strictNullChecks:false` with `strict:true` disables null-safety in the root project; all three actual guard assertions still pass in both cases. [Executed mutations, 2 failed / 16 passed](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)

Minimal fix: bind assertions to the effective step/job/workflow project root and approved effective strict options, and add the two mutations as failing-before/passing-after regressions.

### C-694-2 — optional numerical worker-limit drift

`test/ci/jest-typecheck-gate.spec.ts:59–61,143–149` treats numeric `0.9` as 0.9 bytes, while pinned Jest normalizes it as 90% of system memory; the current explicit `'2GB'` is correct, but the guard can accept a future recycle limit above the worker's heap cap. [Candidate parser](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/14c84c75aba63236ef22ca3dea96f791dc75f247/test/ci/jest-typecheck-gate.spec.ts) [Configured current limit](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/14c84c75aba63236ef22ca3dea96f791dc75f247/jest.config.js)

Minimal fix: reject fractional numeric limits or normalize them using the actual Jest proportional semantics; no change to current `'2GB'` is needed.

### Evidence accepted, with bounds

The current Type-check genuinely precedes Test, source/spec scope and config inheritance are coherent, and no workflow, required job, dependency, package script, TypeScript config or RLS config changes in this PR. [Candidate](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694) [Passing existing guard and name controls](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)

Root-cause evidence is consistent: main's original log shows an approximately 4,054-MB worker dying late, multiple other stored failure logs show different victim suites, the pinned ts-jest implementation builds a LanguageService only on the non-isolated path, and the builder's ordered forced-GC A/B logs show materially lower retention with isolated transpilation. [Main OOM](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144478819/job/111265482439) [Builder evidence](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976061768)

Both claimed green runs independently verified: wall 4m03s / 6m25s, tsc 29 / 52 seconds, Jest 137.8 / 235.069 seconds, 714 passed suites / 12,313 passed tests and logged peak heap 1,553 / 1,632 MB; PASS lists match one another, and differ from green main only by the new guard. [Attempt 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111348549769) [Attempt 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111349414644) [Green baseline](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144478819/job/111267494968)

## Evidence saved

- `/home/user/workspace/ops/aud-116/AUD-SOL-661CI-116/`: both posted verdict bodies, readable probe specs and git patches.
- Final live-head snapshots and required-check settings are saved in that directory; at `2026-10-04T03:25:39Z` both reviewed heads remained unchanged and behind main. [#661 state](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661) [#694 state](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694)
- Tests-only probe commits: `0507cdec16c093aebaaaed2208a9ddced98a10b4` (#661) and `02086af10949440ab558cbd3f35d13e2725c5df7` (#694); exact candidate source/config/guard unchanged beneath the probe and temporary CI-lane wrapper. [#661 probe execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) [#694 probe execution](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)
- `/home/user/workspace/ops/aud-661-*-sol116.*`: initial PR/comments/check JSON, builder failing-before job metadata/log, independent failure log.
- `/home/user/workspace/ops/aud-694-*-sol116.*`: initial PR/comments/check JSON, both exact-head green job metadata/logs, main OOM/green logs, PASS-list comparisons and independent mutation failure log.
- Isolated worktrees retained for evidence, without linked node_modules: `/home/user/workspace/wt/AUD-SOL-661CI-116-661` and `/home/user/workspace/wt/AUD-SOL-661CI-116-694`; no shared checkout was modified.
- Both throwaway remote audit branches were deleted after their completed proof runs; the local specs/patches/commits and immutable run evidence remain available. [#661 completed proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890) [#694 completed proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)

## HANDOFF

- **#661** remains at `a193d7e17b2d4daeb944891191824d08e280b437`, REQUEST CHANGES **0/1/0**, required candidate checks 11/11 SUCCESS but independent ordering probe red; a fresh builder must close B-661-3's stale-prefetch interleaving and provide failing-before/passing-after evidence, then both lenses audit the new head. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661#issuecomment-5976137883) [Probe](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173632890)
- **#694** remains at `14c84c75aba63236ef22ca3dea96f791dc75f247`, REQUEST CHANGES **0/1/1**, required candidate checks 11/11 SUCCESS and two green full build-and-test attempts; a fresh builder must close B-694-1 and should cheaply fix C-694-2, then both lenses audit the new head. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976120709) [Negative proof](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37173631554)
- Both heads were re-read immediately before posting and remained unchanged; both are behind main, so operator-owned branch refresh remains required after repairs. [#661 state](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/661) [#694 state](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694)
- Operator decisions: retain C-661-2 as an explicit approved deploy-window data change; track C-661-3's combined recurring credential/decline behavior in landing order. No merge, deployment, production call or local heavy execution was performed by this lens.
