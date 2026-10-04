FIX ROUND 0 (B-CI-116, agent 116) — backend#694 @ 14c84c75aba63236ef22ca3dea96f791dc75f247

New PR (base main, T4 because it changes a CI gate file). Diff: 2 files, +192/-2: `jest.config.js` and the new `test/ci/jest-typecheck-gate.spec.ts`. `.github/workflows/ci.yml` is not changed, and no required check job is renamed or removed.

| Item | Change | Commit | Test / evidence |
|---|---|---|---|
| Root cause: every jest worker built a full ts-jest LanguageService (type-checking against the whole program, including the 24 MB generated Prisma typings). Retained heap was ~1.4 GB after the first spec and ~2.1 GB after 27, and kept growing until a worker crossed 4 GB after ~300-400 s. | ts-jest transform `isolatedModules: true` (transpile-only) | `14c84c75` | Local A/B on the same 27 specs, forced GC: 1396 -> 2124 MB vs 75 -> 386 MB (table in the PR body). In CI the peak suite heap is 1553 / 1632 MB, against the 4054 MB crashes. |
| Type gate must not weaken | Guard spec pins: `npx tsc --noEmit` runs before `npm test`, fail-closed; `tsconfig.json` (strict) holds every `.ts` under `src/` and every jest root; the transform stays transpile-only | `14c84c75` | Failing-before (local): main's `jest.config.js` fails test 3; `tsconfig.json` excluding `test/ci/**` fails test 2. Green in both CI runs. |
| Backstop against future leaks | `workerIdleMemoryLimit: '2GB'`, byte-identical to #687's block; guard keeps it at or below 75% of the Test heap cap | `14c84c75` | `git merge-tree` with #687 `c2a901a8`: clean. 0 worker restarts in both runs. |
| Visibility | `logHeapUsage: true` | `14c84c75` | Every PASS line shows the heap. |

Failing runs (OOM): main [37144478819 a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144478819/job/111265482439), #654 [37142946943 a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37142946943/job/111260966288), #685 [37151664345 a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664345/job/111286643176), #679 [37151675007 a2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151675007/job/111291547815), #685 [37153348511 a1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511/job/111291561588).

Green build-and-test runs at this head:
- [attempt 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111348549769): job 4m03s, jest 137.8 s, tsc 29 s.
- [attempt 2, job rerun](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111349414644): job 6m25s, jest 235.1 s, tsc 52 s (slower runner).
- Main's green rerun took 7m59s with 333.6 s of jest.
- Both runs had the same suites as main: 714 passed (713 plus the new guard), 23 skipped, 12313 tests passed.

All 11 required checks are green at `14c84c75`. The PR shows "behind" because main moved to `f57baba3` (#664, multer bump; it does not touch jest, tsconfig or ci.yml, and `git merge-tree` is clean). The operator's update-branch applies.

Coordination: whichever of this PR and #687 lands second reconciles `jest.config.js`. With the byte-identical block that is a no-op merge. If either block has changed by then, keep one `workerIdleMemoryLimit` entry.

READY FOR AUDIT
