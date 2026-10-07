AUDIT Claude Opus 5.5 (LB-OPUS-126) — growth-project-backend#810 @ 9ee51c0b16fa139b32532ac16450896188c8967f — VERDICT: APPROVE

A=0 B=0 C=1. CI: green at this head (15 SUCCESS, deploy-readiness-gate SKIPPED, including build-and-test); mergeable clean. Size 179 lines (177+/2-): 8 lines of source, 171 lines of test.

**The four operator checks all pass.**
1. Only the duplicate forRoot is removed, and nothing else changes behaviour.
   - `src/data-export/data-export.module.ts` loses `ScheduleModule.forRoot()` from its imports and the `ScheduleModule` import line. The rest of the diff is a comment.
   - `src/app.module.ts:169` keeps the one unconditional `ScheduleModule.forRoot()`, and every timed job in the app now registers through it.
   - On main those two were the only forRoot calls in src.
   - AppModule is the only module that imports DataExportModule (`app.module.ts:391`).
   - Every bootstrap (main.ts, scripts/gdpr-scrub.ts, export-openapi, export-importer-contract) boots AppModule, so no standalone context loses its scheduler.
   - Nothing in src/data-export injects SchedulerRegistry. If it did, it would still resolve, because forRoot is `global: true`.
2. Data-export's own cron still registers once. The module has one timed job, `data-export-cleanup` (`data-export-cleanup.cron.ts:21`). The single root ScheduleExplorer walks every module, so it picks that job up. The spec checks this: `cronCount(..., 'data-export-cleanup') === 1` and `addCronJob` is called once.
3. The test proves single registration at runtime and fails on main.
   - It boots a real testing module wired like AppModule (root `forRoot()` plus the real DataExportModule) with a probe `@Cron` and `@Interval`.
   - Then it counts across every ScheduleModule's SchedulerRegistry in the container and spies on `SchedulerRegistry.prototype.addCronJob` / `addInterval`.
   - On main, DataExportModule brings a second ScheduleModule instance: Nest 11 keys dynamic modules by reference, and @nestjs/schedule 6.1.3 `forRoot` gives each instance its own explorer and registry. That makes `registries.length` 2 and every count 2, so the first `it` fails on main.
   - The control case (two root forRoot calls) shows the counter really detects a double registration.
   - A static guard keeps `ScheduleModule.forRoot(` to exactly one occurrence in src, in app.module.ts.
4. Effect in production: every `@Cron` / `@Interval` / `@Timeout` (35 files in src on main, including the AppModule-documented GDPR scrub) goes from two registrations per tick to one.

**C (never block)**
- C-810-1: the static guard skips `__tests__` folders and `.spec.ts` files only, so a future `forRootAsync` in a non-src bootstrap (scripts/) would not be caught. Not reachable today.
