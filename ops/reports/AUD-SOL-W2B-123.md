# AUD-SOL-W2B-123 — GPT-6.1 Sol mobile screen audit, agent 123

## Scope and independence

Started 20:07 PDT on 2026-10-05; hard stop 22:00 PDT. Read the common brief, Wave 2 preamble, W2B entry and its three builder entries, owner A1/A2 overrides and A5 rules 11/12. No other lens comments, notes or reports read before verdicts. No application-code edits, PR-branch pushes, merges, deployments, local builds/tests or paid actions.

## CL1 — mobile #386

Head **0a1bc0bd7d18348742184a2e5dcac1a1c961748d**; verdict **REQUEST CHANGES**, A/B/C **0/1/2**; 1,189 changed lines; exact-head CI and CodeQL green. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386) [CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37407056784/job/112086834393)

B-386-SOL-1: a client redeems a free/prepaid-plan code, gets the active-plan welcome, taps Done and then Workout, but the unchanged in-memory entitlement gate still blocks training; the changed attach path never refreshes it. [Redemption](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/0a1bc0bd7d18348742184a2e5dcac1a1c961748d/src/components/coachless/CoachCodeSheet.tsx#L138-L146) [Entitlement lifecycle](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/0a1bc0bd7d18348742184a2e5dcac1a1c961748d/src/entitlements/EntitlementProvider.tsx#L116-L135) [Gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/0a1bc0bd7d18348742184a2e5dcac1a1c961748d/src/entitlements/ProtectedScreen.tsx#L31-L113)

Recommend refreshing the shared entitlement after the active grant and adding an integrated inactive-to-active gate regression. Skipping checkout for the granted plan is correct, not a defect. [Backend grant contract](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e6f9a5ec0c5bac40f33ac7513ad2653880f265d3/src/invite-grant/invite-grant.service.ts#L21-L35)

Cs: pending-consent recovery is outside launch contracts scope; plan-sheet suppression is C (edge, deferred to 10k clients). [Consent branch](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/0a1bc0bd7d18348742184a2e5dcac1a1c961748d/src/components/coachless/CoachCodeSheet.tsx#L290-L292) [Launch config](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/e6f9a5ec0c5bac40f33ac7513ad2653880f265d3/.github/fly-env-desired-state.json#L114) [Suppression](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/0a1bc0bd7d18348742184a2e5dcac1a1c961748d/src/components/PackageSelectionSheet.tsx#L161-L183)

Comment payload: `ops/aud-123/AUD-SOL-W2B-123/verdict-386-0a1bc0bd.md`.

Posted verdict: [Sol #386 comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008549315).

## INV1 part 1 — mobile #385

Head **35f8c1e8825d7b710bd934f2d56642f6313976d6**; verdict **APPROVE**, A/B/C **0/0/0**; 128 changed lines; exact-head CI and CodeQL green. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385) [CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37406109000/job/112083938390)

Distinct lifecycle refusal copy matches backend codes; successful attach behavior is unchanged. [Mapping](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/35f8c1e8825d7b710bd934f2d56642f6313976d6/src/screens/day-one/api.ts#L57-L80) [Diff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385/files)

Comment payload: `ops/aud-123/AUD-SOL-W2B-123/verdict-385-35f8c1e8.md`.

Posted verdict: [Sol #385 comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385#issuecomment-6008559894).

## INV1 part 2 — mobile #387

Head **b54bea80c5c9948ec71465d4361dd0a1f36d76f7**; verdict **APPROVE**, A/B/C **0/0/1**; 1,168 counted changed lines excluding one lockfile line. [PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/387)

New API requests match the deployed backend contract; disabled-feature 404 preserves the legacy screen; share, rotate, revoke and existing bulk/redeemer navigation are present. [API](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b54bea80c5c9948ec71465d4361dd0a1f36d76f7/src/api/coachCodesApi.ts#L96-L134) [Entry](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b54bea80c5c9948ec71465d4361dd0a1f36d76f7/src/screens/coach/CoachCodesEntry.tsx#L33-L51) [Actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b54bea80c5c9948ec71465d4361dd0a1f36d76f7/src/screens/coach/CoachCodesScreen.tsx#L143-L265)

C-387-SOL-1 — relative create expiry on retry: C (edge, deferred to 10k clients). [Create body](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/b54bea80c5c9948ec71465d4361dd0a1f36d76f7/src/screens/coach/CoachCodesScreen.tsx#L348-L365)

All required checks green at 20:14 PDT before exact-head approval was posted. [CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37407516837/job/112088256759) [CodeQL](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37407516840)

Posted verdict: [Sol #387 comment](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/387#issuecomment-6008591834); payload `ops/aud-123/AUD-SOL-W2B-123/verdict-387-b54bea80.md`.

## HANDOFF

Completed 20:23 PDT, within the per-PR time boxes and before 22:00 PDT.

- Operator queue change received 20:23 PDT: **skip BC1 #388; W2C owns it**. Its builder notification appeared at 20:23:37; no #388 head/code/lens notes were reviewed and no comment was posted there.
- #386 REQUEST CHANGES A0/B1/C2: [posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008549315); #385 APPROVE A0/B0/C0: [posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385#issuecomment-6008559894); #387 APPROVE A0/B0/C1: [posted verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/387#issuecomment-6008591834).
- Final read at 20:23:55 PDT: all three PRs remain open at exactly the audited heads; no head moved. [#386](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386) [#385](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/385) [#387](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/387)
- Recommended default: builder fixes only B-386-SOL-1 and adds the integrated active-grant regression; delta lens pair at the new head, required CI green, then owner device passes before the backend flags turn on. No new owner decision needed.
- Owner freeze honored: edges, races, retries and time zones remain C, not blockers; no edge probes. Aggregate A/B/C: **0/1/3**. No local builds/tests or CI-lane probes; existing exact-head CI supplied run evidence.
- Workspace evidence preserved: all three clean detached read-only worktrees remain at `wt/AUD-SOL-W2B-123-{386,385,387}` (no application files changed); report, verdict payloads and completion notifications retained. No locks, local audit branches, remote branches or CI runs created. No pushes, merges, deploys or production actions.
- Operator progress/completion file: `ops/lanes123/notify/AUD-SOL-W2B-123.txt`; comment payloads: `ops/aud-123/AUD-SOL-W2B-123/verdict-*.md`.

## CL1 FIX ROUND 2 — delta re-audit

Started 20:37:43 PDT on operator request; only the authorized two prior Bs and the four-file delta reviewed; no new Opus comment, verdict or notes read.

Head **64c5bde0f20f3a39d76961e7eb9838dc515fa2d3**, from **0a1bc0bd7d18348742184a2e5dcac1a1c961748d**; one commit, +157/-2 in the delta; full PR 1,344 lines, under the cap. [Delta](https://github.com/BradleyGleavePortfolio/growth-project-mobile/compare/0a1bc0bd7d18348742184a2e5dcac1a1c961748d...64c5bde0f20f3a39d76961e7eb9838dc515fa2d3) [Builder round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008806111)

Verdict **APPROVE**, A/B/C **0/0/2** (unchanged Cs).

- B-386-SOL-1 closed: successful redeem invokes the real shared entitlement refresh; an inactive client with a free/prepaid grant can reach the protected training gate without foreground/restart. [Fix](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/64c5bde0f20f3a39d76961e7eb9838dc515fa2d3/src/components/coachless/CoachCodeSheet.tsx#L139-L154)
- Integrated regression mounts real EntitlementProvider/ProtectedScreen, confirms initial paywall, redeems grant, taps Done and gets protected content with exactly two entitlement reads; builder verified failing-before by reverting the fix. [Test](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/64c5bde0f20f3a39d76961e7eb9838dc515fa2d3/src/components/coachless/__tests__/CoachlessEntitlement.test.tsx#L92-L119) [Builder evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008806111)
- Requested B-386-OPUS-1 closed independently: iOS handoff reaches labelled ClientPackages, Android retains the sheet; both routes are tested. [Handoff](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/64c5bde0f20f3a39d76961e7eb9838dc515fa2d3/src/components/coachless/CoachlessHomeSlot.tsx#L126-L134) [Tests](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/64c5bde0f20f3a39d76961e7eb9838dc515fa2d3/src/components/coachless/__tests__/CoachlessHomeSlot.test.tsx#L162-L181)
- Exact-head required checks all green: [CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37409208185/job/112093605806) [CodeQL JS/TS](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37409208559/job/112093607151) [CodeQL actions](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37409208559/job/112093606959). No local build/test or new run.
- Carried C-386-SOL-1 pending-consent recovery and C-386-SOL-2 suppression stay nonblocking; edge cases, races, retries and time zones remain C under owner freeze. [Prior Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008549315)

Comment payload: `ops/aud-123/AUD-SOL-W2B-123/verdict-386-64c5bde0-R2.md`.

## HANDOFF

Round-2 delta completed and posted at 20:39 PDT, within the 20-minute time box; exact head verified immediately before posting. [Sol FIX ROUND 2 verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/386#issuecomment-6008840655)

Recommended default: both lenses at 64c5bde0 plus required green CI, merge; backend flag stays off until owner offer configuration and device pass. No new owner decision. Clean detached read-only worktree retained at `wt/AUD-SOL-W2B-123-386-R2`; no code edits, pushes, merges or new CI runs.

## R3C — reused W2B Sol lens

Operator assigned a new R3C queue at 22:06, later adding mobile #391 and extending the box to 23:11:59 PDT. Current detailed report is `ops/reports/AUD-SOL-R3C-123.md`; per-item notifications are `ops/lanes123/notify/AUD-SOL-R3C-123-<n>.txt`.

- backend #752 at 69ad43d08f874f5a4d0122785493fd2c4d28187b: APPROVE 0/0/2. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/752#issuecomment-6009766145)
- backend #751 at 6a0261331490412ad1ba3549efa12f67cc4d7d98: APPROVE 0/0/1. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/751#issuecomment-6009775298)
- backend #749 at ef3bdb4abe994ed46b5416a14249a7fbe71736ff: APPROVE 0/0/1. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/749#issuecomment-6009848853)
- mobile #391 at 914b3ed37b98f0755f19069e6b80c488036af23a: REQUEST CHANGES 0/1/2; owner role is sent to unauthenticated by root bootstrap, making the owner-only editor unreachable. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/391#issuecomment-6009994466)
- backend #754 at 584b3c979ecee0c675758e3714f56b63536a6f78: APPROVE 0/0/1. [Verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/754#issuecomment-6010087556)

## HANDOFF

R3C completed at 22:36:20 PDT; detailed findings in `ops/reports/AUD-SOL-R3C-123.md`. #755 moved to another lens pair per 22:30 operator mail; skipped. Four backend approvals; m#391 requests the narrow owner-root-navigation fix and a delta pair. Aggregate A/B/C 0/1/7, all required checks green at the audited heads. No other current lens notes/comments read before verdicts. No PR code edits, local tests/builds, pushes, merges or new CI runs.

## R3F — m#391 FIX ROUND 1 delta

Head **4f02a19e36383a64cb18b1e9ec467b638d9a5b87**: **APPROVE 0/0/2**, posted 22:48:41 PDT. B-391-1 is closed; owner enters the coach app without the coach wizard, keeps role owner and reaches the Settings editor, with coach/client paths unchanged. [Posted Sol delta verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/391#issuecomment-6010222458)

## HANDOFF

R3F completed inside its 20-minute box. Detailed evidence `ops/reports/AUD-SOL-R3F-123.md`; notify `ops/lanes123/notify/AUD-SOL-R3F-123.txt`. Cs unchanged and nonblocking; no new owner decision. Clean read-only worktree `wt/AUD-SOL-R3F-123-391` retained; no PR edits, pushes, merges, local tests/builds or new runs. Independent; no current Opus round notes/comments read before posting.
