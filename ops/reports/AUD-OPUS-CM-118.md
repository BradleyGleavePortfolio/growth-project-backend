# AUD-OPUS-CM-118 — Claude Opus 5.5 lens, coach Money M1 #674 + M3 #676 (agent 118 wave)

Started: Sun Oct  4 10:31 PDT 2026. Claims: lanes118/claims/backend-674-f9e21a87-opus, backend-676-ccd60bbc-opus.
Heads under audit: #674 f9e21a87bf47502458a6ae21c2393010a1279198, #676 ccd60bbcb6b724534cfc69547c89a68c9af32901.
Notes: ops/aud-118/AUD-OPUS-CM-118/ (comment bodies c<id>.md, delta diffs 674-delta-handler.diff, 676-delta-service.diff).
Worktrees: wt/AUD-OPUS-CM-118-674, wt/AUD-OPUS-CM-118-676 (detached at the heads, no node_modules).

## Evidence chain (G09)
- Opus history: #641 APPROVE fb29fb9e (M3 code mostly byte-identical to it); 116 full line audit of M1 at 9a512028 (RC 0/4/5) and
  M3 at 564f33bf (RC 0/2/1); 117 delta audit 9a512028..d9327546 (RC 0/1/5, 5976743131) and M3 delta to cf5ef18b (RC 0/2/0, 5976743259).
- This lens: every line of the FR2+FR3 delta. #674: merge-tree(b644198b, d9327546)=a66e54b5 vs f9e21a87 (14 files, +855/-966;
  src: refund-dispute-handler +292, transfer-orchestrator 14, migration/schema 22, runbook 20). #676: cf5ef18b..ccd60bbc on M3 files
  (coach-money.service.ts +213/-27, 2 new specs, read double); ccd60bbc tree == merge-tree(fbd6402c, f9e21a87) (merge-only restack).
- main 2af682ca: #674 BEHIND, merge-tree clean, zero file overlap (data-export + SBOM only).

## Prior Opus findings — decisions (in progress)
- #674 B-674-5: code closed (dispute-scoped key, stamped amount, Stripe-first retry, record claim). Probe replay pending.
- #674 C-674-10: closed (boundId returned; .env.example "drift check").
- #676 B-676-3: closed by writer (event-time posting) + reader (event-id rows + occurrence seeding). Probe replay pending.
- #676 B-676-4: closed (BILLED_WHERE in churn; heldIds = any entitled purchase). Probe replay pending.

## Candidate Cs so far
- C-674-12: concurrent refund deliveries — only the ledger-claiming delivery passes posted_at to the head-coach posting; if the other
  delivery wins the transfer claim, the head-coach posting is dated at record time (ms later; crosses a window only at a boundary).
- C-676-3: BILLED_WHERE is not exported (C-673-3 integration must reuse it). Predicate itself correct for status 'trialing' rows.
- C-676-4: MRR/paying count a post-trial past_due subscription that never billed (needs trials composition).

## HANDOFF
- Not yet posted. A fresh Opus lens: claims exist (mine), read this file, continue from "in progress".
