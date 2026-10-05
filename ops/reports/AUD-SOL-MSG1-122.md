# AUD-SOL-MSG1-122 — messaging mobile independent Sol lens

AUD-SOL-MSG1-122, agent 122. Started 2026-10-05 16:33:49 PDT; completed cleanup 16:40:49 PDT, within the 40-minute time box.

## Exact-head verdicts

| PR | Full reviewed head | Verdict | A/B/C | Posted comment |
|---|---|---|---|---|
| growth-project-mobile#371 | `d4244f2cab5a3d89124a5f56221ef389527d525b` | APPROVE | 0/0/0 | [Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6005559782) |
| growth-project-mobile#377 | `316f0a130012509f498b36993ec304f0dc151b3a` | REQUEST CHANGES | 0/1/0 | [Sol audit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022) |

Both heads were reverified immediately before their comments; no other lens's current-round work was read and no prior lens verdict reused.

## B-377-1 — Routine unsent reply silently discarded

**Normal-user story:** A client sends another routine “Thanks” during a brief connection drop, then the next ordinary thread refresh mistakes an older “Thanks” for that new send and removes the unsent message and its Send again action, so the coach never receives the reply. [Posted finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022)

**Locations:** `src/screens/client/MessagesScreen.tsx:160-161,363-371,786-800`. The newly introduced failed-send path preserves `v2.client_message_id`, but `load()` still feeds these pending rows through the unchanged `reconcilePending()` heuristic, which removes a pending row when any returned row has equal body text, without comparing send identity. [Reviewed PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377)

**Consequence:** the new UUID-backed unsent/retry flow loses the only local copy of an undelivered message during a routine refresh; the pending helper's legacy origin does not make this new integration safe. [Posted finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022)

**Minimal fix rule:** for v2 pending rows, keep the unsent row until a server row confirms its own `client_message_id` and sender; neither equal text nor an unrelated page timestamp proves delivery. Preserve the existing legacy reconciliation path separately if necessary.

**Verification:** the pending “Thanks” must survive a refresh containing only an older, different-key “Thanks”; when a server row with its own send key is returned, reconcile to that server row and remove the pending copy.

## Evidence and review coverage

- The [targeted mobile CI lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746/job/112030672561) completed with **61 passed, 1 failed**, across six suites.
- The sole failure is `MessagesScreenV2.test.tsx:127`, “Sol122: a routine repeated reply is not silently discarded after an unsent v2 send”: the initial Not sent assertion passes, then the receipt is absent after the load callback refreshes the thread with an older, different-key message. [Failure log](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746/job/112030672561)
- Existing coach inbox, coach thread, client thread, API, realtime parser, and pure-helper cases pass in that lane. [Targeted results](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746/job/112030672561)
- Probe commit `a6f58fc` adds test-only changes above #377; lane head `074272f7f8c437740ef50e524e7dd2056f99516d` adds only the lane workflow/spec-list plumbing above that probe. [Lane provenance](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746)
- #371's own [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37384903308/job/112015666097), [CodeQL JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37384903312/job/112015666730), and [CodeQL actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37384903312/job/112015666389) checks are green at the reviewed head.
- #377's own [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37384923714/job/112015734821) check is green at the reviewed head; the new different-key repeated-reply probe supplies the missing evidence.
- #371 source review covered server-ordered inbox rows, counterpart/client navigation, validated API payloads, pin/mute route contracts and failure outcomes, feature-flag fallback, account-boundary cache clearing, and every empty-payload realtime signal. [Posted review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6005559782)
- #377 source review covered both thread screens, ordinary send outcomes, author-side mapping, reply quotes, read-up-to, edit/delete/pin/mute routes, and shared menus/hooks against backend reference `cb986a4cba16036ccd4ed11158b849eb1df0292e`. [Posted review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022)
- Operator 121's fixes correctly make empty public-channel events refresh signals without trusting thread ids in the current payload. [#371 FIX](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6004786539) [#377 FIX](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6004786751)
- PR sizes are 1,381 and 1,492 changed lines; #377 has only eight lines of headroom under the 1,500-line cap. [#371 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6005559782) [#377 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022)

## Saved files and operating notes

Under `/home/user/workspace/ops/aud-122/AUD-SOL-MSG1-122/`:
- `verdict-371.md`
- `verdict-377.md`
- `377-normal-send-probe.patch` — reusable failing-before screen probe.
- `377-normal-send-ci.log` — complete downloaded targeted job log.
- `377-normal-send-ci-run.json` — run metadata/provenance.

No local npm, Jest, tsc, eslint, or build was run. No PR branch or repository checkout was changed; no merge, deploy, production access, or flag change occurred. Only the allowed throwaway mobile CI branch was pushed and subsequently deleted. Both clean detached worktrees were removed after preserving the probe and evidence. No locks held; exact-head claim markers retained as completed audit records.

For tools: `gh run view --json jobs` hit an unauthenticated API rate limit; authenticated `gh api` REST succeeded. Job logs required `--allow-escape-sequences`. Use `gh api -F body=@file`, not `-f`, for comment-file payloads; the #371 comment was corrected immediately and the final body verified.

## HANDOFF

- #371 is APPROVE from Sol at the exact head above; normal operator dual-lens/green-check rules still apply. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/371#issuecomment-6005559782)
- #377 requires only **B-377-1** fixed before Sol approval. Recommended default: add UUID-confirmed reconciliation, carry the failing-before probe into a compact regression, and split if needed rather than exceed the 1,500-line size cap. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/377#issuecomment-6005613022)
- No new Cs, no pending lane, no active worktree, no audit branch, and no held lock. A fresh Sol lens should delta-review the B fix and changed lines only, using the saved probe and [failing-before run](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37389419746).
