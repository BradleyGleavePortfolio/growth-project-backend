# AUD-OPUS-L3-121 — mobile lockout #352 / #353 / #354 at FIX ROUND 2 heads (Opus lens)

Lens: Claude Opus 5.5, agent 121, T4 (billing lockout, dispute copy). Started 12:41 PDT 10-05 (from `date`).
Claims: ops/lanes121/claims/mobile-352-c89f719c-opus, mobile-353-9d47045b-opus, mobile-354-68c7f080-opus.
Notes / probes: ops/aud-121/AUD-OPUS-L3-121/.

## Heads (GitHub REST 12:41 PDT)
- #352 c89f719cd8f5863c4150af1da5b96e273df319d6 (base main b79ca594, behind, +2580/-6, 14 files)
- #353 9d47045b63a4680d852591ae3b4b2d3bfb1e0d85 (base #352 branch, clean, +2679/-44, 21 files)
- #354 68c7f080c1e7e7708e7c3b213ae9278b57ba3649 (base #353 branch, clean, +1119/-0, 1 file)

## Status
- 12:41 read _COMMON_121, JOBS121 entry, SOT A1/A6/A9.1/A9.2 (L3-120, LOCK2-120), B-LOCK2-120, AUD-OPUS-L12-119, AUD-OPUS-L3-120 (died before any verdict).

- 12:45 tree checks: 4070652 (main cc4ceeed into ac244d22), b587e20 (c89f719c into 05d84f27), 68c7f08 (9d47045b into f084cc0f) each equal `git merge-tree --write-tree` of their parents (dfb53858 / b6d17a84 / 80b91206). #354 own diff byte-identical to f084cc0f's; its one file nativeCardUpdate.test.tsx is blob 47b2207a, identical to #322's Opus-approved head 23435ec2. L1 files identical at #352/#353/#354.
- 12:50 delta read (fix commits c89f719c, 9d47045b). Draft findings: B-352-9 / B-353-9 (dispute copy claims a reversal; ruling 6 inquiries move no money), B-353-10 (dispute lockout's only way back, Message coach, hits backend /messages which the lockout guard 403s).
- 12:54 lane pushed: audit/AUD-OPUS-L3-121/1 @ 68c7f080 + probes, run 37366349003 (queued; GitHub runner incident). 20-min heavy.sh fallback allowed from 13:14 if still queued (deps/mobile not READY yet).

- 13:02 verdict drafts written: ops/aud-121/AUD-OPUS-L3-121/verdict_352_c89f719c.md (RC 0/1/8), verdict_353_9d47045b.md (RC 0/2/8), verdict_354_68c7f080.md (APPROVE 0/0/0). Placeholders {{RUN*}} wait for lane 37366349003 (queued since 12:54).

## Findings (this lens, this round)
- B-352-9: dunningErrorCopy.ts:491-493, :631 claim "Your bank reversed a payment"; owner decision 6 (inquiries pause too; Stripe inquiries move no money) makes it false for an inquiry. Fix: "Your bank opened a dispute or inquiry about a payment[ of $X] to <coach>" (backend B-687-8 wording).
- B-353-9: same on DunningBanner.tsx:28-31 (title "A payment was reversed"), DunningLockoutScreen.tsx:71, UpdateCardScreen.tsx:91 ("took back").
- B-353-10: dispute lockout's primary / only way back is Message coach (DunningLockoutScreen.tsx:88-93, :247-254; UpdateCardScreen.tsx:477-488) but backend DunningLockoutGuard (b#705 2a03d7dd dunning-lockout.guard.ts:56-105, :171-184; also main 5da537d6) 403s /messages for a locked client; dispute pause sets locked_out_at + entitlement_active false (dunning-v2.service.ts:1253-1254, :1274). Operator decision: (a) backend allow-lists the client's coach DM routes (default) or (b) mobile leads with Email support.

## Follow-ups (C)
- C-352-10 dunningErrorCopy.ts:620-634 cancelOutcomeCopy dispute branch unreachable + contradicts scheduled/ended base. Rule: drop or make outcome-aware.
- C-352-11 dunningErrorCopy.ts:489-491 noun counts plans not charges. Rule: count disputes.
- C-352-12 dunningErrorCopy.ts:474-477 account scope "restart it" has no antecedent. Rule: "restart the plan".
- C-353-8 UpdateCardScreen.tsx:459-472 dispute keeps "Add a card" primary. Rule: way back leads; Add a card secondary for other plans.
- C-353-9 DunningLockoutProvider.tsx:16-21 Messages reachable on mobile while locked but not on backend (pre-existing for payment lockouts). Rule: closes with B-353-10 (a); under (b) drop it.
- Carried: C-352-1/2/3/6/8, C-353-1/2rem/4/5/6/7.

## For other jobs (operator; not blocking these PRs)
- Backend dunning (b#687/#705): DunningLockoutGuard.isClientLockedOut (dunning-lockout.guard.ts:171-184 @ 2a03d7dd, same on main) ignores effectiveLock / hasOtherLiveAccess, while getClientStatus uses effectiveLock (dunning-v2.service.ts:1559) and dunning-effective-access.ts:4-11 claims the guard shares it. A dispute-paused client with another live plan gets status past_due + lock_waived (banner) but 403 on every non-allowed route; the app then flips between banner and lockout. Route to the dunning lens pair.

## HANDOFF
- In progress. Probes: ops/aud-121/AUD-OPUS-L3-121/aud121OpusL3_352.probe.test.ts, aud121OpusL3_353.probe.test.tsx (copies in wt/AUD-OPUS-L3-121-1 commit 9d2f9d9e). Lane run 37366349003. Next: read lane result, post verdicts (#352 RC, #353 RC, #354 APPROVE expected), clean up branch + worktree.
