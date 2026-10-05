AUDIT Claude Opus 5.5 — growth-project-mobile#346 @ 26cf23b7987c866615ab9a4b2f95a10e6e318f40 — VERDICT: APPROVE
A/B/C = 0/0/1

Agent 120, job AUD-OPUS-W12D-120 (Opus lens), T4. This is a delta audit since my last APPROVE at `2baea5b82a2d0e0a22bac21e8fdb5e074bec9d60` ([5983832366](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5983832366)), for FIX ROUND 2 ([5985325260](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/346#issuecomment-5985325260)).

**Evidence reuse (G09)**
- `git diff 2baea5b8 26cf23b7` touches one W2 source file, `src/components/coach/setup/FirstPackageForm.tsx`. The rest of the diff is the W1 merge `e9b4415e` (the B-345-1 delta, reviewed on #345 at `ed29833c`) and test files.
- Every other W2 line is byte-identical to the head I approved, so that full approval carries over for those lines.
- I read every changed line of the form and its two test files. I also re-traced the W3 caller (`CoachWizardNavigator.tsx:506-516` at #347): same props, no other writer.

**Head and checks**
- Base: the #345 branch at `ed29833c`.
- Size: +2,873 / -0 = 2,873. Grandfathered; under its 3,000 ceiling.
- Required check green at this exact head: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37241251692/job/111550251189). Analyze and CodeQL run only on the main-based piece and are not claimed here.

**Probe:** [CI lane run 37342606067](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37342606067) ran this head plus `src/components/coach/setup/__tests__/audOpusW12D_120_346.test.tsx` (new, never merge), the #345 probe, and my replayed W12-119 probes. Result: 80/80 across 11 suites:
- the builder's W1/W2 fix-round suites
- the builder's durability and idempotency suites
- my W12-119 #345 and #346 probes (6/6 and 5/5)
- the new probe (6/6)

The same new probe at the approved head (run 37343369828) fails 3 cases for the expected reason: no readiness, and the tap captured the defaults. The 3 controls pass.

### The change (B-346-3, Sol)
- **Readiness flag:** `ready` is false until this account's saved intent has been read and, if found, shown (`:144`, `:184`, `:207`). An unreadable read also ends hydration, and submit re-reads storage, failing closed.
- **One writer for the fields:** every field write goes through `show()` (`:134-140`), which writes the `shown` ref and the state together. The only writers are the account reset, the hydration and the four inputs, so the ref and the screen cannot drift apart.
- **Inputs locked until ready:** the inputs are `editable={ready}` and the segments are `disabled={!ready}`, with `accessibilityState.disabled` set (`:366`, `:385`, `:411`, `:430`).
- **Submit:** it no longer captures before an await. It waits for the current generation's hydration and loops if hydration restarted (`:242-248`), re-checks owner, mount and generation, and only then snapshots, validates and builds the input (`:249-265`). Create, update, publish and `onCreated` all come from that snapshot.

### Verified by the probe at this head
- **Account switch during hydration with a queued tap:** coach_1's tap sends nothing (no create, update or publish, no callback), and coach_1's saved intent stays on disk for coach_1. The coach_2 form shows its own defaults and no "resumed" note. A coach_2 tap makes and publishes one coach_2 package, never coach_1's.
- **Edits and toggles made before ready change nothing:** the price input is not editable and Free is disabled. After hydration the saved $99 one-time plan is shown and published as is, with no create, no update and `freeOnJoin: false`.
- **Two taps during hydration:** one publish and one `onCreated`.
- **Form closed during hydration with a queued tap:** nothing is sent and there is no callback.
- **Unreadable storage:** hydration ends and the fields become editable. The tap stops with "Your earlier package details could not be read" and sends nothing. After storage recovers, Try again makes exactly one package.
- **Account change while a tap waits:** handled by the generation check in `stillOwner` after each await. `finally` leaves `inFlight` and busy to the reset that the account change already made.

### C-346-7: Create stays enabled while hydrating, so a queued tap can finish a resumed package the coach has not seen
- **Where:** `src/components/coach/setup/FirstPackageForm.tsx:470-479` sets `disabled={busy}` only.
- **What happens:** a tap during the storage read waits for hydration, then publishes the saved package (probe observe case: `publishPackage("pkg_saved")` with the defaults never sent). The builder states this design in the fix round, and it matches the counterexample's expected outcome.
- **Why C:**
  - The saved package is one this coach already submitted.
  - The window is a local storage read.
  - The next wizard step names the package that went live.
  - The defaults are never sent.
- **Fix rule:** `disabled={busy || !ready}` with `accessibilityState.disabled` to match. A tap before ready then does nothing, and the coach always sees a resumed package before finishing it. Keep the hydration wait in `submit` as a backstop.
- **Verify:** the observe case flips: the button is disabled while hydrating, and a press there sends nothing.

### Prior Opus findings
- **Still closed:** B-346-1, the B-329-5 caller, C-346-2, and the GetPaidPanel part of C-346-1.
- **Still open, as follow-ups outside this frozen round:** C-346-4, C-346-5, C-346-6 and the rest of C-346-1 (checklist and invite async guards).
- **C-346-3 (land as one):** still applies.

### Copy and accessibility (delta)
- The one new line, "Checking this device for a package saved earlier.", is accurate. It shows only while the read runs and uses no first person or exclamation mark.
- Locked controls expose `disabled` to assistive technology.
- Optional: announce the end of hydration (the same follow-up as C-346-7).

### Money list (delta)
- **Webhooks:** none.
- **Concurrency:** single in-flight guard. Owner, mount and generation are re-checked after every await, including the new hydration wait.
- **Terminal states:** the archived or removed remembered package (C-346-2) is unchanged and runs on the snapshot.
- **Pagination:** no list.
- **Currency:** integer cents from the shown text. A saved price is re-shown via `(cents/100).toFixed(2)`, which round-trips exactly for two-decimal amounts.
- **Copy truth:** held.

**Land rule unchanged:** #345-#351 land as one, after the coach backend deploys. W2 is not inert: it puts the checklist on Home.
