AUDIT Claude Opus 5.5 — growth-project-backend#694 @ 14c84c75aba63236ef22ca3dea96f791dc75f247 — VERDICT: APPROVE

A/B/C = 0/0/2

Lens: AUD-OPUS-661CI-116 (operator agent 116). Tier T4 (CI gate file `jest.config.js`, also inherited by `jest.rls.config.js`); the body's T4 grading is correct. First verdict of this lens on this PR. Evidence reuse: none; everything below was read or fetched at this head.

### What was checked
- **Diff:** 2 files, +192/-2: `jest.config.js` and the new `test/ci/jest-typecheck-gate.spec.ts`. Every line of both files was read at this head.
- **No CI workflow changes:** `git diff d23fa317 14c84c75 -- .github` is empty. No required job is renamed, removed, reordered or loosened, and all 11 required checks are green at this head.
- **Merges cleanly:**
  - `git merge-tree` of this head with main f57baba3: clean.
  - `git merge-tree` with #687's current head 7d7e7db4: clean. The `workerIdleMemoryLimit: '2GB'` block is byte-identical.
- **Transpile mode is really active:**
  - Versions: ts-jest 29.4.9, jest 30.4.2, TypeScript 5.9.3.
  - `ConfigSet` takes `isolatedModules` from the parsed tsconfig, inline override included (`config-set.js:228`).
  - `TsCompiler` builds a LanguageService only when it is false (`ts-compiler.js:74`).
  - The CI logs show no ts-jest warnings.
- **No type gate is lost:**
  - The build-and-test `Type-check` step runs `npx tsc --noEmit` with a 4 GB heap. It has no `continue-on-error`, no step `if` and no `-p`, and it runs before `Test` (`npm test --if-present`, where `"test": "jest"`).
  - `tsconfig.json` has no `include`, so its program holds every `.ts` outside `node_modules`, `bower_components`, `jspm_packages`, `dist` and `test/**/__fixtures__/**`. It compiles under `strict: true`, stricter than ts-jest's relaxed override.
  - The guard spec confirms that no `.ts` under a jest root sits in an excluded fixture tree.
  - The live jobs inherit the transform through `jest.rls.config.js`. Their specs live under `test/`, so the same required step type-checks them.
- **Runtime semantics:**
  - `rg "const enum"` finds none in `src/` or `test/`.
  - Type-only re-exports and decorator metadata of imported classes behave the same under `transpileModule`. A type-only symbol falls back to `Object`, which is harmless for Nest DI with explicit tokens.
  - Suite parity holds: 713 suites as on main plus the guard, the same 23 skipped, and 12313 passed.
- **Root cause:**
  - Raw data in the builder's `exp/ab_forced_gc_ordered.txt`: same 27 specs, `--runInBand`, forced GC. Retained heap is 1396 to 2124 MB with type-checking and 75 to 386 MB transpile-only. That matches the body's table.
  - The OOM evidence was checked in the logs:
    - [main job 111265482439](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37144478819/job/111265482439): `FATAL ERROR ... heap out of memory`, then `Jest worker ran out of memory and crashed`, at 382.6 s of jest time.
    - [#685 job 111286643176](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37151664345/job/111286643176): the same failure at 299.2 s.
- **Two green runs at this head:**
  - [attempt 1](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111348549769): 137.8 s of jest, 714 passed, peak per-suite heap 1553 MB, no worker crash.
  - [attempt 2](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37172628536/job/111349414644): 235.1 s, 714 passed, peak 1632 MB.
  - Both peaks are below the 2 GB recycle limit and the 4 GB cap.
- **Guard spec failing-before:** checked by reading, not run. On main's `jest.config.js` the third test fails (`isolatedModules` is undefined). Narrowing the tsconfig program below `test/` fails the second test.

### C findings
- **C-694-1:** `test/ci/jest-typecheck-gate.spec.ts:115-124` walks only `src/`, `test/` and the jest roots. Jest also loads `.ts` sources outside them through test imports, for example:
  - `test/backfill-coach-subscriptions.spec.ts` imports `scripts/backfill-coach-subscriptions.ts`.
  - `test/admin-federation-smoke.helpers.spec.ts` imports `scripts/admin-federation-smoke.helpers.ts`.

  They are in tsc's program today (there is no `include`), so nothing is lost now. But a later `"include": ["src", "test"]` would drop them from every type check while the guard stays green.

  Fix rule: walk every tracked `.ts` outside `node_modules` / `dist` (or add `scripts/` and `prisma/` to the walk). Verify: with `"include": ["src", "test"]` added locally, the second test must fail.
- **C-694-2:** The first guard test pins the step's `if` and the job's `continue-on-error`, but not a job-level `if` on `build-and-test`. A skipped required job reports as passing, which would silently skip the type gate. Fix rule: add `expect(job.if).toBeUndefined()`.

APPROVE: zero A and zero B. The two C items are cheap hardening of the guard and can go in a later round or a follow-up.
