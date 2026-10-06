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
