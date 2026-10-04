AUDIT Claude Opus 5.5 — growth-project-mobile#362 @ 439937c93ca8460aed23daef116aa49e7127efa3 — VERDICT: REQUEST CHANGES

A/B/C = 0/2/4

Lens AUD-OPUS-H45-118 (agent 118). Tier T4 (health data; max-tier rule, split piece H4 of #317). Independent of every builder; I did not read the Sol lens's work at this head.

**Scope read.** I read the whole piece diff `574b32a8..439937c9` (21 files, +2,140/-144) line by line, and the H1-H3 code it calls (`onDeviceSync.ts`, `sessionFence.ts`, `onDeviceState.ts`, `onDeviceCopy.ts`, `disconnectCopy.ts`, `healthConnectSyncService.ts`), and the backend contract it depends on on backend main (`connections.service.ts` register/disconnect, `wearable-samples.controller.ts` ingest ownership and status check).

**Evidence reuse (G09), my decision.** All 21 files are byte-identical (blob ids) to #317 @ `d0407b62`, where this lens approved ([5972163241](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/317#issuecomment-5972163241)). I used that only for line history. I did not rest the verdict on it: this is the first verdict on the piece at T4, so I audited it in full. B-362-1 and B-362-2 below were already in #317 and this lens missed them there. The only change from the old head `61cb0fac` is the #360 B-360-1 merge (base files only). I checked that it fits this piece: the new HealthKit `'stopped'` outcome is handled at `ConnectProviderSheet.tsx:407-416` (a stale attempt returns at :406; a live one shows the session-change copy).

**Piece boundary.** The piece compiles alone ("Typecheck, lint, test" green at this head, [run 37179972912](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179972912/job/111370381908)). It imports nothing from #363 or #364, and its tests come with it. Size: 2,284 lines, under 3,000 (operator SIZE ASSESSMENT: KEEP). Analyze runs only on main-based PRs.

**What holds.** Identity fences across sign-out and account switch hold in every path I traced:
- Sheet: epoch plus fence plus auth generation, captured before the first await.
- Shell refresh: generation plus run id plus mount check, and `refreshOnDevice` runs its own fence.
- `useLocalOnDeviceAuthorization` reads app storage only. The query cache is settled and cleared in `signOut()` before `logout` is emitted.
- `signOut()` stops on-device work on its first line and removes `wearables_on_device:*` and the legacy cursors.

Logs from this piece carry a closed class only (`WearablesShell.tsx:170`), except C-362-1. Sentry gets status, code and reference only (through `onDeviceCopy`/`disconnectCopy`). The coach prompts route is gated by both the build flag and the server flag. No partner name appears anywhere in the diff.

### B-362-1 — An empty first import never shows its message in the real app; the sheet closes as if data arrived
- **Where:** `src/screens/client/wearables/ConnectProviderSheet.tsx:295-300` (`handleImportOutcome`: `onConnected?.()` runs before `showMessage(emptyImportMessage(...))`). The only host passes `onConnected={closeSheet}` (`src/screens/client/wearables/ConnectionsScreen.tsx:416-421`).
- **What happens:**
  1. `closeSheet` sets `visible=false` and `provider=null`.
  2. The `[visible, provider]` effect clears the message.
  3. The Modal unmounts its content.
- **Why it matters:** "no data from the last 30 days ... open the Health app, tap your profile picture, then Apps ..." is never seen. On iPhone, this is exactly what turning every category off looks like, because HealthKit never reports a denial. So the main iOS denial path ends silently: the row says Connected, Health is empty, and nothing says where to check. This contradicts the S-WEAR-3 comment at :296-297.
- **Why the tests miss it:** the sheet test "a connect that found nothing to bring in says so ..." (`__tests__/ConnectProviderSheet.test.tsx:520`) renders the sheet without `onConnected`, and `ConnectionsScreen.test.tsx` mocks the sheet away.
- **Probe:** `audit/AUD-OPUS-H45-118/362-empty-import` renders the REAL ConnectionsScreen with the REAL sheet, wired as in production. [Run 37220060376](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220060376):
  - Control (complete import with data closes the sheet): passes.
  - "an empty first import keeps the sheet open and shows where to check": FAILS. `Unable to find an element with text: /no data from the last 30 days to bring in/`, and the rendered tree is the Connections list with the sheet gone.
  - The existing sheet and Connections suites pass in the same run.
- **Fix rule:** on the empty first-import path the sheet must stay open with the message and `Close`. Either do not call `onConnected` there, or give the host a non-closing notify. In both cases keep the invalidate and the tutorial signal.
- **Verify:** that probe, moved into the PR (host-level, real sheet), fails before and passes after. Also make sure no other `handleImportOutcome` path calls `onConnected` while meaning to stay open.

### B-362-2 — On the Health screen, "Then tap Try again" names a button that does not exist
- **Where:** `src/screens/client/wearables/WearablesShell.tsx:203-205` (`runNoticeAction('open_settings')` only opens Health Connect and leaves the notice unchanged) and :289-325 (one button, labelled from the action).
- **What happens:**
  1. A refresh that finds every Health Connect read permission off throws `HealthConnectPermissionDeniedError` (`healthConnectSyncService.ts:216-221`).
  2. The notice reads "... Tap Open Health Connect, choose App permissions, then The Growth Project, and allow access. Then tap Try again." (`onDeviceCopy.ts:136-141`).
  3. The only control is "Open Health Connect". After the person allows access and comes back, the same notice and the same single button remain. Nothing re-runs the refresh (it runs once per mount, with no foreground re-check), so the stated recovery cannot be completed on this screen.
  4. The boolean from `openHealthConnectPermissions()` is dropped, so a failure to open shows nothing. The sheet, by contrast, does both at `ConnectProviderSheet.tsx:442-453`.
- **Why it matters:** Android only. The clinic binary ships Health Connect on day 1, and turning access off in Health Connect is a normal user action.
- **Probe:** `audit/AUD-OPUS-H45-118/362-shell-settings`, [run 37220188407](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220188407):
  - The probe asserts that after pressing "Open Health Connect" a "Try again" control exists. It FAILS: `Unable to find an element with text: Try again`, and the tree shows the unchanged notice with only "Open Health Connect".
  - `WearablesShell.test.tsx` passes in the same run.
- **Fix rule:** after the settings or store app opens from the notice, switch the notice to return copy with a working Try again that re-runs the refresh. If the app did not open, show the "didn't open" copy. Every control named in notice copy must exist on this surface. A foreground (AppState) re-check is an optional extra.
- **Verify:** the probe above as a PR test, failing before and passing after.

### C (optional; ticket if not fixed in the same lines)
- **C-362-1** `src/hooks/useWearableConnections.ts:120` passes the raw `err` from `retireOnDeviceState` to `logger.warn`. Logger output is development-only and the error is a storage error, with no provider text and no health value, so it is not a B. The stack rule is a closed class only. **Fix rule:** log `{ error: refreshErrorClass(err) }` or a fixed code.
- **C-362-2** `WearablesShell.tsx:308-319`: for a 403 `wearables_connection_forbidden` refresh failure, the notice text says "Tap Continue to connect ... again." (`onDeviceCopy.ts:173-176`), but the button on this surface reads "Reconnect". **Fix rule:** surface-specific copy ("Tap Reconnect ...") or a matching label.
- **C-362-3** `useWearableConnections.ts:113-127`: Disconnect retires local state but does not stop an on-device run already in flight. The shell's refresh is also never cancelled on unmount (`WearablesShell.tsx:140-184`). A run started on Health keeps reading pages after the person confirms Disconnect, until the backend's disconnected-status 403 (`wearable-samples.controller.ts:289`) rejects the next batch. Health then shows "no longer linked". **Fix rule:** on a successful on-device disconnect, stop runs for that source (bump the generation or cancel source-scoped fences) before retiring state. Test: a refresh in flight plus Disconnect gives no further native read, ingest or progress write.
- **C-362-4 (outside this diff, made load-bearing here)** `src/api/wearablesConnectionsApi.ts:144-154`: the sheet body for Apple Health and Health Connect says "We'll read your activity, heart rate, workouts and sleep ..." This is first person, and it leaves out what is actually requested: weight, body fat, blood pressure, HRV, blood oxygen, respiratory rate and body temperature (`HEALTHKIT_READ_PERMISSIONS`, `HEALTH_CONNECT_RECORD_TYPES`). The OS screen lists every type, but this piece is the first place the app actually reads them. **Fix rule:** third-person copy naming every requested category, with a test pinning the copy to the permission lists. Before the flag flip.

**To clear this verdict.** Close B-362-1 and B-362-2 with code plus failing-before tests, either at the probe level or with the probe moved into the PR. Then a merge-only restack of #363 and #364, and a delta verdict from this lens at the new heads.
