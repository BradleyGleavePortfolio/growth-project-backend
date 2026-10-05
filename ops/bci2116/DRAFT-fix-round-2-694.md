FIX ROUND 2 (B-CI2-116, agent 116) — growth-project-backend#694 @ 61d42f09077a1786b48ab68164f9e4921a795178

DRAFT, NOT POSTED (owner pause 21:04 PDT). Post only after re-checking that all 11 required checks are green at this exact head.

Round 1 = merge of main a5b605d1 (8346b1ac, clean, merge-only, not posted separately).

| Finding | Change | Commit | Test (failing-before -> passing-after) |
|---|---|---|---|
| B-694-1 (GPT-6.1 Sol): guard accepted Type-check working-directory scripts/secrets and strictNullChecks:false under strict:true | Guard resolves the effective gate: exactly one tsc step named Type-check running exactly `npx tsc --noEmit`, no if/continue-on-error at step or job, working directory from step -> job defaults.run -> workflow defaults.run must resolve to the repo root; project resolved with ts.parseCommandLine + ts.findConfigFile + ts.getParsedCommandLineOfConfigFile; every strict-family flag effectively on (cross-checked with TypeScript's getStrictOptionValue), noCheck off; every repo file a CI jest config hands to ts-jest must be in that program | 27858281, 61d42f09 | test/ci/jest-typecheck-gate-probes.spec.ts runs the guard unchanged against mutated inputs: red on the round-0 guard, CI lane 37174744226 (7 failed / 7 passed) and 37175679844 (before2, 9 probes); green at this head in build-and-test. Guard self-tests: rejects: Sol probe 1, Sol probe 2, job/workflow defaults, -p, --project, file args, --strict false, --noCheck, -b, \|\| true, cd, if, continue-on-error, ordering, removal, rename, checkout path, shell, NODE_OPTIONS, each of 9 strict flags, strict:false, noCheck, exclude test/ci, include narrowing |
| C-694-2 (Sol): numeric workerIdleMemoryLimit semantics | Limit normalized by jest-config (resolved via jest -> jest-cli); numbers in (0,1] and N% rejected as RAM shares; absolute value must be > 0 and <= 75% of the Test step heap cap | 27858281, 61d42f09 | probe 0.9 red on round-0 guard (37174744226); rejects: 0.9, "0.5", "50%", "3.5GB", 0, removed, "2 GB" |
| C-694-1 (Claude Opus 5.5): walk only covered src/test/roots | Coverage walk spans the whole repository (except node_modules, dist, .git, coverage) | 27858281, c8c9a764 | probe include [src,test] red on round-0 guard (37175679844); rejects: Opus C-694-1 |
| C-694-2 (Claude Opus 5.5): job-level if not pinned | Job-level if: on build-and-test rejected | 27858281, c8c9a764 | probe job-level if red on round-0 guard (37175679844); rejects: Opus C-694-2 |

ci.yml, jest.config.js, tsconfig.json unchanged in this round; no required check renamed. Diff vs main: 3 files.

Checks at head: FILL IN (11/11 required).

READY FOR AUDIT   <- only if 11/11 green at this exact head
