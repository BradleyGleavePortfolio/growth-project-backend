# AUD-OPUS-CI-117: Claude Opus 5.5 lens on backend #694 and #695 (operator agent 117)

Job entry: lanes117/JOBS117.md "AUD-OPUS-CI-117 / AUD-SOL-CI-117". This lens did no heavy local work.
- The only probe ran in the CI lane.
- Two tiny bash repros ran locally (milliseconds each).
- Claims: lanes117/claims/backend-694-61d42f09-opus and lanes117/claims/backend-695-e80cefad-opus.
- Notes, logs, the verdict bodies, a probe copy and the patch are in /home/user/workspace/ops/aud-117/AUD-OPUS-CI-117/.
- Independence: this lens did not read the GPT-6.1 Sol verdicts at these heads (5976663072 on #694, 5976686097 on #695).

## 1. backend #694 @ 61d42f09077a1786b48ab68164f9e4921a795178: APPROVE, A/B/C = 0/0/2
- **Verdict:** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/694#issuecomment-5976723615
- **Scope:** 3 files against main a5b605d1: `jest.config.js`, the gate spec (894 lines) and the probes spec (214 lines). Every line of both specs was read.
- **Round 1 (8346b1ac) is a pure main merge:** its tree `085019b0` equals the merge-tree of 14c84c75 and a5b605d1.
- **Evidence reused (G09):** `jest.config.js` is byte-identical to 14c84c75, which this model's lens approved (5976166775). The toolchain is unchanged (jest 30.4.2, ts-jest 29.4.9, TypeScript 5.9.3), so that verdict's transpile-mode and root-cause evidence still applies.
- **Prior findings, all closed:** Opus C-694-1 and C-694-2; Sol B-694-1 and C-694-2.
  - Each closure has a failing-before run on the round-0 guard. Lane 37175679844: 9 probes red; 7 passed (baseline, 3 controls and 3 guard tests). Lane 37174744226 also ran the round-0 guard.
- **Independent lens probe:** lane run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37177952064 (job 111364428783). The commit was 39a99cc9 = PR head plus probe files only.
  - **Real disk:** a spec placed under `test/ci/__fixtures__/` has a type error. Jest runs it transpile-only and it passes. The UNCHANGED guard goes red and names that file, for both `jest.config.js` and `jest.rls.config.js`.
  - **VM, guard unchanged:** FC1-FC7 are red with precise violations:
    - `strictNullChecks:false` inherited through `extends`
    - `noCheck:true` inherited through `extends`
    - `files`/`include` narrowing
    - a multi-line run starting with `set +e`
    - `.ts` compiled by babel-jest (vacuity check)
    - ts-jest given a `tsconfig` path
    - a type-checking first transform in `jest.rls.config.js`
  - **Controls:** EQ1 (`working-directory: ./src/..`) and the control stayed green.
  - **Gaps:** GAP1-3 stayed green, which proves C-694-3 and C-694-4.
- **Check name:**
  - `.github` is untouched.
  - The job id is still `build-and-test`, with no `name:` key.
  - The check run is named `build-and-test`, and it is in the live required contexts (strict).
  - `branch-protection-checks.spec.ts` pins the reported names.
- **CI:** 11/11 required checks green. build-and-test job 111358251786:
  - jest time 190.97 s; 716 suites passed; 12,390 tests passed.
  - Peak per-suite heap 1,599 MB; no OOM.
  - Both guard suites ran in under 5 s.
- **C-694-3:** `needs:` on build-and-test is not pinned. A skipped dependent job may not block merging (GitHub docs). The same gap exists for all 11 required checks in `branch-protection-checks.spec.ts`. Fix rule: reject `needs`, or require every needed job to be unconditional and required. Verify: GAP1 goes red.
- **C-694-4:** the guard is static. It does not check the Type-check step's env beyond NODE_OPTIONS (PATH, for example), and it cannot see earlier steps that edit tsconfig.json or write GITHUB_ENV/GITHUB_PATH. Cheap partial fix: allow only `NODE_OPTIONS` among the effective env keys, and reject earlier steps whose run mentions tsconfig, GITHUB_ENV or GITHUB_PATH.

## 2. backend #695 @ e80cefad04e22fbca9f1ff147746ca6684c50f89: APPROVE, A/B/C = 0/0/2
- **Verdict:** https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/695#issuecomment-5976723698
- **Scope:** 2 files. The script (+15/-2) and the spec (+173) were read in full.
- **Operator commit e80cefad:** the escape class was byte-checked. It is complete, adds one backslash per match, and cannot change any verdict. No code-scanning alert is open on the PR ref.
- **Root cause confirmed:** `printf | grep -q` under pipefail lets SIGPIPE make a present name read as absent.
- **The fix is correct:**
  - The here-string means no writer process exists that grep's early exit could kill.
  - `-qxF --` matches whole lines, fixed strings, and is safe for names starting with `-`.
  - Status 0 or 1 is returned as is; any other status calls `fail`, which exits.
  - The output messages are unchanged.
- **Failing-before:** lane 37175426937 ran main's script with this spec: 14 failed / 107 passed. Every padded case is red, so the proof is deterministic.
- **Passing-after:** build-and-test job 111362792787: the determinism spec passed in 28.7 s and `delivery-artifact.spec.ts` passed.
- **build-sbom on the real SBOM:** "OK 351 components".
- **CI:** 11/11 required checks green. The head was green when the verdict was posted; the operator's READY comment was not there yet.
- **C-695-1 (outside this diff, script :46-55):** a lockfile that jq cannot read (invalid JSON, or v1 without `.packages`) silently turns off the dev-only check. The script prints "0 dev-only leaks" and exits 0. Reproduced locally: the same SBOM is red with a valid lockfile and green with a broken one (`local-repro/`). CI cannot hit it today, because `npm ci` needs a valid lockfile. Fix rule: plain command substitutions for `lock_nv`, and fail when PROD is empty.
- **C-695-2:** a here-string redirection failure gives status 1, which `has_name` reads as "absent". Reproduced with `ulimit -n 3` and `4` (`local-repro/hs.sh`). Under a persistent failure the script still ends red, because the require loop reports a missing package; only a transient failure during a deny check could pass a banned tool. Fix rule: a pure-bash membership test.

## Notes for the operator
- After this lens's audit, main moved to 0b0f5b82 (#611 merged), so both PRs are BEHIND. The update-branch merge is a rule-12 case: the operator posts a MERGE-ONLY TREE CHECK if every PR file stays byte-identical.
- #687 and #628 add the identical `workerIdleMemoryLimit: '2GB'` block to `jest.config.js`. The merge should be clean or a no-op. No open PR adds a `.ts` file to an excluded fixture tree, and none touches build-and-test's Type-check step, so landing #694 should not turn any open PR red.
- Out of scope (the builder already noted it): the same `echo | grep -qx` under pipefail appears in the fly-*-set workflows. It fails closed there, so the only effect is a false "missing".

## Cleanup
- **Remote branch** `audit/AUD-OPUS-CI-117/694-gate-probe`: deleted. No `audit/AUD-OPUS-CI-117/*` branches remain.
- **Worktrees removed** (no node_modules was linked): `wt/AUD-OPUS-CI-117-694`, `wt/AUD-OPUS-CI-117-695` and `wt/AUD-OPUS-CI-117-694probe`.

## HANDOFF
- **#694 @ 61d42f09: Opus APPROVE 0/0/2** (comment 5976723615). 11/11 required checks green. Sol has also posted APPROVE at this head. Merge state: BEHIND main 0b0f5b82.
  - Next step: operator update-branch, a MERGE-ONLY TREE CHECK (rule 12), then land.
  - Recommended default: land first, because it fixes the jest OOM flake.
  - C-694-3 and C-694-4 go to a follow-up. The `needs` pin belongs in `branch-protection-checks.spec.ts`, covering every required check.
- **#695 @ e80cefad: Opus APPROVE 0/0/2** (comment 5976723698). 11/11 required checks green. Sol has also posted APPROVE at this head. The operator's READY comment is still to be posted. Merge state: BEHIND.
  - Next step: operator READY (optional now), update-branch, a MERGE-ONLY TREE CHECK, then land.
  - Recommended default: land right after #694.
  - C-695-1 goes to a small follow-up PR, with a failing-before run on a broken lockfile. C-695-2 is optional.
- **Any fix round on either PR:** a fresh Opus lens audits only the delta. Use this report, the two verdicts, the probe copy (`ops/aud-117/AUD-OPUS-CI-117/zz-aud-opus-ci-117-gate-probe.spec.ts`, `probe-694.patch`) and `local-repro/`.
