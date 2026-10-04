## Tier
- **Tier:** T4
- **Why:** Changes how the required `build-and-test` check compiles and runs every jest suite (CI gate file `jest.config.js`, also read by the live-DB jobs through `jest.rls.config.js`).
- **T4 trigger scan:** CI gate file: `jest.config.js` (ts-jest transform, worker recycling, heap logging). `.github/workflows/ci.yml` is NOT changed: no job or step is renamed, removed, reordered or loosened, and all 11 required check names are untouched (`test/ci/branch-protection-checks.spec.ts` still passes).
- **T3 trigger scan:** none (no runtime code, no migration, no env, no dependency or lockfile change).
- **Bounded T1:** NO (CI gate file).
- **Canonical builder:** Claude Opus 5.5 (job B-CI-116, operator 116).
- **Parent owner:** operator 116.
- **Acceptance evidence:** the failing runs below, plus two green `build-and-test` runs at this branch's head with timings and per-suite heap (table below, filled in from the runs); the new guard spec `test/ci/jest-typecheck-gate.spec.ts`.
- **Promotion triggers:** none beyond T4. Re-grade if a later change touches `tsconfig.json` scope, the Type-check step, or the ts-jest transform.

## Fix round table
| Round | Head | Change |
|---|---|---|
| 0 | `14c84c75` | Initial PR |

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

## Change (`jest.config.js` + one guard spec; 2 files)
1. **ts-jest transpile-only:** `isolatedModules: true` in the ts-jest tsconfig override, so workers no longer build a LanguageService. This removes the root cause.
2. **`workerIdleMemoryLimit: '2GB'`:** a backstop that recycles any worker still above 2 GB after a file. The block is byte-identical to backend #687's (`git merge-tree` of this head with #687 `c2a901a8`: clean, no conflict). With transpile-only workers it should not trigger in normal runs, and if it does, a restart costs about a second instead of rebuilding a type-checker.
3. **`logHeapUsage: true`:** every PASS/FAIL line shows the worker heap, so a regression is visible in the log before it becomes a crash.
4. **`test/ci/jest-typecheck-gate.spec.ts`** (new, file reads only) pins the invariants that make transpile-only safe:
   - build-and-test runs `npx tsc --noEmit` before `npm test`, fail-closed (no `continue-on-error`, no `if`, no `-p` override).
   - `tsconfig.json` (strict, no `noCheck`) has every `.ts` file under `src/` and every jest root in its program.
   - The ts-jest transform stays transpile-only.
   - `workerIdleMemoryLimit` stays at or below 75% of the Test step's heap cap.

   Failing-before: on main's `jest.config.js` the third test fails (`isolatedModules` is undefined). Excluding `test/ci/**` from `tsconfig.json` makes the second test fail. Both were checked locally.

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

Suite parity with main's green run: the same 713 suites pass and the same 23 are skipped (`comm` of the PASS lists). The only addition is `test/ci/jest-typecheck-gate.spec.ts`, which adds 3 tests (12310 -> 12313). All 11 required checks are green at `14c84c75`. That includes rls-live-tests, community-live-tests and mwb-3-live-tests, which load this config through `jest.rls.config.js` or directly.
