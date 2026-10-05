# AUD-OPUS-T23D-119 — Claude Opus 5.5 lens, trials T2 #672 + T3 #673 FIX ROUND 10 + new T4 #706 (backend), agent 119 wave

Started 2026-10-04 13:32 PDT; verdicts posted 13:45 PDT; cleanup 13:45 PDT (times from `date`). Tier T4 (money path). Disk 69 percent.

## Result
| PR | Head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| backend#672 (T2) | 62c2c066a9347dcf16ad45d010f5434e85ae1a60 | APPROVE | 0/0/6 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/672#issuecomment-5984213235 |
| backend#673 (T3) | 904b964250f4b7694b24f78fdef5a5f846957013 | APPROVE | 0/0/5 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/673#issuecomment-5984213420 |
| backend#706 (T4, tests only) | a3f011638f29d80d92115b90ba0897a24f6ae709 | APPROVE | 0/0/1 | https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/706#issuecomment-5984213585 |

- Each head was re-read right before posting (13:45 PDT) and had not moved.
- CI: 10 applicable checks pass at each head; deploy-readiness-gate is skipped. Merge state CLEAN, all three still drafts.
- Verdict texts: ops/aud-119/AUD-OPUS-T23D-119/verdict-672.md, verdict-673.md and verdict-706.md.
- Claims: ops/lanes119/claims/backend-672-62c2c066-opus, backend-673-904b9642-opus, backend-706-a3f01163-opus.

## Evidence reuse (G09)
- **#672:** the delta from the approved `2690c07c` is one file, trial-notice.service.ts (+14/-7), read in full together with its callers. Size 2,968, under the grandfathered 3,000 ceiling.
- **#673:** fix `71ae1e03` (3 files, +66/-6) was read in full. Merge `904b9642` is byte-identical to the T2 delta (the diff of the two diffs is empty). Size 2,947.
- **#706:** a full read, no reuse. One test file, +423. Opened at 13:20 PDT, under the 1,500-line rule for new PRs.

## Decisions on prior findings
- Sol B-672-3: closed. Purchase and customer card now come from one REPEATABLE READ snapshot.
- Sol B-673-1 and Opus C-673-5: closed, by the paid-invoice history check.
- Sol B-673-2: closed. The ownership re-check after the reads vetoes the DELETE.
- Sol's customer-card probe: this lens agrees with the operator default to narrow it. The received text is the correct no-card copy.

## Probes (CI lane; probe specs only, on the exact heads)
- **#672:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232961230.
  - New audit-opus-t23d-119-672.spec.ts: N1, N2, N3, N3b and N4 green. N5 (C-672-12) red, as expected.
  - Replays as ruled: 119 all green; 118 C-672-10 and C-672-11 red; 117 three reds by design.
- **#673:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232971108.
  - New audit-opus-t23d-119-673.spec.ts: P1-P6 green.
  - Replays: 119 K1-K6 green and C-673-4 red; 118 C-673-2 and C-673-3 x2 red.
- **#706:** run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37232982567. The #706 spec is 23/23 together with all 8 Opus probe files; 55 pass and 10 fail, and all 10 are expected reds.
- Copies and logs: ops/aud-119/AUD-OPUS-T23D-119/ (spec files, run-*.log).

## Follow-ups (C)
1. **C-672-12 (new, #672)**
   - Where: `trial-notice.service.ts:898-916` (`admit()`). If `prepare()` throws (the RR transaction cannot start, or times out with P2028), the attempt is not given back and the lease stays held. After 5 such failures the notice is silently lost.
   - Fix rule: catch in `admit()`, complete with `attempts -1` and `last_error '<ch>:prepare_failed'`, then return null.
   - Verify: N5 turns green.
2. **C-673-6 (new, #673)**
   - Where: `trial-conflict.service.ts:261-286`. A never-billed past_due/unpaid cancel does not void the open invoice first.
   - Effect: a Smart Retry or a client payment can land between the read and the DELETE, and the cancel leaves open invoices open (`auto_advance=false`).
   - Fix rule: void the open latest invoice first; if Stripe says `invoice_not_open` or paid, supersede; only then DELETE. This matches the dunning 2A rule.
3. **C-706-1 (new, #706)**
   - Where: `b-trials-4-fix-round.spec.ts:316-318, 374-410`. The fake `$transaction` is read-committed, so the race tests pin read order, not the snapshot. They would pass without `isolationLevel`.
   - Fix rule: a snapshot-freezing fake (as in N1/N2) or a live-DB spec.
4. **C-673-4 (carried)**
   - The worker supersede does not re-sync access.
   - The comment at `checkout-webhook-handler.service.ts:974`, "past_due: no money taken yet", is now stale for the history case.
   - Belongs to the #680 integration round.
5. **Carried unchanged:**
   - C-672-10 and C-672-11.
   - C-672-3: mobile #338.
   - C-672-5 and C-672-6(b).
   - C-673-1: `billing.service.ts:674-686`.
   - C-673-2: `checkout-webhook-handler.service.ts:925-934`.
   - C-673-3: on the #680 list.
   - C-672-1: #680 integration.

## Operator decisions (recommended default first)
1. **C-673-6 (void before cancel).**
   - Default: fix it in the same round as C-673-4 (the #680 integration round), before any trial is sold.
   - Alternative: a T3 round now; #673 has 53 lines of headroom.
2. **C-672-12.** Default: ticket it, and fix it with C-672-10 in the same file.
3. **C-706-1.** Default: ticket it; the code is correct.
4. **Carried:**
   - The owner enables `customer.subscription.trial_will_end`.
   - Mobile #338 adds the push route.
   - Trials land as one (T1 #671, then T2, then T3, then T4 #706), after recurring.

## Progress
- 13:32 PDT: read the rules, the entry and the reports; claims taken.
- By 13:40 PDT: deltas read; probes pushed (3 CI-lane runs).
- Between 13:40 and 13:45 PDT: runs completed as expected.
- 13:45 PDT: verdicts posted.
- 13:45 PDT: cleanup.
  - Remote audit/AUD-OPUS-T23D-119/{672,673,706}-probes are deleted (ls-remote empty).
  - Worktrees wt/AUD-OPUS-T23D-119-{672,673,706} are removed and pruned.

## HANDOFF
- Done: one verdict per PR at the exact heads. #672 APPROVE 0/0/6, #673 APPROVE 0/0/5, #706 APPROVE 0/0/1.
- Cleanup is complete. The operator can release the claims ops/lanes119/claims/backend-{672-62c2c066,673-904b9642,706-a3f01163}-opus.
- Next lens action: only on a new head. That means a delta audit, replaying ops/aud-119/AUD-OPUS-T23D-119/*.spec.ts and the earlier Opus probe files.
