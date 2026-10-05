# AUD-SOL-PD1-122 — programs delta, agent 122

Started 2026-10-05 16:33:49 PDT; deadline 17:18:49 PDT. Sol lens, independent; no other lens's current-round work read.

## Scope
- Mobile #355 @ 36fd39d9eea8f4603358734a3e6c53905310992d: prior Bs and fix delta.
- Mobile #356 @ d38b4a7045da9c8aa0bec262adba2428dc8da287: prior Bs and fix delta.
- Mobile #357 @ 670fea7555e0621d475455d8f8490b0ac6f28c6d: merge-only delta.
- Mobile #358 @ dc47b4934b1feb5e77d6fc146e48aef3498c66cc: Remove scope and telemetry fix delta.
- Backend #733 @ 635cabeeae1c3e74dd3f9311e5a059680e917628: first full T4 review.

Read the common brief in full, only the assigned JOBS entry, SoT A1/A2 owner overrides/A5 rules 11–12, and builder reports. Claims taken at these exact heads. Operator-ruled Cs excluded from analysis.

## Status
Source review complete; waiting for probe evidence before posting.

- Own prior B-355-1 is fixed by complete 20-row cursor paging, with a failed later page rejecting the whole roster rather than returning a partial list; the real `coachApi.getClients` signature is `(status, cursor, take)` and the backend controller/service consume the same fields. [Reviewed roster implementation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/36fd39d9eea8f4603358734a3e6c53905310992d/src%2Fapi%2FprogramsApi.ts).
- Mobile parses `code`/`error` and strips envelope keys from the three backend 409 codes; Check again keeps the unresolved history gate for any reply other than successful undo or a parsed moved-head response. [Reviewed mobile API boundary](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/36fd39d9eea8f4603358734a3e6c53905310992d/src%2Fapi%2FworkoutAutosaveApi.ts), [reviewed history gate](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/d38b4a7045da9c8aa0bec262adba2428dc8da287/src%2Fscreens%2Fcoach%2FCoachWorkoutBuilderScreen.tsx).
- #357's own P3 files have zero delta from the previous Sol-reviewed head; its parents are the previous P3 head and the fixed #356 head. [P3 restack record](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/357#issuecomment-6005427938).
- Own prior Sol B-358-3 and B-358-4 are fixed: failure action metadata contains no client/package name; Remove is grouped per client and describes all runs/package copies, omits counts before all pages load, and displays authoritative removed/kept totals afterward. [Reviewed removal implementation](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/dc47b4934b1feb5e77d6fc146e48aef3498c66cc/src%2Fscreens%2Fcoach%2Fprograms%2FProgramHistoryScreen.tsx), [reviewed package failure action](https://github.com/BradleyGleavePortfolio/growth-project-mobile/blob/dc47b4934b1feb5e77d6fc146e48aef3498c66cc/src%2Fscreens%2Fcoach%2Fprograms%2FProgramPackagesScreen.tsx).
- First full #733 review found no blocker: exactly three named codes allow safe nonnegative integer head indexes and 16-lowercase-hex tokens; service authorization precedes conflict generation and 409 checks precede writes; other fields/codes and 5xx details remain excluded. [Reviewed detail allowlist](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/635cabeeae1c3e74dd3f9311e5a059680e917628/src%2Ffilters%2Ferror-details.ts), [reviewed authorized autosave/undo service](https://github.com/BradleyGleavePortfolio/growth-project-backend/blob/635cabeeae1c3e74dd3f9311e5a059680e917628/src%2Fworkout-builder%2Fworkout-builder-autosave.service.ts).

## Evidence in progress

Backend lane #37389490185 starts at #733 plus probe-only commit `adfd1569`; its three added cross-repo tests use the copied mobile API boundary over actual Axios HTTP against the real Nest controller/service/filter (in-memory Prisma, test auth). The only mobile platform adaptations are Zod v3 subpath import, a Node Axios transport, and Node UUID generation; this is not real-device/production certification. [Independent backend lane](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37389490185).

No verdicts posted yet. Mobile probe sources are prepared but not pushed while the backend lane is outstanding. All operator-ruled cases are excluded from new probing.

## HANDOFF
Continue independent review using the claimed heads; do not read current-round Opus work before posting. Reverify heads immediately before comments. No PR writes, merges, builds, local test runs, or production actions have been performed.
