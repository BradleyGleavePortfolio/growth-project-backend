## Tier
- **Tier:** T4
- **Why:** Changes a CI gate script: `scripts/ci/assert-prod-sbom.sh` decides the required `build-sbom` check (`.github/workflows/sbom.yml`) and is re-run by `scripts/ci/release-evidence-gate.sh` before a deploy.
- **T4 trigger scan:** CI gate file `scripts/ci/assert-prod-sbom.sh` (two name checks rewritten, no list, threshold or exit path removed). No workflow, required check name, branch protection or dependency changes.
- **T3 trigger scan:** none (no runtime code, migration, env, dependency or lockfile change).
- **Bounded T1:** NO (CI gate file).
- **Canonical builder:** Claude Opus 5.5 (job B-CI2-116, operator 116).
- **Parent owner:** operator 116.
- **Acceptance evidence:** failing-before CI-lane run on main's script (link below), the same spec green on this head, and all 11 required checks green.
- **Promotion triggers:** none beyond T4. Re-grade if a later change edits DENY_LIST, REQUIRE_LIST or the sbom.yml proof step.

## Fix round table
| Round | Head | Change |
|---|---|---|
| 0 | `3624ab5f` | Initial PR |

## Problem
`assert-prod-sbom.sh` checks the SBOM's component names with

```bash
set -Eeuo pipefail
...
if printf '%s\n' "$NAMES" | grep -qxF "$d"; then fail "build/test tool '${d}' present ..."; fi   # line 59
printf '%s\n' "$NAMES" | grep -qxF "$r" || fail "required runtime package '${r}' missing ..."   # line 62
```

`grep -q` exits at the first matching line. If `printf` is still writing at that moment, it is killed by SIGPIPE (status 141), and `pipefail` makes the whole pipeline non-zero. A name that IS in the SBOM therefore reads as absent:
- line 59 (denylist): a banned build tool such as `eslint` passes the gate. This is fail-open.
- line 62 (require list): a present runtime package is reported missing (spurious red).

Evidence:
- #679 run 37151675007 attempt 1 failed `test/ci/delivery-artifact.spec.ts:284` (the eslint denylist case) with no related code change; attempts 2 and 3 passed it (found by AUD-OPUS-R12-116).
- The auditor's local probe of the exact construct missed the match in 45 and 97 of 3,000 iterations; the here-string form missed 0 of 3,000.
- Builder repro on main's script with the small 5-component fixture: 1 of 100 full script runs exited 0 with `eslint` in the SBOM.
- With an SBOM larger than the 64 KiB pipe buffer the race is lost on every run, because `printf` is still blocked on the full pipe when grep exits: main's script never reports the banned tool and fails a clean SBOM with `required runtime package '@nestjs/core' missing`.

## Change (2 files)
1. `scripts/ci/assert-prod-sbom.sh`: a `has_name` helper runs `grep -qxF -- "$1" <<<"$NAMES"`. A here-string has no writer process that can be killed, so the result depends only on the data. Status 0 = present, 1 = absent, any other grep status aborts the gate with its own error. Both loops, both lists, both messages and every other check are unchanged.
2. `test/ci/assert-prod-sbom-determinism.spec.ts` (new): runs the real script
   - 200 times on a small SBOM with a banned tool: must fail every time, naming the tool;
   - 200 times on a clean small SBOM: must pass every time;
   - on an SBOM padded past the pipe buffer (6,000 runtime names that sort after every checked name), for every default DENY_LIST entry: must fail every run, naming that tool; a clean padded SBOM must pass; each REQUIRE_LIST package really missing must still fail, naming it.
   The deny and require lists are read from the script's own defaults, so the spec follows later edits to them.

## Why no gate is weakened
Same lists, same messages, same exit codes, same order of checks. The only behaviour change: a present name is always found (the denylist can no longer fail open and the require list can no longer fail spuriously), and an unexpected grep error now fails the gate instead of being read as "absent".

## Failing-before / passing-after
| Run | Head | Result |
|---|---|---|
| [CI lane 37175426937](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175426937/job/111356939600) | `022fbe3c` (main + new spec, script unchanged) | RED as intended: 14 failed / 107 passed. Every padded-SBOM case fails: all 11 denylisted tools go unreported and the gate fails with "required runtime package '@nestjs/core' missing" instead; the clean padded SBOM fails the same way. The 200-run small-SBOM cases passed in that run (the race is intermittent there; locally 1 of 100 runs passed with eslint present). `test/ci/delivery-artifact.spec.ts` passed. |
| build-and-test on this PR | `3624ab5f` (fix) | filled in when green |

## Out of scope (reported to the operator)
The same `echo "${names}" | grep -qx "${name}"` shape under `set -euo pipefail` appears in four fly-*-set workflows (secret-name verification). There it fails closed (a present name can read as missing, never the reverse). Those workflows are outside this job.

