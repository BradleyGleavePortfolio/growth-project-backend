# B-CRON-126 — every timed job runs once (agent 126 fleet, Claude Opus 5.5, T4 money)

Started 17:59 PDT 10-06 (time box 50 min, hard stop 19:00). Operator 18:03: TOP PRIORITY, runtime proof required.

## Scope traced
- Wiring: src/app.module.ts:169 `ScheduleModule.forRoot()` (root, global) and src/data-export/data-export.module.ts:32 `ScheduleModule.forRoot()` (second root, since #171).
- Library code (deps/backend/node_modules):
  - @nestjs/core 11.1.27 injector/compiler.js -> `ModuleCompiler.compile` keys dynamic modules via `ByReferenceModuleOpaqueKeyFactory`
    (injector/container.js:26-33: default unless `moduleIdGeneratorAlgorithm: 'deep-hash'`; src/main.ts:28 does not set it).
    `getOrCreateModuleId` stamps a random id on the object reference (`originalRef[K_MODULE_ID]`). Each `forRoot()` returns a new
    object -> two distinct ScheduleModule modules.
  - @nestjs/schedule 6.1.3 schedule.module.js: each instance owns ScheduleExplorer + SchedulerRegistry (forRoot providers) and
    SchedulerOrchestrator + SchedulerMetadataAccessor (static @Module providers). schedule.explorer.js `onModuleInit -> explore()` walks
    `discoveryService.getProviders()` (ALL providers in the app) and adds every @Cron/@Interval/@Timeout to its own orchestrator;
    scheduler.orchestrator.js `onApplicationBootstrap` mounts them into its own registry (so no DUPLICATE_SCHEDULER throw).
  - Result: every decorated job mounted twice, fires twice concurrently. Matches operator's Fly log evidence (drip-dispatcher
    "prior tick still running" at :00 every minute with zero rows).
- Timed jobs in src: 38 @Cron + 1 @Interval + 0 @Timeout (full table in PR body b#810). Dynamic: CoachBriefScheduler uses injected
  SchedulerRegistry (once before and after).
- Open PRs: none touch app.module.ts / data-export / schedule (checked files of all 30 open backend PRs).

## B list
- B1 (money, all timed jobs): on a normal day with no user action, every reminder, digest, billing and payout job ran twice at the same
  moment; now once. FIXED in b#810.

## U list
- none

## C one-liners
- C (edge, deferred to 10k clients): per-job in-process guards kept as is (still useful if a second machine is ever added).

## Covered by open PRs
- none

## Proof (runtime test, test/schedule-module-single-instance.spec.ts)
- Main wiring (main's data-export.module.ts swapped in): `wired like AppModule ... registers once` FAILS at
  `expect(cronCount(booted, PROBE_CRON)).toBe(1)` Expected 1, Received 2; module-imports test Expected 0 Received 1; static guard lists
  src/data-export/data-export.module.ts. 3 failed, 1 passed (control). Log: ops/reports/B-CRON-126-main-fail.txt
- Fix: 4/4 pass. Log: ops/reports/B-CRON-126-fix-pass.txt
- Control test: two root imports register the probe twice (passes on both) -> the counter detects the bug.
- eslint on both files clean; targeted tsc on the spec clean (only unrelated express Request.user augmentation errors from the
  files-only tsconfig).

## PRs opened
- backend b#810 https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/810
  head 9ee51c0b16fa139b32532ac16450896188c8967f, 179 lines (177+/2-), branch agent126/b-cron-126. CI: 15 SUCCESS, deploy-readiness-gate
  SKIPPED (same on #805). READY comment posted 18:23 PDT:
  https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/810#issuecomment-6028857589

## Not fixed (needs operator)
- Deploy after dual APPROVE + green CI (operator). Impact/cleanup of what the double runs did = AUD-CRONX-126.

## HANDOFF
- DONE 18:24 PDT. b#810 READY FOR AUDIT at 9ee51c0b, CI green. Worktree removed (branch pushed, nothing uncommitted). No ci/* branches.
- Next (operator): route b#810 to the backend lens pair (LB-OPUS-126 / LB-SOL-126); merge on dual APPROVE; deploy. Any lens B fix:
  recreate worktree from origin/agent126/b-cron-126 and push a FIX ROUND 2.
