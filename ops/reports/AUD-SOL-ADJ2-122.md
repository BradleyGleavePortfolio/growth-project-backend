# AUD-SOL-ADJ2-122 — independent GPT-6.1 Sol delta audit, agent 122

Status: DONE Mon Oct 5 17:35:13 PDT 2026; started Mon Oct 5 17:30:26 PDT 2026; inside the 30-minute time box.

## Scope and heads

- Backend #655: `2902add5bb9f96c2ea488282ee1e6d727d203044`, 2,156 changed lines, opened before the new-PR size cutoff. ([backend PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655))
- Mobile #337: `c37add1c37dd47fb6d5ade587b320b84e64854db`, 1,204 changed lines, opened before the new-PR size cutoff. ([mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337))

Read common 122 in full, only this JOBS122 entry, current source-of-truth A1, both A2 overrides, A5 rules 11/12, the lens contract, own prior Sol verdicts, and builder fix-round evidence. No other lens's report or verdict was read. Both exact heads claimed. No checkout changes, worktrees, commits, pushes, local tests, builds or production actions.

## Posted verdicts

| PR | Exact head | Verdict | A/B/C | Comment |
|---|---|---|---|---|
| growth-project-backend #655 | `2902add5bb9f96c2ea488282ee1e6d727d203044` | APPROVE | 0/0/10 | [Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270) |
| growth-project-mobile #337 | `c37add1c37dd47fb6d5ade587b320b84e64854db` | APPROVE | 0/0/4 | [Sol mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006585711) |

Each remote head was checked immediately before its POST; the returned comment first lines/counts matched the exact requested head and verdict format. ([backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270), [mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006585711))

## Prior Sol A/B dispositions

### Backend

- A-655-1: the ordinary API reassignment leak/mutation path is closed by current, live-client filters on list and `own` on every decision/returned view; the SQL-only parity remainder is C-655-9 under this job's scope. ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- B-655-1/2/3/4: C-655-3/4/5/6 respectively, C (edge, deferred to 10k clients). ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- B-655-5: inaccurate measured-night wording is fixed; average-versus-night-count semantics is C-655-7, C (edge, deferred to 10k clients). ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- B-655-6: realized `volume_pct` is used in the sentence, returned proposal/change and event; the one-set-floor example now reports 4 to 3 sets as 25%, not 50%. ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- B-655-7: manifest delete decisions cover proposal client/proposing coach/deciding coach and event actor, while the surviving client's applied assignment snapshot is retained. ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- B-655-8: test-double recursive inference is removed and full exact-head build/typecheck/tests are green. ([required CI](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392946592/job/112042078645))
- B-655-9: generated proposal sentence is impersonal, with no first person. ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- B-655-10: head-coach-only launch scope, C-655-8, C (edge, deferred to 10k clients). ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))
- Original C-655-1/2 remain; an additional failed-reconciliation load-copy remainder is C-655-10; C (edge, deferred to 10k clients). ([Sol backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270))

### Mobile

- A-337-1: raw Zod/HTTP error/response objects are replaced by fresh constant-message diagnostic errors and code-shaped diagnostic fields. ([Sol mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006585711))
- B-337-1/2: the tracked dependency link is removed; the changed card tests await render/event/act; exact-head vendor guard/typecheck/lint/tests are green. ([required CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391538418/job/112039305987))
- B-337-3: approve/edit/undo unanswered outcomes say unconfirmed, remove the stale card and trigger the section's list reload; the success-path regression reloads to an applied card with Undo. ([Sol mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006585711), [builder regression evidence](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006171272))
- B-337-4 becomes C-337-3; original C-337-1/2 and signed percentage wording C-337-4 remain; C (edge, deferred to 10k clients). ([Sol mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006585711))

## Evidence collected

- Backend current-head checks: build-and-test, RLS/live tests, migration/schema gates and other checks succeeded; deploy-readiness-gate is skipped, not a claimed pass. ([backend build-and-test](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37392946592/job/112042078645))
- Mobile current-head checks: Typecheck, lint, test and CodeQL checks succeeded; the required test job succeeded on its rerun. ([mobile required check](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37391538418/job/112039305987))
- Builder failing-before logs were read; passing runtime evidence will be reused from existing exact-head PR CI, not represented as independently executed probes. ([backend fix round](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006482768), [mobile fix round](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006171272))
- Read every fix-commit hunk; verified main merges have no combined conflict-resolution diff; compared the original/new Roman API/card/section files and traced current list/decisions, egress grant reads, erasure decisions and set-count projections. The frontend API schema, card and section are unchanged apart from the two explicitly reviewed copy/test files and dependency-link removal. ([backend PR](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655), [mobile PR](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337))

## Saved payloads

- `ops/aud-122/AUD-SOL-ADJ2-122/backend-655-verdict.md`
- `ops/aud-122/AUD-SOL-ADJ2-122/mobile-337-verdict.md`

These are the exact posted verdict bodies. No new probe or runtime pass/fail was claimed by this lens.

## HANDOFF

Completed: both Sol APPROVE verdicts are posted at the exact assigned heads, with zero remaining A/B findings under the mandated launch scope; backend has 10 deferred Cs, mobile 4. ([backend verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/655#issuecomment-6006585270), [mobile verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/337#issuecomment-6006585711))

Operator: combine with the independently posted other lens verdicts and record the proposed-C dispositions; recommended default is accept the launch-scope deferrals and keep the flag off. No extra fix round is requested by Sol.

No worktree, local branch, lock or lane run was created, so none needs cleanup; read-only main checkouts and production are untouched. Claim markers are retained as audit provenance. Do not infer deployment/enablement authorization from these approvals.
