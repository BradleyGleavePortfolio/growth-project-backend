# AUD-SOL-H45-118 — Health Connect H4/H5 T4 audit

Operator: agent 118. Independent GPT-6.1 Sol lens. Completed at 2026-10-04 10:16:23 PDT (from `TZ=America/Los_Angeles date`).

## Published verdicts

Both exact heads and checks were re-read immediately before posting one verdict each. [H4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782); [H5 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986).

| PR | Exact head | Verdict | A/B/C | Exact-head required test job |
|---|---|---|---|---|
| #362 H4 | `439937c93ca8460aed23daef116aa49e7127efa3` | [REQUEST CHANGES](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782) | 0/4/1 | [SUCCESS: 453 suites / 6,482 tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179972912/job/111370381908) |
| #363 H5 | `38ea0f81fd88ea343ac2279097e8d24f08ef3cc5` | [APPROVE](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986) | 0/0/1 | [SUCCESS: 456 suites / 6,528 tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179973860/job/111370384670) |

## Mandatory findings and replay

The independent probe executed at `08b7e93dbc49a9dd300c161e19a7988c399921f6`, parent `24f36f0af312975e7c95633b364e2753e95961e7`, based on exact H4 plus two test-only specs and the CI-lane harness: **5 invariant assertions failed, 2 controls passed**, no setup failure. [Executed job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

| ID | File:line | Proven counterexample | Minimal fix rule / verification |
|---|---|---|---|
| B-362-1 | `src/hooks/useWearableConnections.ts:118-120` | Error and plain-object storage rejections containing a synthetic private fragment reach the logger unchanged; 2 failing assertions. | Closed fixed class only, no raw error/message/name/key; fence stale-session reporting; both rejection-shape assertions must pass. |
| B-362-2 | `src/hooks/useWearableConnections.ts:112-126` | Hold A's disconnect response; switch to B and emit login; write B's new grant; release A success; B grant is removed. | Carry originating user/auth generation through disconnect; suppress stale continuation writes, invalidation and reporting; retirement targets the intended consent scope and must not delete a newer authorization. Preserve B grant in the deferred-response test. |
| B-362-3 | `src/hooks/useWearableConnections.ts:113-126` | Hold real Health Connect page 1; complete disconnect and confirm local grant absent; release page 1 with token; page 2 still starts (expected 1 call, got 2). | Synchronously stop relevant live health runs before cleanup awaits/completion; no subsequent native page/type, ingest request or progress write; disconnected case must stop at 1 call, unchanged-connected control must still reach 2. |
| B-362-4 | `ConnectProviderSheet.tsx:295-300`; `ConnectionsScreen.tsx:416-420` | Actual parent wires `onConnected=closeSheet`; complete zero-sample first import hides the explanation/recovery sheet; five-sample success control closes correctly. | Separate notification from dismissal or defer closing notification for empty first import; retain visible guidance plus Close/Open Health Connect and test the real parent/sheet on both platforms. |

All four findings and their source boundaries are in the published H4 verdict, with the same executed CI reference per finding. [Detailed H4 findings](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782).

The logger proof is a boundary counterexample, not evidence of a production transport, and the held-page proof is a newly-started read after completed disconnect, not a demand to cancel an already-open OS request or a claim that the server accepted a disconnected ingest. [Evidence limits](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782).

The targeted job also emits a worker-teardown warning after executing all seven tests; it is preserved, not used to relabel named assertion failures as infrastructure noise. [Probe log](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219439582/job/111486604765).

## Prior findings, G09 and piece boundaries

- Read the binding lane/job/routing/rules and prior original-PR comments; all 21 H4 paths and all three H5 paths have identical blobs to original Sol-approved `82137c312e957cb05eedeaebf86fcd95029f2bde`, and the full own-piece diffs were independently read. [Original approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972055787); [H4 reuse decision](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782); [H5 reuse decision](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986).
- Retained A-317-1/B-317-1/2/5/6/7/8/9/10/11 closures are scoped to their reported account-switch, progress, incomplete-history, reconnect, **sign-out** stop and stale-completion cases; the new disconnect and real-parent counterexamples narrow the earlier blanket inference, not the already-executed closures. [Closure dispositions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782).
- Original B-317-12 is H6's config-test integration finding and is not reissued on H4/H5; no new H2/H3 finding is attributed to this job. [Original config finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972176395); [H2/H3 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982441393).
- Both restacks change only H2's four B-360-1 repair paths, with no own-piece blob changes or conflict hunks; rule 12 does not exempt these restacks, so both received new exact-head verdicts. [H4 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5976975911); [H5 restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5976976095).
- H4 imports only existing/lower-piece dependencies and adds no package/config/migration/CI-gate edit; H5 is test-only with actual lower-piece call-site composition, and its approval does not waive H4 findings. [H4 boundary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782); [H5 boundary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986).
- Size: H4 **2,284** changed lines (source 1,082 / tests 1,202), operator KEEP already recorded; H5 **982** test lines, both under 3,000 with no exclusions. [KEEP assessment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5975773360); [H5 size](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986).

## Evidence and workspace

Preserved at `/home/user/workspace/ops/aud-118/AUD-SOL-H45-118/`:
- `comments{317,362,363}.json`; `verdict-{362,363}.md`; `posted-{362,363}.json`; `final-state-{362,363}.json`.
- `ci{362,363}.log`; `probe362.log`; `probe-run.json`; `size{362,363}.tsv`.
- `362-piece.diff`, `363-piece.diff`, both restack diffs, and both empty `*-reused-paths.diff` blob-equality proofs.
- `useWearableConnections.sol118.test.tsx` and `ConnectionsScreen.sol118.test.tsx` (the executed independent test sources).

Own audit-only remote/local branch `audit/AUD-SOL-H45-118/362-boundaries` was deleted after publication; detached worktrees and evidence files remain on disk for the builder/operator, and no PR branch or production source was written. [Test-only executed commit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/08b7e93dbc49a9dd300c161e19a7988c399921f6).

## Follow-ups (C)

- **C-362-5:** `src/screens/client/wearables/HealthFitnessScreen.tsx:147-156,207-209,265-287,312-318`: independent resting-heart-rate data does not participate in empty/loading/error/refresh state; RHR-only data is hidden, and a secondary-only failure is not retried by the primary refresh. [Published C finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782). Fix rule: incorporate RHR in meaningful-data detection and bounded secondary failure/stale/loading presentation, refetch both queries, add RHR-only and secondary-error tests.
- **C-363-1:** `src/screens/client/wearables/__tests__/ConnectProviderSheet.attemptFence.test.tsx:150-151`: Health Connect double returns `postedCount` instead of `normalizedCount`, causing a NaN positive-control count. [Published C finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986). Fix rule: return `{ normalizedCount: 4, complete: true }`, type the sync double/fixture and retain unchanged-attempt and all cancellation assertions.
- Freeze default: ticket these two Cs separately rather than broadening the A/B repair round; H2's ruled late-data/resumable-import follow-ups still complete before the clinic Android build. [H2/H3 follow-up disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982441393).

## Operator decisions and recommended defaults

- Route one H4 builder round to close B-362-1..4, replay both audit specs, restack H5/H6 under the wear lock, and obtain fresh dual exact-head verdicts after the changed heads; do not treat H5 test-only approval as stack acceptance. [H4 must-fix verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782); [H5 scope limitation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986).
- Preserve land-as-one/off-flag sequencing and require integrated main-based Analyze checks at landing: both Analyze checks are absent, not successful, on these stacked heads; native/device, Play declarations and the separate release flag step remain operator gates. [Landing limits](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782).

## HANDOFF
- #362 `439937c93ca8460aed23daef116aa49e7127efa3`: REQUEST CHANGES **0/4/1**, required Typecheck/lint/test green, independent targeted probe red **5 invariant failures / 2 controls passing**; builder repairs four Bs, replay evidence above and restack, then fresh dual audit. [Final H4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782).
- #363 `38ea0f81fd88ea343ac2279097e8d24f08ef3cc5`: APPROVE **0/0/1** for its own test-only diff, required test job green; new lower-piece fix restacks require a new exact-head delta, and no partial tree ships. [Final H5 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986).
- Job complete; no own audit branch remains, no lock held, evidence and worktrees retained, no merge/build/deploy/production action taken.
