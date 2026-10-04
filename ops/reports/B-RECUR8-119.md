# B-RECUR8-119 — recurring R1-R5 restack onto main (fees landed) + #701 B-701-1
Started Sun Oct  4 15:28:47 PDT 2026. Lock lanes119/locks/recurring taken 15:28:47.

## Step 1 — merge-only restack (local, not pushed yet)
main f48267f9d7a58e517db390ed8bfdde3a18825746. Old merge-base of #678 with main: 13c814f7 (fees piece).
Worktrees wt/B-RECUR8-119-1..5, branches wip/B-RECUR8-119-<pr>. All five merges clean (ort, no conflicts).
| PR | old head | new head (local) | own diff patch-id old = new |
|---|---|---|---|
| #678 | 09e159d8 | 1fea16a1 | 51e9e0b60878810c38f55c89b8f59abd2c3281d6 |
| #679 | 23d2c04c | 96e6e690 | 820b3f282646eb8c74b07c5538848c2952c2e3b6 |
| #680 | f267417a | 1402bc79 | e6f4a056d87e5e296971074f492fa0806387c8b5 |
| #696 | 13c9a6c8 | 310f6856 | 66de0d2072eb0a1b8c28e1fe66a6cb4e4567755c |
| #701 | d624144c | 644ee9e6 | 628a08657cd51b5d596974b372a76e2a14734d9e |
- old head..new head for every PR = patch-id cdbb42516a21baf47a70fedb9b00d015fcd4d5bf = fees delta 13c814f7..main (49 files). So each new head = old head + exactly the fees delta; nothing lost on either side.
- Overlap file src/checkout/checkout-webhook-handler.service.ts (only overlap): recurring side 23d2c04c..f267417a = new679..new680 (272ff0b8); fees side 13c814f7..main = f267417a..new680 (bcce18ad, +refund.updated case). charge-settlement.service.ts: not touched by recurring; identical to main at new top.
- REVOKED_STATUSES / purchaseHasEnded / decline fence / lock order: not in fees delta -> byte-identical to f267417a.
- C-680-19 check vs landed fees: ClientPurchase status writes on main refund-dispute-handler.service.ts: refunded (L362, L1466, entitlement off), chargeback_lost (L996, entitlement off), disputed (L1099, L1148), won -> paid (L1008-1011). Values unchanged by fees; refunded/chargeback_lost/disputed are in REVOKED_STATUSES; won->paid still deliberately out (C-680-19 stays open, belongs to R-DISPUTE-PAUSE build).

## Step 2 — R75 finding (new, after fees landed)
check-r75 --mode=range per piece at the local restack: #678 vs main as any +9 FAIL (b-recur6a-118-r1 1, b-recur7a-119-r1 8);
#679 +2 FAIL (b-recur5a-117-fix-round-5 1, b-recur6a-118-fix-round-6 1); #680 net -1 OK; #696 OK; #701 +5 FAIL.
Composed top vs main: as any +31 -16 net +15 FAIL. Opus's earlier "net +1" simulation was from 3e9a9a75 with the fees removals in range;
with fees on main those removals no longer offset. Fixing only the 5 in #701 leaves composed +10 FAIL.

## Step 2 — B-701-1 fix (local commit, not pushed)
Commit 1e059f6c38bd033b17bb1912088a436c497f6dbf on wip/B-RECUR8-119-701 (parent 644ee9e6), tests only, 7 files +43/-21 vs 644ee9e6:
- new test/support/typed-double.ts: partialDouble<T>(Partial<T>): T (compiler checks every provided member against the real type).
- `{ ready: true } as any` x4 -> Object.assign(new ConnectModuleState(), { ready: true }) (r2, moved-round-4, fix-round-5, fix-round-6).
- makeCheckoutHelpers(db) as any -> partialDouble<CheckoutService>(...); PackagesService `{} as any` -> partialDouble<SubCoachScopeService>();
  package edit -> typed UpdatePackageInput; AccountDeletionBillingService `{} as any` -> partialDouble<StripeApiService>(); 6 sendFenced rows
  -> partialDouble<ClientPurchase>(...); list response cast removed (type already fits).
- Includes the R1/R2 spec casts (b-recur6a-118-r1, b-recur7a-119-r1 from #678; fix-round-5, fix-round-6 from #679) because the composed
  main-based gate counts them; #678/#679 stay merge-only (patch-ids unchanged). Moved spec b-recur5a-117-moved-fix-round-4 is no longer
  byte-identical to the #679-deleted file (3 cast lines + 2 imports only).
- R75: #701 range (310f6856..1e059f6c) as any +0 -11 OK. Composed top vs main f48267f9: as any +15 -16 net -1, as unknown as net -1 OK.
  No `as unknown as` / `as never` added.
- Scoped tsc (7 files, strict tsconfig) clean; negative control (wrong member type) caught. Targeted jest 6 suites 70/70 pass.
- #701 size vs #696: 658+13 = 671.

## Step 3 — probe replay (CI lane, done) and full suite (NOT run: push blocked)
Probe lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37240728242 at 3ffa3de9 = 1e059f6c +
probe commit 28376732 (copies of Opus R12/R12D/R34/R34D and Sol R12D/R34D probe specs + their regression spec lists; list in
ops/aud-119/B-RECUR8-119/probe-specs.txt, log probes-37240728242.log). 40 suites, 577 tests: 564 pass, 13 fail, all expected:
- Opus R34D set: 10 known red = C-680-18 x7, C-680-19 x1, R34 no-redelivery control (changed by B-680-2 rule), C-680-13. Same as 37232952084.
- Opus R12D set: 2 known red = C-678-3 acceptance (404 No such customer), C-679-4 evidence. Same as 37231743536.
- Sol R12D r2: 1 known red = C-679-3 acceptance. Same as 37231523863. Sol R12D r1 42/42 and list 67/67 sets, Sol R34D 321-case set: all green.
- Nothing new red; C-680-18/19 not fixed, so their reds are expected.
Full suite: prepared ops/aud-119/B-RECUR8-119/ci-lane-full.yml (ci.yml verbatim, five jobs, push ci/** trigger, + R75 vs main job).
The push of ci/B-RECUR8-119-701-full was BLOCKED by the safety classifier at 15:38 PDT (force-push flag). Per job rules all pushing stopped.

## Follow-ups (C)
- C-680-18 checkout-webhook-handler.service.ts ~L1826-1846 + dunning-v2 applyImmediateClear: guard revoked rows before the V2 clear; carried by whichever of recurring / D2 #688 lands second; FEATURE_DUNNING_V2 off until then.
- C-680-19 refund-dispute-handler.service.ts L1008-1011 on main (was 952-956): dispute won writes `paid` on a recurring row; R-DISPUTE-PAUSE build must keep the plan revoked (coach restarts).
- C-678-3, C-679-3, C-679-4 (evidence), C-680-13: still open as before (no change from this merge-only round).
- New: R75 per-piece ranges #678 +9 and #679 +2 stay positive on their own heads (fix lives in #701); see decision 2.

## Money list self-check (merge-only round)
- Webhook order/redelivery: recurring dispatch unchanged (patch-ids equal); fees adds `refund.updated` to the refund handler route (idempotent per refund id); decline version fence unchanged.
- Concurrency: package FOR UPDATE -> purchase FOR NO KEY UPDATE and sorted user FOR KEY SHARE unchanged; fees delta touches none of these files.
- Terminal states: REVOKED_STATUSES (6) unchanged; fees keeps status values refunded/chargeback_lost/disputed (all revoked) and won->paid (C-680-19).
- Pagination/completeness: deletion collectors and plan list fail closed, unchanged; fees refund-list completeness is main's.
- Currency: no recurring change; fees presentment/settlement handling now on main.
- Copy truth: no copy changed.

## HANDOFF
State at 15:42 PDT 10-04: NOTHING PUSHED. All five PR heads still old (#678 09e159d8, #679 23d2c04c, #680 f267417a, #696 13c9a6c8, #701 d624144c).
Push was blocked once (ci lane force-push); no retry. Lock lanes119/locks/recurring released at finish.
Ready local commits (shared clone branches + worktrees), each a fast-forward of its PR branch:
| PR | branch -> remote | new head | worktree | size |
|---|---|---|---|---|
| #678 | wip/B-RECUR8-119-678 -> agent115/recur-split-1-terms-foundation | 1fea16a13e7be18bbf728baba9f69d0a0c65fba6 (parents 09e159d8, f48267f9) | wt/B-RECUR8-119-1 | 2,594 vs main |
| #679 | wip/B-RECUR8-119-679 -> agent115/recur-split-2-subscription-checkout | 96e6e69052b75c80d7d8a6487b00192223c936ac (23d2c04c, 1fea16a1) | wt/B-RECUR8-119-2 | 2,943 |
| #680 | wip/B-RECUR8-119-680 -> agent115/recur-split-3-webhooks-fixes | 1402bc7922d5b96921be936f37eaeca173404531 (f267417a, 96e6e690) | wt/B-RECUR8-119-3 | 2,779 |
| #696 | wip/B-RECUR8-119-696 -> agent117/recur-split-4-service-specs | 310f6856e382b3592ae4403b2d3cf503ebf65779 (13c9a6c8, 1402bc79) | wt/B-RECUR8-119-4 | 2,197 |
| #701 | wip/B-RECUR8-119-701 -> agent117/recur-split-5-round4-specs | 1e059f6c38bd033b17bb1912088a436c497f6dbf (merge 644ee9e6 = d624144c + 310f6856, then fix) | wt/B-RECUR8-119-5 | 671 |
Bundle: ops/aud-119/B-RECUR8-119/b-recur8-commits.bundle (origin/main..wip/B-RECUR8-119-701); probe commit bundle b-recur8-probes.bundle.
Operator push (plain, non-force, bottom-up): `git push origin wip/B-RECUR8-119-678:agent115/recur-split-1-terms-foundation` ... same for 679/680/696/701.
Remote leftover: ci/B-RECUR8-119-701-probes (run 37240728242 done) — delete it (`git push origin --delete ci/B-RECUR8-119-701-probes`).
Next (fresh builder or operator): push; run full suite (ci-lane-full.yml on a ci/ branch at 1e059f6c, plain push); wait for PR CI at the five new heads;
post RESTACK + READY on #678/#679/#680/#696 and FIX ROUND + READY on #701 (old -> new heads, parents, patch-ids, runs above); #678 R75 red by design (decision 2);
write notify/recurring.txt "recurring top: #701 @ 1e059f6c38bd033b17bb1912088a436c497f6dbf (...)"; remove wt/B-RECUR8-119-1..5 and wip/B-RECUR8-119-* after push.
Decisions: (1) push these five fast-forwards as-is — default yes. (2) #678's own main-based "Banned cast tokens" goes red (+9) at 1fea16a1;
accept red-by-design, turned green by #701 in the one-piece landing composition (net -1) — default yes; alternative: move those typing hunks into #678/#679 (breaks merge-only/patch-id, needs lens deltas).
