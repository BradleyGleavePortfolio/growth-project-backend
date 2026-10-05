AUDIT GPT-6.1 Sol — growth-project-mobile#347 @ 08c7416ee102e457fdad3b98ca9b60e4268fa48d — VERDICT: REQUEST CHANGES

A/B/C = 0/3/2

**AUD-SOL-W3F-122, agent 122 — independent full W3 review**, the whole W3 diff against W2 `5f8378ff26ab15bb007d33f14218f46d6c508cf3`, not the earlier restack/delta-only approval. [Review target](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347), [earlier limited Sol scope](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005093397).

### B-347-1 — the offered free first package cannot be edited

**Normal-user story:** A coach creates the offered free first package, opens Packages to change its name or description, and Save changes rejects the unchanged $0 price instead of saving. [Wizard offer](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/navigation/CoachWizardNavigator.tsx), [editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/payments/CoachPackageEditScreen.tsx).

`CoachPackageEditScreen.tsx:187-191` rejects every zero-price payload before PATCH, contradicting W3's new free-package path and `CoachWizardNavigator.tsx:446` (“can be changed any time”); the first independent probe reaches Save and observes **zero PATCH calls**. [Failing-before CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

**Fix/closure:** Permit supported $0 one-time packages to save non-price edits while preserving backend pricing rules; replay the free-package rename probe. [Backend accepts free pricing](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/packages/packages.dto.ts).

### B-347-2 — saved trial terms do not reach the package

**Normal-user story:** A coach enters a 14-day trial on a live monthly package and saves it, but the actual offer remains without that trial while the editor reports success and its buyer preview promises one. [Editor save/preview](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/payments/CoachPackageEditScreen.tsx), [buyer-preview copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/client/packageDetail/PackageDetailSurface.tsx).

`CoachPackageEditScreen.tsx:198-217,247,413-427,576-590` accepts and previews trial days, but `packagesApi.ts:419-433,457-475` discards them; the second independent probe shows a successful PATCH body with **no `trial_days:14`**. [Actual adapter](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/api/packagesApi.ts), [failing-before CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

**Fix/closure:** Never accept, confirm or preview unsupported trial terms as saved: either implement the deployed contract end to end or explicitly prevent unsupported trial configuration and explain it; verify the displayed saved offer matches persisted terms, not just the local draft. [Current DTO lacks trial writes](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/packages/packages.dto.ts).

### B-347-3 — “skip for now” leads to packages that cannot be sold

**Normal-user story:** A coach skips the first package, finishes setup and follows the Home checklist to create a paid package, but the editor leaves it unpublished with no action to make it purchasable. [Wizard skip](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/navigation/CoachWizardNavigator.tsx), [Home routing](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/command-center/CoachHomeCards.tsx).

`CoachPackageEditScreen.tsx:261-302,629-755` creates and opens the draft without publishing or providing a publish control; the backend sets `published_at:null`, and the wizard-only publish path is no longer mounted after completion. [Editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/payments/CoachPackageEditScreen.tsx), [backend draft contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/packages/packages.service.ts), [root wizard gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/navigation/RootNavigator.tsx).

**Fix/closure:** Supply a reachable, explicit publish action for editor-created drafts against the displayed current offer, surface its result truthfully, and replay the third probe; the current probe completes create/open but finds **neither publish request nor publish control**. [Failing-before CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

**Evidence:** One mobile CI-lane push, one spec, **3/3 normal-flow product failures**, using the real editor and real API adapter, with synthetic backend responses matching the deployed draft/write contract; no local npm/Jest/tsc/builds and no PR-branch pushes. [Probe spec](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/45964555b637912362713312407a8fdf07075dde/src/__tests__/audit122W3NormalFlows.test.tsx), [lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330).

The existing exact-head required job remains SUCCESS (**463 suites / 6,412 tests**); that does not cover these new demonstrated normal flows, and absent stacked Analyze contexts are not claimed green. [Exact-head job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385137248/job/112016448242).

C-347-1 `CoachPackageEditScreen.tsx:261`, editor owner guard; C-347-2 `CoachWizardNavigator.tsx:130-140,622-629`, wizard owner rechecks — **C (edge, deferred to 10k clients)**; no analysis or probes requested. [Prior deferred Sol record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005093397).

Size **2,749**, within grandfathered 3,000 cap; default: one item-list fix round, preserve backend Money prerequisites and #345–#351 land-as-one/green landing-head gates, then re-review only these Bs and the changed lines. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347), [existing landing record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6004974850).
