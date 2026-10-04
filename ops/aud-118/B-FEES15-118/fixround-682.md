FIX ROUND 15 (B-FEES15-118, agent 118) — growth-project-backend#682 @ 70f879a29f06815d15a48c3c42483667a474d507

Builder: agent 118, job B-FEES15-118. Fast-forward from `a2051568` (round 14); base F1 #681 `e9650dc4` unchanged. Test-only round: `src/` and `test/utils/` are byte-identical to `a2051568`.

| Finding | Change | Commit | Test |
|---|---|---|---|
| Opus B-682-9: banned R75 tokens in `test/s-fee-r11-reversal-admission-diagnostics.spec.ts` (`page as never` x2, `.catch(() => undefined)`), plus `[] as any[]` in the transfer-orchestrator stub | the four malformed pages now reach the orchestrator through the real `StripeConnectApiService.listTransfers` / `listTransferReversals` parser: `fetch` answers once with the page, `requireSecret` returns a test key, and the fake's list method calls the real prototype method once (`mockImplementationOnce`). The first lost reversal is `await expect(...).rejects.toThrow()`. The stub returns `data: []`. No `any`, `as never`, `as unknown as` or empty catch is added | `70f879a29f06815d15a48c3c42483667a474d507` | `B-682-4 an incomplete Stripe list never proves a lost send absent`, 8 cases: held, `list_page_malformed`, not re-sent, then repaired from a full list (unchanged assertions) |

R75 (`node scripts/check-r75.js --mode=range --base=b644198b90bb9ab1dc62a78794e12cf09f8ace7c --head=<sha>`):

| Head | Result |
|---|---|
| F2 `70f879a2` | OK, no positive class (`as any` 23/23, `empty-catch-undefined` 1/1) |
| fees top #686 `5937064f` (round-15 restack) | FAIL on one class only: `as unknown as` +1 in `test/s-fee-r13-refund-list-notices-deadline.spec.ts:140`, added by #697 F4b (`e30901b5`), not by this piece; operator item in the #697 FIX ROUND |
| scratch merge of recurring top #701 `67905b43` with fees top `5937064f` (never pushed) | OK, no positive class |

Evidence:
- failing-before [run 37219074126](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219074126): R75 probe at `a2051568`, 2 failed / 2 (r11 spec `as never` +2 and `empty-catch-undefined` +1; orchestrator spec `as any` +1).
- passing-after with tsc [run 37219095855](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219095855) at `70f879a2`: tsc green; R75 probe 2/2, r11 spec, orchestrator spec, r7, r9 green; prior probes below.

Prior probe replay at `70f879a2` (both lenses, incl. the dead agent-117 lens branches; run 37219095855):

| Lens | Probe (branch head) | Result |
|---|---|---|
| Sol | AUD-SOL-F12-116 f2-probe (`6de54f78`) | FAIL, timeout: pauses on `transferReversalOp.update`, which round 11 replaced by the claim `updateMany`, so the gate is never reached; its round-11 successor (next row) passes |
| Sol | AUD-SOL-F12-117 reversal admission (`c0a93461`) | PASS |
| Sol | AUD-SOL-F12R13-117 transfer protocol (`b21cd23b`) = AUD-SOL-F23-117 independent (`d2fdec0e`) | PASS |
| Sol | AUD-SOL-F12R13-117 list shape (`59ebc276`) = AUD-SOL-F23-117 listing (`d2fdec0e`) | PASS |
| Opus | AUD-OPUS-F12-116 682-probe (`d91c3922`) | FAIL, timeout: same superseded `transferReversalOp.update` hook; successors (next two rows) pass |
| Opus | AUD-OPUS-F12-117 682-probe + extra (`2fc90de7`) | PASS (both suites) |
| Opus | AUD-OPUS-F12-117 live-db probe (`808201eb`) | PASS |
| Opus | AUD-OPUS-F12R13-117 envelope (`106c40b7`) | 5 ENV cases FAIL as intended (they assert the pre-round-14 double send), 3 controls PASS; identical to the round-14 flip [run 37184232889](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37184232889) |

Money self-check (no source change in this round):
- Webhook order and redelivery: unchanged code; each malformed page is followed by a full list that repairs the row with one transfer and one reversal (same assertions as round 14).
- Concurrency (two workers, lock order): unchanged code; Sol F12-117 admission and Opus F12-117 probes (two senders, claim before HTTP) pass.
- Terminal states (refunded, disputed, canceled, deleted account): unchanged code; r7 / r9 specs and the live-db probe pass.
- List pagination and completeness: the malformed pages now go through the real API parser and the orchestrator still fails closed (`list_page_malformed`, held, not re-sent).
- Currency (presentment vs settlement, minor units): not touched by this piece's change.
- Copy truth: no copy change; B-682-3 copy cases pass.

CI at this head: build-and-test [run 37219126067](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37219126067) red by design, exactly 4 tests in 2 suites: `checkout-webhook-fee-split.spec.ts` 2 and `purchase-split-handler.service.spec.ts` 2 (`this.prisma.connectTransfer.updateMany is not a function`: main's fixtures predate the orchestrator). Lint, type-check and build are green; every other check is green. F4 #684 carries the updated fixtures and turns all 4 green ([run 37220306306](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37220306306) at `bbf2eac6`).

SIZE ASSESSMENT: 2,999 of 3,000 (+2,883 / -116); this round is +11 / -9 in two spec files. One line of headroom: any later change to this piece must remove lines first.

Not taken (FREEZE, follow-ups): C-682-5 (first metadata match wins, `src/connect/fees/transfer-orchestrator.service.ts:215`), C-682-6 (the 160-character cut drops trailing words, `src/connect/fees/payout-notice-copy.ts:117`), C-682-7 (`send_abandoned` cause text, `src/connect/fees/transfer-orchestrator.service.ts:1213`).

READY FOR AUDIT (red by design: build-and-test, the 4 tests above; F4 #684 turns them green)
