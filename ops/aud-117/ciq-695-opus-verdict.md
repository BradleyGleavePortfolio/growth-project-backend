AUDIT Claude Opus 5.5 — growth-project-backend#695 @ e80cefad04e22fbca9f1ff147746ca6684c50f89 — VERDICT: APPROVE

A/B/C = 0/0/2

Lens: AUD-OPUS-CI-117 (operator agent 117). Tier T4: `scripts/ci/assert-prod-sbom.sh` decides the required `build-sbom` check and is re-run by `scripts/ci/release-evidence-gate.sh`. This is this lens's first verdict on the PR, and no earlier evidence was reused. The head was re-read right before posting. This lens did not read the other lens's verdict.

### Scope
- **Diff against main a5b605d1:** 2 files. `scripts/ci/assert-prod-sbom.sh` (+15/-2) and `test/ci/assert-prod-sbom-determinism.spec.ts` (+173). Every line was read.
- **Commits:** 022fbe3c (spec), 3624ab5f (fix), e80cefad (operator, test-only, one line).
- **e80cefad, byte-checked:** line 167 now escapes with `/[.*+?^${}()|[\]\\/]/g` and replacement `\$&`, the same as line 120.
  - The character class covers every RegExp metacharacter plus `/`, and each match gets one backslash.
  - The three required names contain only `.` and `/`, so their patterns are unchanged and no verdict can change.
  - No code-scanning alert is open on `refs/pull/695/head`; alert 123 is closed.

### Root cause and fix
- **Root cause (confirmed):** the script runs under `set -Eeuo pipefail` and checks names with `printf '%s\n' "$NAMES" | grep -qxF "$d"`.
  - grep exits at its first match while the printf subshell may still be writing.
  - printf then dies of SIGPIPE (141), pipefail makes the pipeline non-zero, and a name that is present reads as absent.
  - On the denylist this fails open. On the require list it gives a false red ("required runtime package ... missing", the known flake).
  - When NAMES is larger than the 64 KiB pipe buffer, the failure happens on every run.
- **Fix (assert-prod-sbom.sh:63-76):** `has_name()` gives grep a here-string instead of a pipe.
  - The shell writes the whole document before grep runs: into a pipe when it fits the buffer, otherwise into a temp file. grep's early exit can no longer kill a writer, and the status returned is grep's own.
  - `-qxF --` means whole line, fixed string, and safe for names that start with `-`.
  - Status 0 or 1 is returned as is. Any other status calls `fail`, which exits the script. The function runs in the current shell, so this also holds inside `if` and `||`.
  - `|| rc=$?` keeps errexit from firing.
- **Output unchanged:** the deny and require failure messages are the same, so the expectations in `delivery-artifact.spec.ts` and `release-evidence-gate.sh` still hold. `delivery-artifact.spec.ts` passes at this head.
- **No other early-exit risk:** no other pipeline in the script can lose a match this way. `jq | sort -u` and `printf | tr` both read to the end of their input.

### Tests and CI
- **Failing-before (verified):** [lane run 37175426937](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37175426937) (job 111356939600) ran 8876bea7, which is main a5b605d1 plus this spec only, against main's script. Result: 14 failed / 107 passed.
  - The failures are all 11 padded deny cases, the padded clean case, and the padded "@prisma/client / prisma really missing" cases. Those two name the wrong package, because `@nestjs/core` reads as missing first.
  - The 200-run small cases passed in that run, so the padded cases are the deterministic proof.
  - e80cefad's one-line spec change does not touch those cases.
- **Passing-after:** [build-and-test job 111362792787](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37176998382/job/111362792787) at this head. `assert-prod-sbom-determinism.spec.ts` passes in 28.7 s, `delivery-artifact.spec.ts` passes, and 715 suites passed.
- **The spec is sound:**
  - Each run is checked on both exit code and message.
  - It reads the script's own default lists.
  - The padding names sort after every checked name.
  - "Really missing" negative controls are kept.
  - The child process gets only PATH and HOME, so nothing is written to `GITHUB_OUTPUT`.
- **Real SBOM:** [build-sbom job 111361596748](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37176998410/job/111361596748) reports "OK 351 components, 0 dev-only leaks, required runtime packages present" on the real production SBOM.
- **Checks:** all 11 required checks are green at this head; shellcheck and actionlint are also green.

### C findings (optional)
- **C-695-1 (outside this diff, :46-55): a lockfile that jq cannot read silently turns off check 2.**
  - `lock_nv` runs inside process substitutions whose exit status is never checked, and both `comm` calls end in `|| true`.
  - Local counterexample (bash 5.3 with jq), using one SBOM that contains a dev-only component (`leftpad-devonly`):
    - With a valid lockfile that marks it `dev: true`, the script is red: "dev-only packages present".
    - With a lockfile that is not valid JSON, or a v1 lockfile with no `.packages`, jq prints "parse error" or "null (null) has no keys" to stderr and DEV_ONLY comes out empty.
    - The script then prints "OK 4 components, 0 dev-only leaks" and exits 0.
  - CI cannot hit this today, because `npm ci --omit=dev` in build-sbom needs a valid lockfile. Even so, the gate reports evidence it never computed.
  - Fix rule: compute `DEV=$(lock_nv dev)` and `PROD=$(lock_nv prod)` as plain command substitutions, so errexit and pipefail catch a jq failure. Fail when PROD is empty, then run `comm` on those values. Do the same for COMPONENTS.
  - How to verify the fix: an unreadable lockfile must exit 1 with a named reason.
- **C-695-2: `has_name` treats a here-string redirection failure as "absent".**
  - When bash cannot create the here-string, the command exits with status 1, the same status as "no match".
  - Local counterexample: `has_name` copied verbatim and run under `ulimit -n 3` or `ulimit -n 4`. bash prints "cannot create temp file for here-document: Too many open files", eslint reads as absent, and the script exits 0.
  - In the real script a persistent failure still ends red, because the require loop runs after the deny loop and reports '@nestjs/core' missing. Only a transient failure during a deny check could let a banned tool through.
  - Fix rule: use a membership test with no fork and no redirection, for example `[[ $'\n'"$NAMES"$'\n' == *$'\n'"$1"$'\n'* ]]`. The operand is quoted, so it matches literally.
  - How to verify the fix: the ulimit repro must report the name as present.

APPROVE: zero A and zero B. Both C items are optional. C-695-1 is a good small follow-up PR after this one lands.

Repro files and logs: ops/aud-117/AUD-OPUS-CI-117/ (local-repro/, lane-695-before.log, bt-695-e80cefad.log, sbom-695.log).

