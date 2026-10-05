## Tier
- **Tier:** T4
- **Why:** Changes how the required `build-and-test` check compiles and runs every jest suite (CI gate file `jest.config.js`, also read by the live-DB jobs through `jest.rls.config.js`).
- **T4 trigger scan:** CI gate file: `jest.config.js` (ts-jest transform, worker recycling, heap logging). `.github/workflows/ci.yml` is NOT changed: no job or step is renamed, removed, reordered or loosened, and all 11 required check names are untouched (`test/ci/branch-protection-checks.spec.ts` still passes).
- **T3 trigger scan:** none (no runtime code, no migration, no env, no dependency or lockfile change).
- **Bounded T1:** NO (CI gate file).
- **Canonical builder:** Claude Opus 5.5 (job B-CI-116, operator 116).
- **Parent owner:** operator 116.
- **Acceptance evidence:** the failing runs below, plus two green `build-and-test` runs at the round-0 head with timings and per-suite heap (table below); the guard spec `test/ci/jest-typecheck-gate.spec.ts` and its black-box companion `test/ci/jest-typecheck-gate-probes.spec.ts` (round 2: failing-before CI-lane runs 37174744226 and 37175679844 against the round-0 guard, green at the round-2 head).
- **Promotion triggers:** none beyond T4. Re-grade if a later change touches `tsconfig.json` scope, the Type-check step, or the ts-jest transform (the guard now fails on each of those unless the change keeps the gate equivalent).

## Fix round table
| Round | Head | Change |
|---|---|---|
| 0 | `14c84c75` | Initial PR |
| 1 | `8346b1ac` | Merge main `a5b605d1` (merge-only, clean; not posted separately) |
| 2 | `61d42f09` | B-694-1 + C-694-2 (GPT-6.1 Sol) and C-694-1 + C-694-2 (Claude Opus 5.5): guard resolves the effective gate (FIX ROUND 2 comment) |

## Problem (failing runs)
`build-and-test` fails intermittently with `FATAL ERROR: ... JavaScript heap out of memory` / `Jest worker ran out of memory and crashed`. A rerun usually passes, so every merge pays a second 8-10 minute run.

| Run (attempt) | Where | Suite holding the worker at the crash | Jest time |
|---|---|---|---|
| [37144478819 (1)](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144478819/job/111265482439) | main `d23fa317` | `test/community/rls/community-message-shape.live.spec.ts` (worker at 4054 MB after 356 s) | 382.6 s |
| [37142946943 (1)](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37142946943/job/111260966288) | #654 | `test/scout/induction/contract.spec.ts` | 398.1 s |
| [37151664345 (1)](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664345/job/111286643176) | #685 | `community-message-shape.live.spec.ts` (4054 MB after 293 s) | 299.2 s |
| [37151675007 (2)](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151675007/job/111291547815) | #679 | `community-message-shape.live.spec.ts` | 412.3 s |
| [37153348511 (1)](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37153348511/job/111291561588) | #685 | `test/diagnostic-quiz-off.spec.ts` | 378.2 s |

Green reruns of the same heads took 310-383 s of jest time. (#679's first attempt, run 37151675007 attempt 1, failed `test/ci/delivery-artifact.spec.ts:284` instead; that is a test failure, not an OOM, and is out of scope here.)

## Root cause
No single suite balloons. The crash always lands late (293-400 s), in a different, usually small suite: whichever one the fullest worker holds when it crosses the 4 GB `--max-old-space-size`. jest sorts uncached runs largest file first, so small files such as `community-message-shape.live.spec.ts` (123 lines, skipped without a DB) run last and get hit most often.

What fills the heap is ts-jest's type-checker. Without `isolatedModules`, ts-jest builds a full TypeScript LanguageService in every jest worker (CI runs 3 on the 4-vCPU runner). It type-checks each transformed file against the whole program, and that program includes the 24 MB, 492k-line generated Prisma client typings (`node_modules/.prisma/client/index.d.ts`). As a worker reaches more of the codebase, its program grows toward a full-repo type-check. On top of that sits the worker's test runtime. The full-repo check alone needs more than 2 GB: ci.yml already gives `tsc --noEmit` a 4 GB heap for that reason.

Measured locally on the same 27 specs in the same order, `--runInBand`, `node --expose-gc`, so jest forces a GC before each heap sample and the numbers are retained memory, not garbage:

| After spec # | Type-checking ts-jest (main) | Transpile-only (this PR) |
|---|---|---|
| 1 (`scout-entities.service`) | 1396 MB | 75 MB |
| 4 (`importer-contract`) | 2005 MB | 294 MB |
| 11 (`roles-enforced`) | 2090 MB | 360 MB |
| 21 (`module-graph`) | 2124 MB | 386 MB |
| 27 (`marketplace-idempotency.service`) | 2080 MB | 345 MB |

Over 64 suites transpile-only, the forced-GC heap stays between 270 and 440 MB. Wall time for 10 service specs, cold cache: 47 s type-checking vs 9 s transpile-only.

## Change (`jest.config.js` + guard spec + black-box probes; 3 files)
1. **ts-jest transpile-only:** `isolatedModules: true` in the ts-jest tsconfig override, so workers no longer build a LanguageService. This removes the root cause.
2. **`workerIdleMemoryLimit: '2GB'`:** a backstop that recycles any worker still above 2 GB after a file. The block is byte-identical to backend #687's (`git merge-tree` of this head with #687 `c2a901a8`: clean, no conflict). With transpile-only workers it should not trigger in normal runs, and if it does, a restart costs about a second instead of rebuilding a type-checker.
3. **`logHeapUsage: true`:** every PASS/FAIL line shows the worker heap, so a regression is visible in the log before it becomes a crash.
4. **`test/ci/jest-typecheck-gate.spec.ts`** (file reads only) resolves the gate the way GitHub Actions, tsc and jest resolve it (round 2), instead of matching strings:
   - **ci.yml:** build-and-test has exactly one tsc step, named `Type-check`, running exactly `npx tsc --noEmit`, with no `if:` or `continue-on-error` at step or job level, a static working directory that resolves (step, then job `defaults.run`, then workflow `defaults.run`) to the repository root, checkout at the workspace root, bash or default shell, and `NODE_OPTIONS` limited to `--max-old-space-size`. It runs before every step that runs jest.
   - **TypeScript API:** `ts.parseCommandLine` + `ts.findConfigFile` + `ts.getParsedCommandLineOfConfigFile` resolve the project that invocation compiles (extends, include/exclude and command-line overrides applied). Every strict-family flag must be effectively on (an explicit `strictNullChecks: false` under `strict: true` is off; TypeScript's own `getStrictOptionValue` is cross-checked) and `noCheck` off.
   - **Coverage:** every repository file that a CI jest config (`jest.config.js` and each `--config` in ci.yml, resolved by `jest-config` with the ts-jest preset merged) hands to ts-jest is in that program, so `scripts/` and `prisma/` sources imported by specs count too.
   - **Memory:** the first transform jest applies to each of those files is ts-jest transpile-only, and `workerIdleMemoryLimit` as `jest-config` normalizes it is an absolute size at most 75% of the Test step heap cap. Numbers in (0, 1] and `N%` are a share of system RAM in Jest, so they are rejected.
   - 49 `rejects:` cases (each must produce a named violation) and 4 `accepts:` cases (equivalent spellings stay green), including both GPT-6.1 Sol probes.
5. **`test/ci/jest-typecheck-gate-probes.spec.ts`** (new, round 2) runs the guard file unchanged in a VM against mutated real inputs (`ci.yml`, `tsconfig.json`, `jest.config.js`): the two Sol probes, job/workflow `defaults.run`, `noImplicitAny`/`strictFunctionTypes` off, `include: [src, test]`, a job-level `if:` and `workerIdleMemoryLimit: 0.9` must each make the guard fail. Against the round-0 guard all 9 fail ([CI lane 37174744226](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37174744226), [CI lane 37175679844](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175679844)).

## Why no gate is weakened
- **Type safety:** the build-and-test job's `Type-check` step (`npx tsc --noEmit`, `tsconfig.json`, `strict: true`) runs before `Test` in the same required job. It covers every spec and every source file jest loads, under stricter options than ts-jest's relaxed override (`strict: false`, `noImplicitAny: false`). Every type error ts-jest could raise is already raised there, and the guard spec keeps it that way. Compile-time-only specs such as `test/cname-prisma-client.spec.ts` stay enforced by that step. So do the 37 spec files that use `@ts-expect-error` (an unused directive is a tsc error).
- **Runtime behaviour:** decorator metadata (NestJS DI), `jest.mock` hoisting and `esModuleInterop` all behave the same under transpile-only. There are no `const enum`s in `src/` or `test/`. All 72 `createTestingModule` specs ran transpile-only locally: 63 passed, 8 were skipped exactly as on main (live-DB gated), and 1 (`login-account-lock.spec.ts`) refused to run without the live Redis service. That last one is expected in the sandbox; CI provides the service.
- **What runs:** no spec is skipped, moved, split or retimed. `maxWorkers`, `testTimeout`, `NODE_OPTIONS` and the job set are unchanged.

## Coordination with backend #687
#687 (dunning D1, `c2a901a8`) adds the same `workerIdleMemoryLimit: '2GB'` block. This PR carries it byte-identically, so either landing order merges cleanly. **Whichever of this PR and #687 lands second reconciles `jest.config.js`.** With the identical block, that is a no-op merge. If either side's block has changed by then, keep one `workerIdleMemoryLimit` entry. This PR fixes the root cause #687's comment attributes to "retained module registries": the measured retention is the per-worker type-checker, and the transform comment in this PR explains it.

## Proof on this branch (green build-and-test runs at `14c84c75`)
| Run | Runner region | Job wall time | `tsc --noEmit` step | Jest time | Suites | Tests | Peak suite heap (no forced GC) | Worker restarts |
|---|---|---|---|---|---|---|---|---|
| [37172628536 attempt 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111348549769) | westus2 | 4m03s | 29 s | **137.8 s** | 714 passed, 23 skipped | 12313 passed, 239 skipped, 5 todo | 1553 MB | 0 (same 3 worker pids throughout) |
| [37172628536 attempt 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111349414644) (job rerun) | eastus | 6m25s | 52 s | **235.1 s** | 714 passed, 23 skipped | 12313 passed, 239 skipped, 5 todo | 1632 MB | 0 |

For comparison, main's green rerun [37144478819 attempt 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144478819/job/111267494968) took 7m59s with 333.6 s of jest and 49 s of tsc. Its failing attempt crashed at a 4054 MB worker heap. Runner speed varies, so compare jest time against the same job's tsc step. On main, jest takes 6.8-8.1x the tsc step across the 9 runs above. On this branch it takes 4.5-4.75x. On a runner as slow as attempt 2 (tsc 49-55 s), that is 235 s of jest here against 333-412 s on main.

Suite parity with main's green run: the same 713 suites pass and the same 23 are skipped (`comm` of the PASS lists). The only addition at round 0 was `test/ci/jest-typecheck-gate.spec.ts`, which added 3 tests (12310 -> 12313); round 2 replaces it with 56 tests and adds the 13-test probe suite. All 11 required checks are green at `14c84c75`. That includes rls-live-tests, community-live-tests and mwb-3-live-tests, which load this config through `jest.rls.config.js` or directly.

