AUDIT Claude Opus 5.5 — growth-project-mobile#345 @ ed29833cb2d5c597f0be3a557877bd3cf29d85a3 — VERDICT: APPROVE
A/B/C = 0/0/1

Agent 120, job AUD-OPUS-W12D-120 (Opus lens), T4 (package money setup, Connect onboarding). Delta audit since my last APPROVE at `97c9005e644ebc13731d1477bfecc270a10552fd` ([5983832209](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5983832209)), for FIX ROUND 2 ([5985295618](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/345#issuecomment-5985295618)).

**Evidence reuse (G09):** every W1 line except the delta is byte-identical to the head I approved (`git diff 97c9005e ed29833c` touches only `src/lib/coachSetup/packageCreateIntent.ts` and two test files). That approval covered the full piece, so it carries over for the unchanged lines. I read every changed line, traced every caller of `createPackageOnce` (wizard `FirstPackageForm` in W2, editor `CoachPackageEditScreen` in W3) and the sign-out wipe path (`authActions.signOut`, `clearAllStorage`, `AsyncStorageShim.clearNamespace`).

**Head and checks:** base main, behind main `cc4ceeed`. The newer main commits touch only account-deletion, sign-up notice and auth-failure files; none overlaps this PR. Size: +2,719 / -7 = 2,726. The PR is grandfathered and under its 3,000 ceiling. Required checks are green at this exact head: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37241093788/job/111549802299), [Analyze js-ts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37241093835/job/111549802010), [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37241093835/job/111549802255), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/runs/111549908855).

**Probe:** in [CI lane run 37342580875](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342580875), this head plus `src/lib/coachSetup/__tests__/audOpusW12D_120_345.test.ts` (new, never merge) and my replayed W12-119 probe. The new probe runs on the real prefs storage shim over the AsyncStorage jest mock, so the sign-out wipe path is the real one. The lane ran 40/40, covering the builder's `w1FixRound118`/`w1FixRound119` and `connectCopyStates`, my W12-119 probe (6/6) and the new probe (6/6). For comparison, [run 37343369828](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37343369828) ran the same probe at the approved head. Four cases fail there, for the expected product reason: the retired write-ahead was removed. The two controls pass.

### The change (B-345-1, Sol)
At `packageCreateIntent.ts:363-374`, a create that is retired while its fresh write-ahead is saving now throws `PackageCreateStoppedError` and leaves the written intent on disk. Before this fix it cleared that intent.

This is the correct conservative rule. Once the value is in storage, a replacement form of the same account can read it and send its key, so the retired create cannot prove the key unsent. Keeping the intent can only replay that same key and body: the backend dedupes per key, and keys never expire. The doc comments at `:286-293` and `:180-184` now match the behaviour.

### Verified by the probe at this head
- **Retired after the save completed:** no request goes out. The exact key and body stay on disk. A live retry from the same account sends that key once, and exactly one package exists.
- **Retired while the save failed:** the create stops with `PackageCreateStoppedError`, not `IntentStorageError` (the retirement check comes first at `:365`). Nothing is sent and nothing is on disk.
- **Earlier intent refused with changed details (400), then retired during the fresh save:** the refused key is sent once and never again. The fresh intent stays, and the next live run sends the fresh key once, giving one package.
- **Sign-out wipe issued after the retired write:** the wipe removes the intent. This is the ordering the new comment relies on.
- **Scope isolation:** a kept wizard intent never appears in the editor scope or under another account.

### Callers
- **Editor:** `CoachPackageEditScreen.tsx:261` (W3) calls `createPackageOnce` without `isLive`, so the retirement branch never runs there. This head does not change editor behaviour. The missing `isLive` is an existing W3 item.
- **Wizard:** in `FirstPackageForm` (W2), a kept intent is hydrated on the next mount and shown with the existing "saved on this device" note. That note is truthful.

### C-345-7: a narrow window leaves the intent on the device after sign-out, and the new comment claims it cannot happen
- **Where:** `src/lib/coachSetup/packageCreateIntent.ts:366-372`. The comment says "Sign-out still wipes it: ... this write was issued first."
- **What it misses:** `signOut` reads the prefs keys once, inside `clearAllStorage()` (`src/services/authActions.ts:379`, `src/storage/mmkv.ts:133-137`). It emits `logout` only after that wipe and `settleAndClearQueryCache()` (`authActions.ts:423-425`), and `useCurrentUser` drops the account only on `logout` (`src/hooks/useCurrentUser.ts:87-90`). So retirement comes after the wipe, and the write is not guaranteed to come first.
- **Counterexample:** a write-ahead is issued after the wipe has read the keys, but completes after the `logout` re-render (slow storage or a long settle). It sees the retirement, is kept, and survives the sign-out.
- **Probe:** the observe case "a wipe that enumerated keys before the retired write..." passes at this head and fails at `97c9005e`, where the cleanup removed the intent.
- **Why C:**
  - The window needs a create in flight at the moment of sign-out.
  - The residue is the same coach's own unsent package details under that coach's own key. Another account never reads it, and the same coach would only replay the same create.
  - No money moves, and no client data is involved.
  - The same class of residue already exists on the live path at the old head: any intent write (a write-ahead or a `remember`) issued after the wipe reads the keys survives it.
- **Fix rule:** either narrow the comment to "a sign-out wipe that starts after this write removes it", or (preferred) make sign-out fence package-intent writes the way `purgeConsultationDraft` fences its writer: refuse `saveIntent` for a retired account, drain, then delete the `coachSetup.packageCreate.v1:<id>` and `coachPackages.editorCreate.v1:<id>` keys.
- **Verify:** the observe case above must fail, and the existing B-345-1 cases must still pass.

### Prior Opus findings
B-345-1 (cadence), B-329-5 (helper), and C-345-1/2/3 remain closed. Nothing in the delta touches those lines. C-345-4, C-345-5 and C-345-6 are still open follow-ups: they are outside this frozen round, and the operator holds them.

### Money list (delta)
- **Webhooks:** none.
- **Concurrency:** a retired create never removes an identity, so whichever form sends the key, every later retry re-sends it.
- **Terminal states:** archived or removed packages are handled in W2 and unchanged.
- **Pagination:** no list read.
- **Currency:** USD, integer cents, unchanged.
- **Copy:** no change.

Land rule unchanged: #345-#351 land as one unit, after the coach backend deploys.
