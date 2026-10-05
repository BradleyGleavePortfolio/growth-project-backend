AUDIT Claude Opus 5.5 — growth-project-mobile#362 @ df44285d8b60a421277114601efa475744c5fac1 — VERDICT: APPROVE
A/B/C = 0/0/2 (new: C-362-12 rated, C-362-13)

Lens AUD-OPUS-H46E-119 (agent 119), T4 (health data). Short delta from my APPROVE at 73dbefbcbe97544710058dcab176ea8713654042 (AUD-OPUS-H46D-119).

**Delta read in full.** 73dbefbc..df44285d is one commit (df44285d) and one file: src/services/health/onDeviceState.ts, +30/-7. Every line read. Nothing else changed.

**My prior finding.** C-362-11 (Android AsyncStorage commit order is not JS call order) is CLOSED by code and test:
- One module-level chain, `serialStorage` (onDeviceState.ts:107-116). It carries the grant write (:138), the progress write (:257-259) and both removals (:185, :226).
- Grant reads (:147) and both retirement enumerations (:175, :206) wait for the tail first.
- The failing-before run is 37236494922 (5 fail / 13 pass at f62f1bbe + tests). The passing-after test is in #363.

**Queue correctness (scope of this delta).**
- **No deadlock.** No queued op awaits `storageTail` or calls back into this module. Ops are bare AsyncStorage calls. `retireOnDeviceSource` awaits the tail at :206 and again inside `getLocalAuthorization` at :147. Both waits are outside any queued op, so they cannot wait on themselves.
- **No stall on a rejected op.** The tail maps both settle paths to `undefined` (:111-114). The caller still receives the rejection through `run`.
  - Probe: a rejected grant write reaches its caller. The progress write behind it, the next read and the next removal all run.
  - Probe: a rejected progress write after a removal does not stop the next grant write.
- **No lost write.**
  - The sequence bump (:136-137) and the queueing (:138) run in the same tick.
  - In `retireOnDeviceSource`, the filter (:221-225) and the queueing of the removal (:226) run with no await between them.
  - So every Connect is in one of two cases:
    - (a) It bumped before the filter, so its key is excluded (seq > since).
    - (b) It bumped after the filter, so its native write is queued after the removal and commits after it.
  - Any write with seq <= since was queued before `since` was captured, so it settled before the enumeration at :211.
  - Probe: two overlapping Disconnects (owner and no-session) plus a Connect and a progress write during the first removal. maxInFlight = 1, the Connect and its progress survive, and the old progress is gone.
- **Read-after-write.** Probe: a grant read issued while a grant write is held waits for it, then returns the new grant.
- **Unbounded wait (observation, no finding).** A native op that never settles would stall every later write and every grant read. AsyncStorage 3.1.1 always settles each bridged promise, so this is accepted. It is not a rejected-op case.
- **No regression.** `getSyncProgress` does not wait for the tail. Each caller awaits its own `setSyncProgress` (healthConnectSyncService.ts:290, healthKitSyncService.ts:261), and progress keys carry the connection id. On iOS the queue adds ordering and changes nothing else.

**Probes (CI lane).**
- New probe: onDeviceState.opus119e (7 tests).
- At this head (exec b08ab28b): run https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37237814702. 12 suites pass, 129/129 tests.
  - It replays the opus119, opus119d, samsungRow.opus118 and the two H45 probes, plus onDeviceState, onDeviceSync, onDeviceConnect, healthConnectSyncService, authActions.signOut and useWearableConnections.disconnect.
  - The run is red only because 2 suites failed to load: hcPrivacyTemplate.opus119 and healthConnectRationale.opus118 import plugins/withHealthConnectPermissionDelegate, which lands in H6 #364. Both pass at the #364 top.
- At the #364 top: run 37237825184, 18/18 suites, 162/162 tests.

**Findings**
- **C-362-12** (rated C, pre-existing, outside this diff). src/services/authActions.ts:116 with :244 and :398: the sign-out prefix sweep runs outside the onDeviceState queue.
  - Counterexample: a grant write still in flight when the sweep runs commits after the sweep and survives. Probe "DOCUMENTS C-362-12" passes, so the grant survives. In the control, the queue drains first and nothing survives.
  - Why C, not B:
    - The key and the read are bound to the same userId (:71, :152), so no other account can use it.
    - The window opens only after the session fence at onDeviceSync.ts:251, and it needs a sign-out during one native write.
    - The same person had already granted OS permission and tapped Connect.
  - It still breaks the stated invariant at authActions.ts:115 ("must not be read again until someone taps Connect").
  - Fix rule: export `settleOnDeviceStorage()` (await the tail) from onDeviceState. In signOut, await it before `collectPrefixedKeys` (:244). The sign-out generation bump already stops new writes.
  - Verify: held setItem + signOut leaves no `wearables_on_device:` key.
- **C-362-13** (new, outside this diff; the fence is from 73dbefbc). onDeviceState.ts:136-138: `authWrittenAt` is credited before the native write and is not rolled back when the write rejects.
  - Counterexample: grant G1 is stored. A Disconnect captures `since`. A Connect's write of G2 rejects (for example, disk full). The Disconnect then keeps G1 and its progress, because seq > since.
  - Probe "DOCUMENTS C-362-13" passes, so G1 is kept.
  - It needs a storage failure during a Disconnect, and the server-side connection is already revoked.
  - Fix rule: on rejection, restore that key's previous `authWrittenAt` value if the stored value still equals this write's seq, then rethrow.
  - Verify: flip the probe's expectation to null.
- **Carried open (unchanged):** C-362-3 remainder, C-362-4, C-362-5, C-362-7, C-362-8, C-362-9, C-362-10.

**Evidence reuse (G09).** My APPROVE at 73dbefbc covers everything outside this one-file delta. The delta was audited line by line.

**Size.** 2,940 (grandfathered, 3,000 ceiling).

**CI.** "Typecheck, lint, test" is green at this head: run 37237093309. Analyze runs only on main-based PRs (H1-H6 land as one).
