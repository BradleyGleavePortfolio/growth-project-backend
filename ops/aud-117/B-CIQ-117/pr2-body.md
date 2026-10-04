## Tier
- **Tier:** T4
- **Why:** Changes a CI gate script: `scripts/ci/assert-prod-sbom.sh` decides the required `build-sbom` check (`.github/workflows/sbom.yml`) and is re-run by `scripts/ci/release-evidence-gate.sh` before a deploy.
- **T4 trigger scan:** CI gate file `scripts/ci/assert-prod-sbom.sh` (new fail-closed checks; no list, threshold, message of an existing failure or exit path removed). No workflow, required check name, branch protection, dependency or lockfile change.
- **T3 trigger scan:** none (no runtime code, migration, env, dependency or lockfile change).
- **Bounded T1:** NO (CI gate file).
- **Canonical builder:** Claude Opus 5.5 (job B-CIQ-117, operator agent 117).
- **Parent owner:** operator agent 117.
- **Acceptance evidence:** failing-before CI-lane run on main's script (link below), the same spec green on this head, the real production SBOM passing `build-sbom`, and all required checks green.
- **Promotion triggers:** none beyond T4. Re-grade if a later change edits DENY_LIST, REQUIRE_LIST or the sbom.yml proof step.

## Fix round table
| Round | Head | Change |
|---|---|---|
| 0 | `40ce1757` | Initial PR (closes C-695-1 and C-695-2 from the #695 Opus verdict, issuecomment-5976723698) |

## Problem
1. **C-695-1: an unreadable lockfile turned off check 2 and still printed "0 dev-only leaks".** Main (`assert-prod-sbom.sh:46-55`) ran `lock_nv` inside process substitutions whose exit status nothing checked, and both `comm` calls ended in `|| true`. A lockfile that is not JSON, or a v1 lockfile with no `.packages`, made jq fail on stderr, `DEV_ONLY` came out empty, and the script printed `OK ... 0 dev-only leaks` and exited 0 with a dev-only package in the SBOM. The gate reported evidence it never computed.
2. **C-695-2: `has_name` read a failed here-string as "absent".** `grep -qxF -- "$1" <<<"$NAMES"`: when bash cannot create the here-string (no free file descriptor, no temp file), the command exits 1, the same status as "no match". A banned build tool then passes the denylist. A persistent failure still ended red through the require loop, but with the wrong reason ("required runtime package '@nestjs/core' missing").

## Change (2 files)
1. `scripts/ci/assert-prod-sbom.sh`
   - The SBOM `components` must be a list; the lockfile must be valid JSON and have a `packages` object (npm lockfile v2/v3); it must list at least one production package. Each failure names its reason and the next action.
   - `COUNT`, `COMPONENTS`, `DEV`, `PROD`, `DEV_ONLY`, `LEAK` and `NAMES` are plain command substitutions, each checked with `|| fail "<reason>"`. No `|| true` remains, so a jq, sort or comm failure stops the gate instead of yielding an empty list.
   - `has_name` is `[[ $'\n'"${NAMES}"$'\n' == *$'\n'"$1"$'\n'* ]]`: a pure shell pattern match with no pipe, redirection, temp file or child process. The quoted operand matches literally (`*`, `?`, `[` are not patterns); whole names only.
   - Unchanged: DENY_LIST, REQUIRE_LIST, every existing failure message, check order, the OK and sha256 lines and `GITHUB_OUTPUT`.
2. `test/ci/assert-prod-sbom-fail-closed.spec.ts` (new): runs the real script on a not-JSON lockfile, a v1 lockfile, a non-object `packages`, a lockfile with no production package and an SBOM whose `components` is a string (each must exit 1 with its named reason and never print the OK line), plus two controls (a readable lockfile still catches the dev-only package; a clean SBOM still passes). It also runs the script's own `has_name`, extracted verbatim, under `ulimit -n 3`: a present name must read as present, an absent one as absent, and partial or glob-like names must not match.

## Failing-before / passing-after
| Run | Head | Result |
|---|---|---|
| [CI lane 37180305649](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180305649) | `d3fe41b3` (main `b644198b` + new spec, script unchanged) | filled in when complete |
| build-and-test, build-sbom on this PR | `40ce1757` | filled in when green |

Local run before the fix (bash 5.3, jq 1.8.1): 7 failed / 3 passed. The not-JSON, v1 and non-object lockfiles and the lockfile without production packages each printed `assert-prod-sbom: OK 4 components, 0 dev-only leaks, required runtime packages present` (or `OK 3`); `has_name` under `ulimit -n 3` printed `ABSENT` for a present `eslint` with "cannot create temp file for here-document: Too many open files". After the fix: `assert-prod-sbom-fail-closed`, `assert-prod-sbom-determinism`, `delivery-artifact` and `release-evidence-gate` specs: 4 suites, 174 tests passed.

## Why no gate is weakened
Every input the old script accepted with a real result gives the same result and message. The only behaviour changes: inputs the old script could not read now fail with a named reason instead of passing, and a name check can no longer fail and read as "absent".
