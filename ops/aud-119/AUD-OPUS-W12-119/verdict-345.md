AUDIT Claude Opus 5.5 — growth-project-mobile#345 @ 97c9005e644ebc13731d1477bfecc270a10552fd — VERDICT: APPROVE
A/B/C = 0/0/3

Agent 119, job AUD-OPUS-W12-119 (Opus lens), T4 (Connect onboarding, package money setup). This is a full audit of W1 at its exact head. No evidence is reused: Opus never approved #329 or this piece. Base is main; the branch is behind main cc4ceeed, but the newer main commits touch only account-deletion and support files, so nothing overlaps. Size: 2,573+/7- (2,580). The PR is grandfathered (opened 2026-10-03T20:49:31Z, on governance/PR_SIZE_GRANDFATHERED_2026-10-04.md) and is under its 3,000 ceiling.

Required checks at this head are green: [Typecheck, lint, test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220125291/job/111488593962), [Analyze js-ts](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220125300/job/111488594260), [Analyze actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220125300/job/111488594181), [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/runs/111488664142).

Probe: [CI lane run 37229987672](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37229987672) runs this head plus one spec (`src/lib/coachSetup/__tests__/audOpusW12_119_345.test.ts`, never merge). It uses the real `coachPackagesApi`, `createPackageOnce`, `describeError` and `toConnectView` over an axios double that applies a PATCH the way production `PackagesService.update` does (raw rows with `interval`). Result: 6/6 pass, made up of 3 verify cases and 3 observe cases (the observe cases pass because the C they record is real).

### Prior Opus findings (AUD-OPUS-S12-117, 5977036236)
- **B-345-1 (cadence change dropped): closed.**
  - Change: `toBackendUpdate` (`src/api/packagesApi.ts:463-473`) sends `billing_type`/`billing_interval`/`billing_interval_count`, with explicit nulls for one-time. `coachPackagesApi.update` then checks the answer row (`:489-511`, `:573-574`) and fails closed with `PACKAGE_UPDATE_NOT_APPLIED`.
  - Checked against production backend 3e9a9a75: `UpdatePackageDto` accepts all three fields with null allowed, and the controller maps `billing_interval` to `interval`. `PackagesService.update` clears the cadence on one-time (B-629-4) and answers with the raw row (`amount_cents`, `billing_type`, `interval`, `interval_count`). That is exactly what `pricingAppliedMismatch` reads, so the fix works on today's production.
  - Failing-before: [lane 37219210136](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37219210136). My S12 helper probe passes in the [builder replay 37220301571](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37220301571).
  - Also verified here:
    - An editor-shape quarterly save (`intervalCount: 1`) sends month x3 and passes the read-back check.
    - A server that ignores the cadence produces specific copy with no Sentry report, and the intent keeps its old input.
    - A later server that applies the PATCH finishes the same package.
- **B-329-5 helper (create after unmount or account change): closed.**
  - `isLive` is checked before the first step and after every await (`packageCreateIntent.ts:304-315,322-333,363-370,376-378`). A fresh intent that was written but never sent is removed again. A sent intent stays on disk.
  - Verified here: if an update answers after the form retired, the old input stays on disk, and the next live tap re-sends only the PATCH. No second create.
- **C-345-1 (sign-out guarantee): closed.** Header `:20-23` is narrowed to "same account on this device".
- **C-345-2 (W1 tests): closed** by `w1FixRound118.test.ts`. **C-345-3 (tier header): closed.**
- Sol's B-345-3 (content-free diagnostics) also reads correctly at `errors.ts:84-117`. Sentry gets a fixed `CoachSetupFailure` and closed fields only, and the reference is the server id, else the sent X-Request-Id, else a fresh id. This is not my finding; it is noted only because the rest of this verdict depends on it.

### Boundary and money list
- **Inert in the app, except `packagesApi.ts`.** The only W1 module reachable from main screens is `packagesApi.ts`, through the existing package editor (`CoachPackageEditScreen.tsx:184`). The editor's billing edits now reach the server: before this PR they were silently dropped while the editor said "Changes saved". `PACKAGE_PRICING_LOCKED` is now enforced on cadence edits too. This is a net fix; the edge case is C-345-4.
- **Webhooks:** none handled here.
- **Concurrency:** one Idempotency-Key per intent, written before send. A replay returns the same row; changed details get 422 and the app adopts the named package; an archived or removed package gets 410 and a fresh create.
- **Currency:** USD, minor units.
- **Copy:** no first person and no exclamation marks.
- **Today's production fallbacks** for a missing `status/refresh` and the legacy status payload are truthful (the legacy-active case is covered by a test). There is one residual, C-345-5.

### C-345-4: editor saves rewrite cadences the app cannot represent
- **Where:** `src/api/packagesApi.ts:463-473`. Every save from the existing editor now carries billing fields. The read side maps `week` to monthly (`:362`) and month x2 to monthly. The editor hard-codes `intervalCount: 1` (`CoachPackageEditScreen.tsx:164`, outside this diff).
- **Counterexample:** probe case C-345-A. A weekly row read through `list()` and saved with only a new name sends `billing_interval: month`. With no subscribers, the cadence changes silently; with subscribers, the name edit is refused with `PACKAGE_PRICING_LOCKED`. The same happens to month x2 (becomes x1), month x6 (becomes x3) and year x2 (becomes x1).
- **Why C:** no app path creates these cadences, and production has 0 packages.
- **Fix rule:** the editor sends billing fields only when the price or cadence differs from the loaded row, or `fromBackend` keeps the raw interval and count and `toBackendUpdate` sends them back unchanged. Add a test: a name-only edit of a weekly, month x2 or year x2 row sends no billing fields.

### C-345-5: older status payload, account not switched on, told to "finish" eventually-due items
- **Where:** `src/api/coachSetupApi.ts:99-121`. For the legacy payload, `currentlyDue` is the server's union of currently, past and eventually due. With charges off and only eventually-due items, the state is `details_needed`, so `connectCopy` shows "Finish your Stripe details" plus the list (probe case C-345-B: `individual.id_number` gives "Social Security number").
- **Severity:** a fallback only. The stack lands after the coach backend payload (`state`/`requirements`) deploys, and GetPaidPanel shows the "last update Stripe sent" note after any Stripe visit.
- **Fix rule:** for a legacy payload that is not switched on, present the list as "Stripe may ask for" with a neutral title, or show the "last update" note on first load too. Test with an eventually-only legacy payload.

### C-345-6: two package update outcomes lack specific copy
- **Where:** `src/lib/coachSetup/errors.ts:255-262` (`PACKAGE_UPDATE_NOT_APPLIED`) says "clients still see the price and billing shown in Packages". For a wizard draft, no client sees anything. `PACKAGE_PRICING_LOCKED` (409) has no branch, so it falls to the unknown branch at `:273` ("TGP could not create your package", plus a Sentry report; probe case C-345-C).
- **How it is reached:** a wizard intent that remembers a live package with active subscribers. This is rare: it needs the app to die between publish and the intent clear.
- **Fix rule:** add specific `PACKAGE_PRICING_LOCKED` copy ("This package has active subscribers, so its price cannot change. Create a new package for new pricing."), and narrow the NOT_APPLIED body to "TGP did not confirm the change. Packages shows what is saved."

### Production note (not a finding)
The form copy "You keep the price minus Stripe processing and the TGP 2% fee" is the binding fee rule. Today's production charges 2% application fees on destination charges, so it understates what the coach keeps until the fees stack deploys. It never overstates.

Head re-read immediately before posting: 97c9005e644ebc13731d1477bfecc270a10552fd.
