AUDIT GPT-6.1 Sol — growth-project-mobile#377 @ 316f0a130012509f498b36993ec304f0dc151b3a — VERDICT: REQUEST CHANGES

AUD-SOL-MSG1-122, agent 122. A/B/C = 0/1/0.

## B-377-1 — A normal refresh silently discards an unsent routine reply

Normal-user story: A client sends another routine “Thanks” during a brief connection drop, then the next ordinary thread refresh mistakes an older “Thanks” for that new send and removes the unsent message and its Send again action, so the coach never receives the reply. [PR under review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377)

Locations: `src/screens/client/MessagesScreen.tsx:160-161,363-371,786-800`. The new failed-send path stores `v2.client_message_id` on the pending row, but `load()` still feeds it through `reconcilePending()`, whose line 792 removes a pending row if **any** returned message has equal body text; the UUID is ignored. This makes the new unsent/retry flow unsafe even though that helper predates this PR. [PR under review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377)

Minimal fix: for UUID-backed v2 pending rows, keep the unsent row until a server row confirms the same `client_message_id` and sender; neither equal text nor an unrelated page timestamp proves delivery. Keep the legacy reconciliation path separate if needed. Verify that the unsent “Thanks” remains after a refresh containing only an older, different-key “Thanks”, and that it disappears only when its own key is returned.

Evidence: [mobile CI lane — 61 passed, 1 failed](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746/job/112030672561). The sole failure is `MessagesScreenV2.test.tsx:127`, “Sol122: a routine repeated reply is not silently discarded after an unsent v2 send”: the initial “Not sent” assertion passes, but that receipt is absent after the refresh. [Failing screen probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746/job/112030672561)

The lane starts from this exact PR head plus test-only changes and lane plumbing; the send is rejected without a new server row, then an ordinary refresh returns only the older different-key message. [CI run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746)

The empty-payload realtime fix and the ordinary inbox/thread route contracts were independently reviewed; no other lens's current-round work was read. [Operator FIX](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6004786751)

The PR's own [Typecheck, lint, test check is green](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37384923714/job/112015734821); it does not exercise the different-key repeated-reply case. Cs: none added in this review. Size is 1,492 changed lines, so the fix must remain within the 1,500-line cap or be split.
