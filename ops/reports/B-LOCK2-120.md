# B-LOCK2-120 — mobile lockout #352, #353 (+ #354 merge-only restack)

Builder, Claude Opus 5.5, agent 120, T4. Started 09:28 PDT 10-05. Stack lock ops/lanes120/locks/lockout taken 09:28.
Worktrees: wt/B-LOCK2-120-352, -353, -354 (local branches wt/B-LOCK2-120-<n>; push with HEAD:<pr branch>).

## Start heads
- #352 agent115/lockout-split-1-dunning-data @ ac244d22e107e93209a5e1d206d2951d3392fe38 (base main cc4ceeed, BEHIND)
- #353 agent115/lockout-split-2-lockout-screens @ 05d84f27261f1f764214be5a379785ba8f690d3e
- #354 agent115/lockout-split-3-card-update-tests @ f084cc0f8b1dbd4768d2ca168f0b49a90dc39cfe

## Open findings (latest verdicts, agent 119)
- B-352-2 (Sol 5983776115): dunningErrorCopy.ts dispute outcome copy; mixed paid/disputed promises "Your plan updates within a few minutes"; dispute-only save omits access ended / billing paused / coach restarts.
- B-352-3 (Sol): updateCard.ts initStripe -> initPaymentSheet with no owner check between; retired A can replace B's native sheet.
- B-352-7 (Opus 5983819724): disputeNotSettledLine / cancelOutcomeCopy dispute say "Email support to sort it out"; must say the three ruling facts; no "sort it out", no "settle".
- B-353-2 (Sol 5983779129): retained End plan alert callback (UpdateCard + lockout) dispatches POST cancel after unmount; provider checks alive only after sending.
- B-353-3 (Sol) = B-353-6 + B-353-7 (Opus 5983819833): dispute banner future lock date / "unless it is sorted out"; lockout/UpdateCard/end-plan/banner copy omits the three facts; support as the fix; "Already paid?" footnote, Update card and "future payments" on dispute surfaces.
- Contract: backend D2c #705 @ 279ec167 getClientStatus dispute = state locked (or past_due + lock_waived), kind dispute, reason 'dispute_paused', access_ended/billing_paused true, restart_by 'coach', lockout_at/amount/update_payment_route/update_card_url/cancel_route null.

## Status
- 09:28 read _COMMON_120/119/118/116, AGENT_RULES, JOBS120 entry. Mobile deps READY present. Disk 61 percent.
- 09:45 read all four verdicts, both lens reports and probe files (ops/aud-119/AUD-{OPUS,SOL}-L12-119), backend #705 contract.

- 09:55 #352: merged main cc4ceeed (40706529, PR files byte-identical); fix commit c89f719c (local, not pushed yet): disputePauseFacts + dispute outcome copy, status reason/lockout_at, native sheet session latch. Local targeted jest dunningL1Contract 18/18. L1 size vs main 2,586.
- CI lanes: failing-before L1 run 37342797540 (ci/B-LOCK2-120-1, tests on 40706529); after + probes run 37342847558 (ci/B-LOCK2-120-2).
- Decision: Sol probe auditSol119Boundaries "mixed paid/disputed" asserts the old anchor "Saving a card does not settle that"; Opus B-352-7 fix rule forbids "settle". Followed Opus (ruling copy). That one assertion fails by design; its R-DISPUTE-PAUSE assertions pass.

## HANDOFF
- In progress: #352 fix c89f719c committed locally in wt/B-LOCK2-120-352 (push after lanes); next L2 on wt/B-LOCK2-120-353.
