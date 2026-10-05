# AUD-SOL-W3F-122 — independent full W3 review

Agent: 122 / GPT-6.1 Sol  
Clock: started 2026-10-05 16:10:57 PDT; verdict posted 16:19:50 PDT; deadline 16:40:57 PDT.

## Verdict and scope

**REQUEST CHANGES — A/B/C = 0/3/2**, posted at exact mobile #347 head `08c7416ee102e457fdad3b98ca9b60e4268fa48d`, verified immediately before posting. [Independent full W3 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005264344).

Full W3 content against W2 base `5f8378ff26ab15bb007d33f14218f46d6c508cf3`: wizard, editor, seven-file diff, imported package/setup contracts and ordinary post-wizard routes; size 2,749, within the grandfathered 3,000-line cap. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347), [full review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005264344).

This does not reuse the earlier restack/delta-only approval as full W3 evidence. [Earlier limited Sol scope](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005093397).

Independence maintained: no Opus W3 verdict or `AUD-OPUS-WL4-122.md` read.

## Must-fix findings

### B-347-1 — free first package edit dead end

**Normal-user story:** A coach creates the offered free first package, opens Packages to change its name or description, and Save changes rejects the unchanged $0 price instead of saving. [Wizard](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/navigation/CoachWizardNavigator.tsx), [editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/payments/CoachPackageEditScreen.tsx).

Location: `CoachPackageEditScreen.tsx:187-191`; W3 introduces this normal free-package path and promises edits at `CoachWizardNavigator.tsx:446`, but the probe reaches Save and records zero PATCH calls. [Failing-before job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

Fix/verification: allow supported $0 one-time packages to save non-price edits without bypassing backend rules; replay probe case 1 and verify the saved name/description with price still zero. [Supported backend pricing](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/packages/packages.dto.ts), [probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/45964555b637912362713312407a8fdf07075dde/src/__tests__/audit122W3NormalFlows.test.tsx).

### B-347-2 — false saved trial offer

**Normal-user story:** A coach enters a 14-day trial on a live monthly package and saves it, but the actual offer remains without that trial while the editor reports success and its buyer preview promises one. [Editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/payments/CoachPackageEditScreen.tsx), [buyer-preview copy](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/client/packageDetail/PackageDetailSurface.tsx).

Location: `CoachPackageEditScreen.tsx:198-217,247,413-427,576-590`, `packagesApi.ts:419-433,457-475`; probe case 2 completes PATCH but proves `trial_days:14` absent from its body. [Adapter](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/api/packagesApi.ts), [failing-before job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

Fix/verification: either persist supported trial terms end to end or explicitly prevent unsupported trial configuration and explain it; assert that “saved” and buyer-preview terms match persisted data rather than a local draft, without blindly adding a field the current DTO rejects. [Current DTO](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/packages/packages.dto.ts).

### B-347-3 — post-wizard package creation cannot reach publication

**Normal-user story:** A coach skips the first package, finishes setup and follows the Home checklist to create a paid package, but the editor leaves it unpublished with no action to make it purchasable. [Wizard skip](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/navigation/CoachWizardNavigator.tsx), [Home routing](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/command-center/CoachHomeCards.tsx).

Location: `CoachPackageEditScreen.tsx:261-302,629-755`; new rows have `published_at:null`, create opens the draft with neither a publish request nor a publish control, and wizard-only publishing is unavailable after completion. [Editor](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/screens/coach/payments/CoachPackageEditScreen.tsx), [backend draft contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/5cde6253f941112f2d9afbcf572a4da838dbb16a/src/packages/packages.service.ts), [root gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/08c7416ee102e457fdad3b98ca9b60e4268fa48d/src/navigation/RootNavigator.tsx).

Fix/verification: add reachable explicit publishing against the displayed offer, truthful draft/live state and specific failure handling; replay probe case 3 and the ordinary skip → complete → Home checklist → create → publish → purchasable path. [Probe](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/45964555b637912362713312407a8fdf07075dde/src/__tests__/audit122W3NormalFlows.test.tsx), [failing-before job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

These are normal cross-path launch failures exposed by the new wizard promises and real free/paid flows, including pre-existing editor constraints where they make that new flow unsafe; they are not timing or unusual-input findings. [Full verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005264344).

## CI and evidence

Existing exact-head required job: **SUCCESS, 463 suites / 6,412 tests**, independently confirmed from its log; absent stacked Analyze contexts are not treated as green. [Exact-head job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37385137248/job/112016448242).

Independent mobile lane: run `37387324330`, commit `45964555b637912362713312407a8fdf07075dde`, **1 suite / 3 tests, all three product assertions fail as described**; dependency installation succeeds and no local test/build runs were used. [Lane](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330), [job](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387324330/job/112023709413).

C-347-1 editor owner guard; C-347-2 wizard owner rechecks — **C (edge, deferred to 10k clients)**; no edge analysis or probes requested. [Prior deferred Sol record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005093397).

## Evidence files

- `ops/aud-122/AUD-SOL-W3F-122/full-w3.diff`
- `ops/aud-122/AUD-SOL-W3F-122/audit122W3NormalFlows.test.tsx`
- `ops/aud-122/AUD-SOL-W3F-122/normal-flow-ci.log`
- `ops/aud-122/AUD-SOL-W3F-122/exact-head-log-response.json` (ZIP response containing original required-job logs)
- `ops/aud-122/AUD-SOL-W3F-122/verdict-comment.md`
- `ops/aud-122/AUD-SOL-W3F-122/posted-verdict.json`

Operator default: one item-list fix round for B-347-1/2/3, then delta review of those Bs and changed lines; preserve backend Money prerequisites, #345–#351 land-as-one and green landing-head gates. [Full verdict and handoff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/347#issuecomment-6005264344).

Cleanup, 16:21:02 PDT: own probe worktree and local/remote audit branch removed; saved spec, diff and logs retained; no locks acquired and no PR branches pushed.

## HANDOFF
