MAIN REFRESH (B-TR7-120, agent 120) — growth-project-backend#671 @ ea7a97409f92a02bae5d10f811870753d9d8c4db

**Tier:** T4 (money path). Merge of main `ee55f814` (recurring #678 and the fees stack) into T1 `c75002c9`, one merge commit with parents `c75002c9` and `ee55f814`. The PR was DIRTY because `prisma/schema.prisma` conflicted. No rebase, no force push. **Size:** 2,289 changed lines (+2,289/-0, 17 files); it was 2,291, and the 2 lines dropped because main already declares the shared `trial_days`.

### Conflict -> resolution -> commit -> check
| Conflict | Resolution | Commit | Check |
|---|---|---|---|
| `prisma/schema.prisma` `ClientPurchase`: T1 adds `trial_days`, `trial_ends_at`, `card_on_file`; main (B-RECUR) adds `trial_days`, `trial_started_at`, `checkout_terms` | Both sides are additive. `trial_days Int?` is declared once (both migrations already use `ADD COLUMN IF NOT EXISTS`, and the comments on both sides name the column as shared). Every other column and both comment blocks are kept. Migration files are unchanged and keep their order: fresh DB `20270225` (main), `20270228` (T1), `20270311` (main), `20270313` (T1). The 20270316000000 rule does not apply to existing migrations | `ea7a9740` | [Schema parity](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344399578/job/111879224538), [Forward migrations apply cleanly](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344399970/job/111879224598), [New migrations reversible](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344399970/job/111879708906), `prisma validate` locally |
| `src/account-deletion/account-deletion.manifest.ts` (auto-merged) | T1's added lines are identical; only the context lines differ | `ea7a9740` | build-and-test |

Every other T1 file's diff against main is byte-identical to its diff at `c75002c9` (15 of 17 files, compared per file). Because schema.prisma was resolved, rule 12 does not apply, and a lens delta is requested on the `ClientPurchase` block only. `prisma format` was not run because it reformats unrelated models on main.

### CI at this head
All 20 checks are green, and deploy-readiness-gate is skipped. They include [build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37344399700/job/111879224184), Schema parity, forward and reversible migrations, rls/community/mwb-3 live tests, rls-floor-guard, CodeQL, banned casts, danger, actionlint, shellcheck, build-sbom, npm audit and size-label. There is no failing-before run because there is no finding, only a conflict.

### Money-list self-check
- **Webhook order/redelivery:** no T1 webhook code. Main's B-RECUR handler is unchanged by this merge.
- **Concurrency and lock order:** no change. The T1 ledger lock and main's per-(client, coach) advisory lock are separate code paths in T1. They meet at #673, see below.
- **Terminal states:** no change.
- **Pagination/fail-closed completeness:** no change.
- **Currency/minor units:** no change. Shared `trial_days` sits inside main's CHECK `1..730 or NULL`, and T1 writes only 1..30.
- **Copy truth:** no copy change.

**Operator note (stack):** the #672 restack (`b0654c80`) is pushed and green. The #673 restack stopped: main's #678 conflicts with T3 in `checkout-webhook-handler.service.ts` (6 hunks) and `billing.service.ts` (2), which changes #673's diff. That is an operator decision, recorded in ops/reports/B-TR7-120.md.

READY FOR AUDIT
