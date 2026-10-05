FIX ROUND 13 (B-FEES-117, agent 117) — growth-project-backend#681 @ e9650dc4e2551adfdfd25203b53d712a5b75e32b

Builder: agent 117, job B-FEES-117. Base `main`. Size 2,956 (additions + deletions, no lockfile); SIZE ASSESSMENT below.

| Finding | Change | Commit | Test |
|---|---|---|---|
| Sol B-681-2 (= Opus C-681-7): the legacy ledger key used the payee's connected account (a snapshot that changes on reconnection) while the lookup used the payee user | `legacyLedgerKey` is now `sfee-legacy-ledger:<purchase_id>:<kind>:<payee_user_id or platform>`: key and lookup use the same identity (the row's own `payee_user_id`, retained FINANCE in the deletion manifest) | `064e24b0f742164642ad586343e49f6fa6ea6291` | `test/s-fee-r11-ledger-identity-diagnostics.spec.ts` (`bb4fcdf0655c41062a8ff339f7127633073adb33`): "pre- and post-reconnection account snapshots of one payee keep one legacy row per slice", "a new head coach on a renewal still gets its own legacy row (identity is the payee)", key expectation `sfee-legacy-ledger:cp-legacy:destination:coach-1` |
| Sol B-683-1 (schema half, for F3 #683) | `PayoutAdjustmentNotice` gains nullable `client_currency` and `client_refunded_cents` (`CHECK >= 0`) in `schema.prisma` and the stack's own unmerged migration `20270210000000_s_fee_charge_settlement` (down.sql drops the table, unchanged) | `ac75bfb46ed6312c06de191ca505080db2559eaf` | F4b #697 `test/s-fee-r13-refund-list-notices-deadline.spec.ts` (Sol B-683-1 block); Schema parity and forward-migration checks green here |
| Operator 117 (22:32): main's #694 (jest worker memory) and #695 (SBOM determinism) | merge of `main` `b644198b90bb9ab1dc62a78794e12cf09f8ace7c`, merge-only, its own commit, flows up F2-F6 | `e9650dc4e2551adfdfd25203b53d712a5b75e32b` | PR CI at this head |

Evidence:
- Failing-before: [run 37178745416](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37178745416) at `bb4fcdf0` (spec on `9de3135c`): 3 failed / 8 passed (the key expectation and both reconnection tests). Sol's real-Postgres failing-before at `9de3135c`: [run 37177725573](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177725573).
- Passing-after: [run 37179121283](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37179121283) at `ac75bfb4`: tsc green; `s-fee-r11-ledger-identity-diagnostics`, `split-ledger.service.spec` and Sol's real-Postgres probe (lane-only copy, never merged) 21/21.
- PR CI at this head: every required check green, build-and-test [run 37180263383](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180263383).

Not taken: none open on F1. The real-Postgres regression stays lane-only evidence (build-and-test has no database; adding a live job is a CI gate change for the operator).

SIZE ASSESSMENT: 2,956 of 3,000. Content is the S-FEE foundation (migration, schema, fee policy, ledger, lock, Stripe transfer API, call sites) plus round-13's 74 lines (key fix, two tests, two nullable columns). Splitting further would separate the schema from the services that depend on it. Below the hard limit; no further growth planned in F1.

READY FOR AUDIT
