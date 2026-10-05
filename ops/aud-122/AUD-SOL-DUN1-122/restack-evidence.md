# Independent Sol restack evidence — agent 122

Reviewed 15:47–15:52 PDT, after auth recovery. Candidate source remains read-only. Evidence commands used local `git show --remerge-diff`, `git show -s` and `git merge-tree --write-tree`, all through bash with the GitHub credential preset.

| Piece | New head | Actual tree | Independent merge tree / resolution |
|---|---|---|---|
| D1 #687 | c140575c8b857023ce69ae28a1dcf6e8ab925335 | 309fc2c3ab1f01a1bf9b7242c0b9b04dc715f02b | Parents d86b31a6 + main 5cde6253; coach-alert emitter conflict + matching foundation-test updates read fully. |
| D2a #688 | 610c52542c0a1865bd9c448d78291d9d663f67fb | 8965d815893894e7e73cc2ecf49f3ced284a5f6f | Recomputed clean merge tree exactly matches. |
| D2b #704 | 524c4025e36fe4b3c925f7cc0072fd6951f01605 | 2dd3aec95c59d04f9abf6d0827446a5d90841d54 | Recomputed merge detects one imports-only conflict in dunning.service.ts; final keeps both main's ADMIN_PURCHASE_OMIT/AdminPurchaseView and v2 feature/cadence/reversal imports. |
| D2c #705 | 346b77570eb4d40a344d4bd0007c70039c34981a | 82e60a808554f62b8bb7cfca33655f5bc21196f9 | Recomputed clean merge tree exactly matches. |
| D2d #724 | 410fb1b3b82b0ab49c8387a8d01e6e3ca6060a6c | c0ad0c6ef1813bc27d4a04bbce2e66cab897b90d | One refund-dispute-handler lost-closure conflict: keeps main's per-dispute transfer reversal and the D2d restartedByCoach access/status-preservation branch, moved into main's purchase && firstPass branch. |
| D3 pre-fix merge | 4f875a397688bf167d64557dad44e4a1b83dc886 | 8238bf2334c9a00f7a65cc0d82e41d21ef46f67b | Recomputed clean merge tree exactly matches; empty remerge diff. |
| D3 #689 fix | ebb522face81af6e642ad610d82ac5989b9dcb08 | c9c5cdc35a0c593fbe3cd3185ced17dc47aa86fa | Owned production delta read fully: ledger-based dispute amount, native SetupIntent onBehalfOf and main's positional voidInvoice signature; fixture changes read. |

## D1 conflict conclusion

Per-channel results and `only` selection survive. Device push goes through main's single sendPush path, while the detailed client/coach text remains in the in-app feed. sendPush uses fixed COACH_ALERT lock-screen copy, ignores inbox body, and sends routing-only data; emitter error logs still use restricted dunningErrorCode. Queue acceptance is the emitter's success boundary; the existing push outbox owns device delivery. No ordinary privacy/money/access regression identified.

## Non-clean restacks

#704 and #724 must not be described as byte-identical clean merges. Their resolution diffs are preserved in `704-remerge.diff` and `724-remerge.diff`; both were independently read and retain each parent's required normal-use behavior. #688/#705 and D3's lower-piece merge have exact tree equality evidence.

## D4/D5 completion — 16:05 PDT

#690's actual 620c9e8b merge-resolution diff (760 lines) was read fully, then its narrow f97c46e2 integration delta was read. Main's subscription activation, terminal-state rules, ordinary payment grace and native first-attempt semantics survive alongside D2c's dispute pause and D4's effective-lock/free-grant waiver. Billing providers, exact lockout routing and recovery-page privacy/footer wiring survive. [D4 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690).

#689 final head `0fbd18cae72f4fdea7c4876034a0d3d1d3dac1cd`, tree `bd5455d369c80b31fbefc7a89c8abeaf2c800470`: the final narrow delta only narrows main's untyped SetupIntent metadata/payment_method values; runtime ownership and successful-card checks are unchanged. [D3 final delta](https://github.com/BradleyGleavePortfolio/growth-project-backend/compare/ebb522face81af6e642ad610d82ac5989b9dcb08...0fbd18cae72f4fdea7c4876034a0d3d1d3dac1cd).

#690 final `b3ae2f295bba961d5c6532698281e91b5194559e`: independent merge-tree(f97c46e2,0fbd18ca) exactly equals actual tree `485c1100060d6d756b0e7bc117bae6be556d5948`. [D4 final commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/b3ae2f295bba961d5c6532698281e91b5194559e).

#691 first merge `b2631440a71f28c6351cba80131029a6d1d53d4c`: independent merge-tree(e0afe678,f97c46e2) exactly equals actual tree `af8525981ec512c709b254bb513ce647675ba7d2`; empty remerge diff. Owned test update `3641c00797491bf76c7b43453f17e3e9d799f841` read: adds 148-line ordinary ledger-amount regression and adapts D5's normal dispute lifecycle to D2c's immediate pause/coach restart rule; already-existing edge tests are not independently analyzed or probed. [D5 test update](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/3641c00797491bf76c7b43453f17e3e9d799f841).

#691 final `d8c229a696436d2a2aec1b9e73f42ce01998fb93`: independent merge-tree(3641c007,b3ae2f29) exactly equals actual tree `3ced09f8e8cf64e25ba760e8d8fc298f8d5dc02d`. [D5 final commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/d8c229a696436d2a2aec1b9e73f42ce01998fb93).

## Outstanding

Builder READY still required. B-690-S1 remains present in actual final production code. B-689-S1 copy remains, but normal-tap cancellation reachability needs a final scope decision. D5 PR/lane tsc errors are integration gate failures, not invented normal-user product Bs; builder notified. [D5 failed build](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386002581/job/112019315460), [builder failed lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37386012832/job/112019345629).

## Subsequent narrow CI fixes — 16:10:51 PDT

#690 current head `c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae`, tree `7fb95913ae8a1aba53a03d2654df264ad7ee06e5`, adds only a tighter legacy exception-text test inventory (webhook 12→7, removes coded sweep exemption); seven actual remaining webhook sites and coded sweep checked, no production change. [D4 test fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/c15f157cabca707bd0dfa9c1e8eb20ff0f78f9ae).

#691 owned fix `b0b4795976497a69fb170da1856857c6f61a569d`, tree `6e75dc2e0eba79a3dd9eb6bfee754be38fea7c51`, only forwards voidInvoice's positional arguments and supplies trial_started_at=null for the never-entitled fixture helper. Current final `17cfa5662b7014a90d54a3d6747ae651c37e8793`, tree `f573a0f5173dd6971ba9a15f5dd593b4bb032c7d`, exactly equals independent merge-tree(b0b47959,c15f157c). [D5 final fix](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/17cfa5662b7014a90d54a3d6747ae651c37e8793).

B-689-S1 is now C-689-S1: no normal-tap cancellation path established from dispute cancel_route=null/planView.can_cancel=false. B-690-S1 remains. Builder READY still absent; current D4/D5 CI queued/in progress. [D4 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/690), [D5 PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/691).
