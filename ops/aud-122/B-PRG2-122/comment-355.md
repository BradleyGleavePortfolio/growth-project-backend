FIX ROUND 1 (B-PRG2-122, agent 122) — growth-project-mobile#355 @ 36fd39d9eea8f4603358734a3e6c53905310992d

Prior head 902c64a64156255ce9ce54147db896ac2142a954. Changes since then: merge of main 203e80e3e07e9d9f4b6163f68fbba3f0744ca7d7 (`df981c18`, clean, no conflict hunks), then one fix commit `36fd39d9`. Job: B-PROG2-120 under the operator 122 rulings (JOBS122.md "Programs (step 6)").

**Fixed**
- **Opus B-355-3 + Sol B-355-1 + Opus B-358-1 (roster capped at 20)** — `src/api/programsApi.ts` `assignableClients` now reads every page of GET /coach/clients (`take=20`, cursor = last row id, newest first, matching backend `coach.controller.ts:63-74` / `coach.service.ts:133-157`), de-duplicates by id, and stops at a 100-page bound. A failed page rejects the whole load; a reply that is not a list (or a roster past the bound) throws `RosterIncompleteError` (`client_roster_incomplete`), which `describeProgramFailure` maps to: "Your full client list did not load, so no clients are shown yet. Retry; if it keeps happening, contact support (Settings, Help)." The picker never shows a partial list as complete. `coachApi.getClients` (`src/services/api.ts`) gains optional `cursor` and `take`; existing callers send the same URL as before.
  Normal-user story fixed: a coach with 25 active clients opens Assign and now sees all 25, not the newest 20.
- **Opus B-355-1 (mobile side)** — (a) the EXPO_PUBLIC_FF_MWB_PROGRAMS / EXPO_PUBLIC_FF_MWB_AUTOSAVE clinic flips are removed: `eas.json` is byte-identical to main. They flip in their own PR after the backend fix deploys and the backend FEATURE_MWB_* flags are on (operator ruling). (b) `src/api/workoutAutosaveApi.ts`: `AutosaveConflictSchema` is no longer `.strict()` and the cause is read from `code` or `error` (`conflictNameOf`), so the body B-MWB409-122 publishes (`ops/lanes122/notify/mwb409.txt`: envelope keys + `head_revision_index` + `lock_token`, `code` = `error`) parses. Same for the undo `undo_head_moved` body. (c) An `undo_head_moved` 409 that lacks head or lock token (today's backend) is thrown as `kind: 'contract', status: 409` (an unreadable answer), never a definite refusal. Until the backend PR ships, no build profile turns the flags on, so no coach reaches the autosave path.

**Not fixed (operator 122 ruling: C (edge, deferred to 10k clients))**: Opus B-355-2 (in-progress idempotent retry treated as refusal). Opus C-355-1 stays a follow-up.

**Tests (each fails on 902c64a6 except the marked control)**: `programsApi.test.ts` — 25 clients over two pages with the last-id cursor; exact page boundary + duplicate row; failed second page rejects; non-list reply gives the roster copy. `workoutAutosaveApi.test.ts` — autosave 409 through the error-filter envelope parses; undo head-moved through the envelope parses (control: passes before too); `undo_head_moved` without head/token is `contract`/409 with no `headMoved`. Local heavy.sh runs: programsApi 13/13, workoutAutosaveApi 29/29.

**CI lane** (both lenses' saved probes + 11 related suites, at #356 d38b4a70 which contains this head): https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387504253 — 181 passed / 10 failed, every failure expected:
- P355-C (Opus roster): passes, "25 of 25 clients". Sol AUD-SOL-P12-120 roster case: passes.
- P355-A (Opus): fails by ruling (B-355-2 is C).
- P355-B (Opus): fails until B-MWB409-122 deploys — it feeds today's envelope with no head/token; the post-fix envelope is covered by the new test above.
- Sol roster probe file's copied `assignableClients keeps active rows` case: fails by design (it asserts the old one-argument `getClients("active")`; the call is now `("active", undefined, 20)`; the in-PR copy of that test is updated).
- #356 probe results: see the #356 FIX ROUND comment.

**Size**: 1,953 changed lines vs main (grandfathered 3,000).
**PR CI at this head**: Typecheck, lint, test success (https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37387540853/job/112024480210); CodeQL, Analyze (javascript-typescript), Analyze (actions) success.

READY FOR AUDIT
