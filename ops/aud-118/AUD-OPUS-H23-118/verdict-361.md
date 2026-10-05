AUDIT Claude Opus 5.5 — growth-project-mobile#361 @ 574b32a8ab9f2c36986c160de257340fa71cfe52 — VERDICT: APPROVE

A/B/C = 0/0/2

Job AUD-OPUS-H23-118 (agent 118 wave). Tier T4: health data and on-device authorization, by the max-tier rule. This is the first verdict from this lens on the split piece. I made no push, merge, dispatch, build or production action.

### Prior findings
- **No finding is open on #361.** Neither lens posted a verdict at the earlier head `85b2439b`.
- **This lens on #317:** every finding whose code lives in this piece is closed:
  - B-317-5: Not syncing here, `isConnectedButNotSyncingHere`;
  - C-317-4: disconnect confirm;
  - the B-317-2 truthful partial import copy;
  - the C-317-6 release order. That is an operator gate, not code.
- **Sol on #317:** B-317-12 sits in #364's file.

### Evidence reuse (G09)
- **Byte-identity:** all 10 blobs at `574b32a8` equal #317 @ `d0407b62` (checked with `git rev-parse` per path). This lens approved those bytes on the #317 T4 chain: `58c2d53f`, `cf387e88`, `cfa99ce3`, `7174daa8`, `82137c31`, and the merge-only APPROVE at `d0407b62`.
- **Restack delta:** `85b2439b..574b32a8` is one merge commit.
  - It is pure: `git merge-tree 85b2439b fde1875` gives `cec8f30a`, which equals the head tree.
  - Its patch-id (`6a54d1b7`) equals #360's `4a508d8b..fde1875`, so it carries only the B-360-1 fix, audited in my #360 verdict.
- **Re-read anyway:** the whole piece was re-read for the boundary and for this job's areas (copy truth, permission truth, fences, logs).

### Piece boundary
- **Inert at this tree.** `onDeviceSync`, `onDeviceCopy`, `disconnectCopy` and `DisconnectConfirmDialog` have no app importer (`git grep`, excluding tests).
- **AI flag.** `featureFlags.wearableAiInsights` defaults to `false` unconditionally, is registered in `expected-env.json`, and has no reader here.
- **Sign-out wiring.** The sign-out sweep (`ON_DEVICE_STATE_PREFIX`) and `stopOnDeviceHealthWork()` in `authActions.ts` arrive in #362, together with the first caller (both are present at `439937c9`).
- **Dependency direction.** No import from a later piece; tsc is green at this head.
- **Docs.** Only the clinic profile name appears; the partner is not named.

### Identity, fence and permission truth (`onDeviceSync.ts`)
- **`connectOnDevice` (`:234-259`).**
  - The fence comes from the tap.
  - `assertCurrent` runs before register, again after it, and before `recordLocalAuthorization`.
  - The scope user is `fence.userId`, and a session stop is rethrown untouched.
- **`refreshOnDevice` (`:305-323`).** It takes its own fence before the user read. It reads nothing unless all of these hold:
  - a local authorization exists for that user and source;
  - the same connection id is in the server list;
  - that connection is `connected`.
  - Account B therefore never uses A's grant (`onDeviceSync.test.ts:297-375`).
- **`resumeOnDeviceImport` (`:266-277`).** It requires the same person and the same connection. `runSyncPasses` re-asserts between passes and is bounded at 3.
- **Body.** No `userId` is sent.

### Copy truth (`onDeviceCopy.ts`, `disconnectCopy.ts`)
- **Coded failures.** Every failure maps status and machine code (`codeOf` is pattern-bounded, `:74-80`) to what happened plus a working action:
  - session changed; signed out;
  - Health Connect off → Open Health Connect; not ready;
  - network, 401, 403 (with and without `wearables_connection_forbidden`), 429;
  - permission `denied`, `unavailable`, `update_required`, `unsupported`, `error`;
  - an empty first import says where to check.
- **Unknown failures.** These get an 8-character reference, the one support address and `reportUnexpected` with `{status, code, requestId}` only. No message text or health value is copied into copy or reports.
- **Claims match behaviour.**
  - "continues each time you open Health" matches the refresh path.
  - The disconnect copy matches the backend soft-disconnect: data already shared stays with the coach.
  - The guard test in `onDeviceCopy.test.ts:176-222` enforces no we/us/our. There are no exclamation marks or emojis.

### CI and size
- **CI.** Typecheck, lint, test is SUCCESS at this exact head ([run 37179972056](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37179972056/job/111370379760)): tsc, eslint, and jest with 451 suites / 6,418 tests. `onDeviceSync`, `onDeviceCopy` and the 3 H2 suites pass in the log.
  - Analyze runs only on PRs based on main.
- **Size.** 10 files, +1,782/−11 = 1,793 lines. I agree with KEEP.

### C-361-1 (optional; device gate): VoiceOver cannot reach Disconnect in `DisconnectConfirmDialog`
- **Where:** `DisconnectConfirmDialog.tsx:44-50`.
  - The backdrop `Pressable` (role button, label "Cancel, keep <name> connected") wraps the card, the body text and both buttons.
  - `Pressable` defaults to `accessible: true` (RN 0.85 `Pressable.js:252`). On iOS that is `isAccessibilityElement`, and per the [React Native accessibility docs](https://reactnative.dev/docs/accessibility), VoiceOver disallows nested accessibility elements.
- **Counterexample (by platform semantics; not provable in jest, because RNTL does not model grouping):**
  1. With VoiceOver on, tap Disconnect on a row.
  2. Swiping finds one element, "Cancel, keep Apple Health connected".
  3. The title, body and Disconnect button are unreachable, so a VoiceOver user cannot stop sharing from the app.
- **Same pattern on main:** `ConnectProviderSheet.tsx:203-210` and `MessageActionSheet.tsx:92-93`. It is not introduced by this stack.
- **Fix rule:**
  - Render the backdrop as a sibling (`StyleSheet.absoluteFill`) with `accessible={false}`.
  - Make the card a plain `View` with `accessibilityViewIsModal`.
  - Keep dismissal through `onRequestClose` and `onAccessibilityEscape`.
- **Verify:** a structure test (no accessible ancestor of the two buttons), plus VoiceOver and TalkBack in the device pass. A cross-cutting a11y follow-up should cover all three components.

### C-361-2 (optional; outside this diff): the reference quoted to support is not searchable in Sentry
- **Where:** `src/lib/consultation/report.ts:17-22` on main sends `requestId` as the extra `request_id`. Extras are not indexed. Only `context.reference` becomes the searchable `reference` tag (`sentry.ts:149-152`, B-326-4).
  - `onDeviceCopy.ts:200-206,226-228` and `disconnectCopy.ts:99-105` mint a fresh id for local failures and tell the person to "mention the reference".
- **Counterexample:** a `native_permission_error` shows reference `ab12cd34`. Sentry search `reference:ab12cd34*` finds nothing, and no backend log holds a client-minted id.
- **Fix rule:** `reportUnexpected` passes `reference: info.requestId` to `captureError` (one line, all callers).
- **Verify:** a test that `captureError`'s context carries `reference`.

### For the operator (not this PR)
`useWearableConnections.ts:120` (`logger.warn(..., err)`, a raw AsyncStorage error) is in #362, not in #360 or #361.

### Landing
Land as one with #359, #360 and #362 to #364 (rule 11). No build or OTA may come from an intermediate tree.
