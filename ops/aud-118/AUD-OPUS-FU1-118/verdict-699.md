AUDIT Claude Opus 5.5 — growth-project-backend#699 @ 40ce17578ca8b70d80a5ff8d22237ca1239062bd — VERDICT: APPROVE

A/B/C = 0/0/2

Lens: AUD-OPUS-FU1-118 (agent 118). Tier T4: `scripts/ci/assert-prod-sbom.sh` decides the required `build-sbom` check (`sbom.yml:66`) and is re-run by `scripts/ci/release-evidence-gate.sh:175` before a deploy. This is this lens's first verdict on the PR. The only earlier evidence used is this model's own #695 verdict (issuecomment-5976723698), whose two C findings this PR closes. This lens did not read the other lens's verdict. The head was re-read right before posting.

### Scope
- **Diff against main b644198b:** 2 files, +205/-16 (221 lines). Every line was read.
  - `scripts/ci/assert-prod-sbom.sh` (+30/-16)
  - `test/ci/assert-prod-sbom-fail-closed.spec.ts` (+175, new)
- **Commits:** d3fe41b3 (spec), 40ce1757 (fix).

### Prior findings of this lens (#695)
- **C-695-1: closed, exactly per the fix rule.**
  - `COUNT`, `COMPONENTS`, `DEV`, `PROD`, `DEV_ONLY`, `LEAK` and `NAMES` are now plain command substitutions, each followed by `|| fail "<reason>"`.
  - The lockfile must be valid JSON, must have a `packages` object (v2/v3), and must list at least one production entry.
  - No `|| true` remains.
- **C-695-2: closed, exactly per the fix rule.** `has_name` is now `[[ $'\n'"${NAMES}"$'\n' == *$'\n'"$1"$'\n'* ]]`, which opens no descriptor and starts no child process.
- **Failing-before (verified):** [lane 37180305649](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180305649/job/111371364486) ran at 1ac6918f, which is d3fe41b3 plus only the lane files, against main's script.
  - Result: 7 failed / 3 passed.
  - The not-JSON, v1, non-object and no-production lockfiles each printed `OK ... 0 dev-only leaks` and exited 0.
  - Under `ulimit -n 3`, a present `eslint` read as ABSENT.

### Fail-closed proof: negative cases independent of the builder's spec
- **Probe:** `test/ci/aud-opus-fu1-699-probe.spec.ts` on `audit/AUD-OPUS-FU1-118/699-failclosed` (PR head plus the probe only). The probe runs the real script.
- **Setup:** every SBOM carries either a dev-only package (`leftpad-devonly@1.0.0`) or a banned tool (`eslint`). Each case must exit non-zero and must never print the OK line.
- **Cases:**
  - jq dies part-way through the lockfile read: it prints a partial line, then exits 5 (PATH shim).
  - `comm` exits 1 with no output.
  - `sort` exits 2 after reading its input.
  - jq fails on `.components[].name` while `eslint` is present.
  - A lockfile entry is a string (jq type error mid-stream).
  - An SBOM component is a string.
  - `ulimit -n` set to 4, 5, 6, 7, 8, 9, 10, 12, 16 and 32, with the leak and with `eslint`.
  - Controls: a clean SBOM passes, and the leak and `eslint` cases each go red with their own message.
- **Head: GREEN.** [Run 37218264213](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218264213/job/111483141120): 27/27 passed, together with the builder's spec.
- **Same probe on main's script: RED.** [Run 37218292510](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37218292510/job/111483225796): 3 failed.
  - Each of these three cases printed `OK 4 components, 0 dev-only leaks` and exited 0: the partial-jq case, the comm-fails case, and `ulimit -n 6` (where comm cannot open `/dev/fd/N`).
  - So the probe tells the two scripts apart. The head also closes three fail-open paths that the builder's spec does not name.

### Reasoning checks
- **Failures stop the script.** In `VAR=$(a | b) || fail`, pipefail makes the substitution non-zero when any stage fails. `fail` runs in the main shell, so it exits the script. `lock_nv` returns the status of its own pipeline.
- **Remaining process substitutions:** the `<(printf '%s\n' "$X")` substitutions that are left only print variables that were already computed. If bash cannot open the descriptor, `comm` fails and `|| fail` fires (the `ulimit -n 6` case).
- **A lockfile with no dev entries still passes**, as before. `printf` of an empty variable gives one empty line, `comm` prints nothing, and LEAK is empty.
- **comm's sort-order check is now fatal** instead of hidden by `|| true`.
  - Both inputs come from `sort -u` in the same locale, and the real SBOM passes: [build-sbom job 111371875542](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37180479160/job/111371875542) reports "OK 351 components, 0 dev-only leaks".
  - A collation mismatch would make the check red, never green.
- **has_name:**
  - The left side of the match is not a pattern, and the quoted right side matches literally.
  - Names come from unquoted word splitting of DENY_LIST and REQUIRE_LIST, so a name is never empty.
  - The `ulimit -n 3` spec also checks partial names and glob-like names.
- **Callers still work:**
  - `package-lock.json` is `lockfileVersion: 3`, so the new v2/v3 requirement cannot turn main or the release evidence gate red.
  - `delivery-artifact.spec.ts`, `assert-prod-sbom-determinism.spec.ts` and `release-evidence-gate.spec.ts` pass at this head.
- **Nothing else changed:** DENY_LIST, REQUIRE_LIST, the check order, the OK and sha256 lines, and `GITHUB_OUTPUT` are all the same.

### CI
All 11 required checks are green at this head. shellcheck and actionlint are also green. Size: 221 lines.

### C findings (optional)
- **C-699-1 (`scripts/ci/assert-prod-sbom.sh:38`): the error names the wrong tool as the next step.**
  - The message says "regenerate the SBOM with cdxgen". But `sbom.yml:60` generates the SBOM with `npm sbom --sbom-format cyclonedx --sbom-type application`, and `@cyclonedx/cdxgen` is on DENY_LIST.
  - A related message change: a CycloneDX document with no `components` key used to fail with "SBOM has zero components; an empty scan is not evidence". It now fails with this message, although the PR body says no existing message changed.
  - Fix rule: name the generator that is really used (for example "regenerate it with the sbom.yml step (npm sbom --sbom-format cyclonedx)"). Optionally keep the zero-components wording for a missing key.
  - How to verify: the string-`components` case in the spec asserts the new wording.
- **C-699-2 (`scripts/ci/assert-prod-sbom.sh:7-15`, `docs/delivery-controls.md:101`): the documented exit conditions are out of date.**
  - The header's "Exits 0 only when" list and the delivery-controls doc do not mention the new lockfile conditions: valid JSON, a v2/v3 `packages` map, and at least one production entry.
  - Fix rule: add these conditions to both.

APPROVE: zero A and zero B. Both C items are optional and can be done in one small follow-up.

Lens notes and logs: ops/aud-118/AUD-OPUS-FU1-118/ (local-699/ shims, p699head.log, p699main.log, lane699before.log).
