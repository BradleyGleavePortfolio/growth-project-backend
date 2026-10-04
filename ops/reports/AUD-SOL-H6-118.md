# AUD-SOL-H6-118 — Health Connect H6 independent Sol audit

## Scope and status
- Operator: agent 118; one verdict for mobile #364 at `a3206441d57ea51130490e6e54cc8228bff40687`.
- Claimed `ops/lanes118/claims/mobile-364-a3206441-sol`.
- T4: health data, permissions, account/session fences, integrated H1-H6 landing tree.
- Initial head confirmed; piece size 699 additions + 2,183 deletions = 2,882 lines; within hard cap, operator size assessment required.
- Initial stacked CI: Typecheck, lint, test succeeded; main-only checks not in initial rollup.
- Candidate: https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364
- Initial CI: https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179975081
- Completed: **REQUEST CHANGES; A/B/C = 0/1/1**, exactly one verdict, after immediately re-reading the assigned head, size and check rollup. ([Posted Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404))
- Publication time from `TZ=America/Los_Angeles date`: 2026-10-04 10:27:21 PDT; cleanup completed 10:28:02 PDT.

## Interim evidence and disposition
- Original Sol APPROVE `82137c312e957cb05eedeaebf86fcd95029f2bde` and later B-317-12 read; closure requires only the two clinic build-switch test pins, now fixed with exact-head PR CI success. ([Prior approval](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972055787), [prior config finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972176395), [current restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5976976245))
- H6 19-path full diff read, including every deleted Samsung client/normalizer/sync/type/hook and their tests; `h6.diff` and `h6-blob-evidence.tsv` preserve per-path identity evidence. Surviving H6 paths except main's inherited configuration and clinic test pins are identical to prior Sol-approved source; all deleted paths were absent at that approval. ([Original approved tree](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/82137c312e957cb05eedeaebf86fcd95029f2bde), [current top](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/a3206441d57ea51130490e6e54cc8228bff40687))
- Backend production-source contract at `643817b3586e27ad95cc3c519733fc14d0aaafde` has the same strict schema, array shape, JWT-derived subject, connection/provider ownership gate and shared fixture digest `3c8701f9f9f592a188115bb6eea63b0417d38eba306d238465ac02de51579cfb`; this is source compatibility, not a live ingest or device acceptance claim. ([Production-source commit](https://github.com/BradleyGleavePortfolio/growth-project-backend/commit/643817b3586e27ad95cc3c519733fc14d0aaafde), [mobile shared-contract candidate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/a3206441d57ea51130490e6e54cc8228bff40687))
- H2 B-360-1 repair independently re-read; same-model exact-head H2 replay already executes 56 tests successfully, with repair byte-preserved at H6. ([Same-model H2 disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/360#issuecomment-5982441210), [independent replay](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219225833/job/111485969669))
- Existing H4 B-362-1..4 remain assigned to #362; not reissued as new H6 findings. Integrated stack cannot land while they remain open. ([H4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782))
- New H6 retirement compatibility probe executes the actual row builder, local authorization, refresh orchestrator and disconnect mutation with synthetic legacy Samsung state and supported Health Connect controls; candidate unchanged. Exact execution `b65fc4558da2bc6c8b66bc15e33d84ea398cb54d`, parent test-only `8d6b966c6b87a02b6039aad692a1b609984ce845`, differs from candidate only by the probe and two lane harness files. ([Execution commit](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/b65fc4558da2bc6c8b66bc15e33d84ea398cb54d))
- Executed probe proves three Samsung compatibility invariant failures and two supported-flow controls pass; the five existing ingest-contract cases also pass, total **3 failed / 7 passed, 2 suites**. Worker-teardown warning retained; not a setup/infra failure or a claim of production transport/device execution. ([Executed job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220265977/job/111489000073))

## B-364-1 — incomplete Samsung retirement compatibility

**Locations:** H6-deleted `src/services/health/samsungHealth/{samsungHealthClient,samsungHealthSyncService}.ts`; retained `src/api/wearablesConnectionsApi.ts:47-54,156-162`, `ConnectionsScreen.tsx:164-174`, `onDeviceSync.ts:61-64,314-319`, and `useWearableConnections.ts:112-126`. ([Exact candidate tree](https://github.com/BradleyGleavePortfolio/growth-project-mobile/commit/a3206441d57ea51130490e6e54cc8228bff40687))

**Invariant:** retired Samsung identifiers cannot independently appear active/connectable while their replacement Connect creates a different provider, status and Disconnect authority. This is H6's retirement compatibility boundary, not a claim that every retained line was introduced here. ([Published finding and attribution](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404))

**Counterexamples:**
1. Legacy `SAMSUNG_HEALTH/connected` + no local Health Connect grant: row remains `connected`, while actual supported refresh is `not_authorized` and starts no sync. ([Failing legacy assertion](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220265977/job/111489000073))
2. Samsung Connect maps to/records/imports `HEALTH_CONNECT`; returned authoritative rows show Health Connect connected, Samsung disconnected. ([Failing post-Connect assertion](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220265977/job/111489000073))
3. With legacy Samsung and replacement Health Connect rows coexisting, successful Samsung Disconnect leaves the replacement local grant and refresh `imported`, contrary to the categorical Samsung-stop copy; paired Health Connect Disconnect retires that grant and refresh does not run. ([Failing provider-identity assertion and passing control](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220265977/job/111489000073))

**Minimal fix rule:** one canonical provider authority; retain old enum only for compatibility/history, present obsolete rows truthfully with an explicit Health Connect replacement path, retire independent Samsung Connect and misleading permission/Disconnect claims, preserve historical samples, require fresh local consent, never silently inherit Samsung consent or blindly revoke separate Health Connect consent.

**Verification:** legacy connected/error/disconnected, replacement Connect, coexistence, Disconnect/reinstall/account switch; assert rows/actions/copy match actual read source and no retired identifier independently prompts/reads. Adapt the saved failing-before assertions to explicit retirement UX rather than mechanically deleting unrelated Health Connect consent. ([Published verification scope](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404))

## CI and current exact-head state

- #364 head `a3206441d57ea51130490e6e54cc8228bff40687`; base H5 `38ea0f81fd88ea343ac2279097e8d24f08ef3cc5`; OPEN, +699/-2,183 = **2,882**, no exclusions, existing KEEP assessment. ([Current restack](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5976976245), [KEEP assessment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5975773365))
- Exact-head Typecheck, lint, test SUCCESS, **454 suites / 6,493 tests**; direct log fetched and read, including clinic guard and ingest-contract passes. ([Exact-head job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179975081/job/111370387887))
- Both Analyze checks absent on stacked base; main-based integrated required checks remain a landing gate, never labeled successful here. ([Applicability record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5976976245))
- Final head/check reread JSON in `final-state-364.json`; exact outbound verdict preserved as `verdict-364.md`, response in `posted-364.json`. ([Published exact-head verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404))

## Integrated-top disposition and operator defaults

- Integrated landing is not accepted: H6 B-364-1 plus existing H4 B-362-1..4 remain open, with H4 findings assigned to #362 and not duplicated/count-added here. ([H6 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404), [H4 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/362#issuecomment-5982471782))
- Recommended default: route the Samsung compatibility repair to the retirement boundary's builder, coordinate with H4 fixes, keep every piece under 3,000 (split another compatibility piece if needed), replay both model lenses' saved probes, restack under the wear lock, and obtain fresh dual exact-head attestations.
- Preserve H1–H6 land-as-one, off-flag / no intermediate build-or-OTA sequencing, integrated main-based checks, separate release flag authorization, native/device and Play acceptance; the prior late-data/resumable-import follow-ups complete before the clinic Android build. ([Landing/release rule](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5975773365), [existing follow-up disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982441393))

## Follow-ups (C)

- **C-364-2 (outside this diff):** `docs/mobile/HEALTH_NATIVE_MODULES.md:20-22,32,159` still describes/recommends the Samsung Sensor SDK permission and active on-watch path, contradicting the document's removal note and H6's unconditional blocks/deleted implementation. Fix rule: replace active instructions with actual Health Connect-only behavior and label historical configuration descriptions as historical; ticket separately under the freeze. ([Published C finding](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404))
- Existing C-360-1/2 and C-362-5/C-363-1 remain in their prior owners' reports/verdicts, not new H6 count additions. ([H2/H3 follow-ups](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/361#issuecomment-5982441393), [H4/H5 finding disposition](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/363#issuecomment-5982471986))

## Retained evidence and cleanup

Evidence directory: `/home/user/workspace/ops/aud-118/AUD-SOL-H6-118/`.
- `pr{317,364}-comments.json`, `h6.diff`, `h6-blob-evidence.tsv`.
- `audit364.samsungRetirement.test.tsx`, `probe364-samsung.log`, `probe-run-page.html`, `probe-execution-commit.txt`.
- `pr364-ci-job.log`, `verdict-364.md`, `final-state-364.json`, `posted-364.json`.
- Own remote/local audit branch deleted; worktree retained, detached at test-only `8d6b966c`, clean. No candidate source/PR branch edit, heavy local test, production action, merge, deploy or build.

## Plan
1. Read prior Sol findings and builder closure evidence on #364 and original #317.
2. Read H6 full diff and integrated call paths, paying particular attention to Samsung connection retirement and deployed backend ingest compatibility.
3. Run adversarial probes only through the CI lane if required.
4. Re-read exact head and checks, post one exact-head verdict, then leave complete handoff.

## HANDOFF
#364 `a3206441d57ea51130490e6e54cc8228bff40687`: **REQUEST CHANGES, A/B/C 0/1/1**, exact-head PR test CI green, independent Samsung proof red **3 invariant failures / 2 controls pass**, contract suite **5/5 pass**. ([Posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/364#issuecomment-5982566404), [failing-before job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220265977/job/111489000073))

Operator next: repair B-364-1 and existing H4 blockers in their proper boundaries, replay probes, restack and request new exact-head dual audits; ticket C-364-2 separately. No active run/lock/own audit branch remains; report, logs and test-only worktree preserved. End this lens now.
