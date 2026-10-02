# Deploy Readiness Runbook (R100)

**Who this is for:** Bradley (and any operator managing The Growth Project backend).

**Plain-English summary:** Before this product takes real money from real users, every integration has to be genuinely wired up, every safety switch has to be set correctly, and no placeholder code can sneak into production. Keeping that list in your head does not scale. This runbook explains the one automated board that checks all of it for you, how to read it, and what to do when it says do not deploy.

---

## What the board is

There is a single test, `test/deploy-readiness.spec.ts`, that runs eight checks and prints one board. Most checks came from an earlier piece of work (labelled H4.A through H4.G); ENV REGISTRATION was added by S-ENVTRUTH. The board ties them together so you get one yes-or-no answer instead of separate reports.

The sections are:

| Section | Question it answers |
| --- | --- |
| STUB VALUES | Are there any leftover placeholder or stub values in production code that must be removed before launch |
| PROD SWITCHES | Is every production safety switch declared coherently in the registry, and is every must-set switch actually set |
| ENV REGISTRATION | Is every environment variable name the code reads (directly, through ConfigService, through a helper, or built from a template such as `${PROVIDER}_CLIENT_ID`) registered in `src/common/env-validation.ts` with a tier, real default and reason |
| WIRING | Is every third-party integration (Stripe, Mux, SendGrid, Supabase, OpenAI, Twilio, Cloudflare, AWS S3, Fly, Sentry) actually credentialed rather than stubbed |
| ENV DISCOVERY | Is every environment variable referenced in the code also registered in the switch registry |
| AUTO-FLIPPER | Which switches would automatically flip to their production value on a production deploy (informational, never blocks) |
| OPERATOR KEYS | Which keys and secrets you, the operator, still need to provide |
| AGGREGATE EXIT | The single tally of red lines across every blocking section |

The board ends with one of two lines:

- `EXIT: ALL CLEAR -> SAFE TO DEPLOY` when there are no blocking red lines.
- `EXIT: N STUB + N PROD SWITCHES WRONG + N PROD SWITCHES WARN + N WIRING GAPS + N ENV GAPS + N KEY GAPS + N ENV UNREGISTERED -> DO NOT DEPLOY` when there is at least one.

**WRONG vs WARN.** The exit line carries two prod-switch buckets, and they gate differently. `PROD SWITCHES WRONG` counts switches whose declaration is genuinely incoherent — a codebase-invariant defect that does not depend on which secrets are loaded — so it blocks on both surfaces: it gates the informational PR check and the strict prod-deploy gate alike. `PROD SWITCHES WARN` counts environment-dependent switch findings (for example an unset or placeholder switch the runner has no secret for); like WIRING, ENV, and KEY gaps it is surfaced everywhere but only counts toward the gate under strict mode (the prod-deploy gate), not on a pull request. So a non-zero WARN bucket will fail the prod-deploy gate but is informational-only on the PR check, where the runner carries no production secrets.

**ENV UNREGISTERED** counts env names that runtime `src/` reads but `ENV_RULES` does not register (plus unrecorded dynamic reads). It depends only on committed code, so like STUB and PROD SWITCHES WRONG it blocks on the pull request check as well as on the prod-deploy gate. The same invariant is enforced on its own by `test/prod-readiness/env-registration.spec.ts`, which runs in the normal `build-and-test` job.

---

## The two ways the board runs

The same test runs on two surfaces, and it behaves differently on each. This is deliberate.

### On every pull request: informational

The `test-deploy-readiness` job runs on each pull request. It is informational: it posts the board as a comment on the pull request and does not block the merge during the pre-launch burn-down.

On a pull request it gates only the checks that depend purely on the committed code: STUB VALUES, PROD SWITCHES, and ENV REGISTRATION. The other three blocking checks (WIRING, ENV DISCOVERY, OPERATOR KEYS) depend on which secrets are loaded into the environment. A pull request runner has no production secrets, so it would always see every integration as un-credentialed. Failing the pull request on that would be a false alarm, so those sections are printed for your awareness but do not block.

### On a production deploy: hard block

The `deploy-readiness-gate` job runs when you trigger a production deploy (manually via workflow dispatch, or by pushing to a `release/*` branch). It sets `DEPLOY_READINESS_STRICT=1`, which turns on strict mode: now every blocking section counts, including wiring, env discovery, and operator keys. If any section has a red line, the job exits non-zero and the deploy stops.

Because the production deploy environment is where the real secrets live, a genuinely ready build shows ALL CLEAR there and the deploy proceeds.

---

## How to run it yourself

From the backend repository root:

```
# Full board, informational (the pull-request view).
npm run test -- test/deploy-readiness.spec.ts

# Fast stub-only scan (what the pre-commit hook runs).
DEPLOY_READINESS_MODE=quick npm run test -- test/deploy-readiness.spec.ts

# Strict prod-deploy gate (what the deploy job runs). Requires the production
# secrets to be present in the environment to come back ALL CLEAR.
DEPLOY_READINESS_STRICT=1 npm run test -- test/deploy-readiness.spec.ts
```

The board is printed to the test log in all modes.

---

## What to do when it says DO NOT DEPLOY

Read the exit line. It tells you exactly which bucket has the problem and how many.

1. **STUB N** — open the STUB VALUES section. Each `[BLOCK]` line names a file and line with a leftover placeholder. Either finish the implementation, or, if it is a known and intentional placeholder, record it as tracked debt in the learning ledger at `test/prod-readiness/__fixtures__/learning-ledger.json` with a rationale. Tracked debt is downgraded from blocking to a warning automatically.

2. **PROD SWITCHES WRONG N** — open the PROD SWITCHES section. A coherence error means the registry itself disagrees with itself (for example a switch declared two different ways). Fix the registry at `prod-switches.yml`.

3. **WIRING GAPS N** — open the WIRING section. Each `[STUB]` line names an integration and which environment variables are missing or still placeholders. Provide the real credentials as Fly secrets.

4. **ENV UNREGISTERED N** — open the ENV REGISTRATION section. Each `[UNREGISTERED]` line names an env var and the files that read it. Add a rule to `ENV_RULES` in `src/common/env-validation.ts` with `tier`, `default` (what the code really does when it is unset) and `reason`. Providers that are not used in v1 are `optional` with a reason that says so. A `[DYNAMIC]` line is a read whose name is not a literal; record the names it can take in `DYNAMIC_ENV_SITES` in `test/prod-readiness/env-registration.ts`.

5. **ENV GAPS N** — open the ENV DISCOVERY section. Each `[GAP]` line names an environment variable the code reads but the registry does not declare. Add it to `prod-switches.yml`.

6. **KEY GAPS N** — open the OPERATOR KEYS section. It lists, as ready-to-run `fly secrets set` lines, every secret you still owe. Run them.

After any fix, re-run the board until the exit line reads ALL CLEAR.

---

## Checking and filling the real Fly environment (S-ENVTRUTH)

The board checks the code. Two operator workflows check and fill the real production machine. Both are manual (`workflow_dispatch`), both are restricted to the `backend-spring-lake-3890` app, and both are bound to the `production` GitHub environment. Neither ever prints a secret value.

### 1. Fly Env Truth (read-only): what is actually set

`.github/workflows/fly-env-truth.yml`. Run it first, and again after any change.

```
gh workflow run "Fly Env Truth (operator, read-only)" -f app=backend-spring-lake-3890
# optional: -f machine=<fly machine id> to pick a specific machine
```

What it does: it builds the list of registered names from `ENV_RULES`, ships the classifier in `scripts/env-truth/fly-env-classifier.js` into the production machine as an inline `node -e` program over `flyctl ssh console -C`, and runs it there. For every registered name and every env var present in the machine it reports present or missing, empty, placeholder pattern (for example angle brackets, `changeme`, a run of X characters, a known development default, an `example.com` URL, a Stripe test-mode key), duplicate group (keys that share one value, compared in-machine with a random per-run salt that never leaves the machine), length bucket, whether the name is registered, and whether the name looks truncated (for example `E`). It also runs two value-shape checks that report pass, fail or missing only: `APPLE_AUDIENCES` must be a comma list whose first entry is exactly the iOS bundle id `com.growthproject.app` (Sign in with Apple and deletion-time token revocation depend on it), and `ANDROID_CERT_SHA256_FINGERPRINTS` must be non-empty with every entry a colon-separated SHA-256 fingerprint. Only that value-free report comes back. It is shown as the job summary and kept as the `env-truth-report` artifact (JSON plus markdown) for 30 days. The workflow never writes to Fly.

How to read it: `Registered but missing` is your fill-in list (check each name's tier and reason in `ENV_RULES`; `optional` names marked "Not used in v1" can stay unset). Anything under `Flagged` with a placeholder pattern or an unexpected duplicate group needs a real value. `Present but unregistered` lists Fly-side names no code reads (cleanup candidates; nothing is removed automatically).

Requirement: `FLY_API_TOKEN` must be allowed to open an ssh session on the app (an org or app deploy token is enough; a read-only token is not).

### 2. Fly Env Sync: reconcile Fly with the desired-state manifest

`.github/workflows/fly-env-sync.yml` is the only path that changes launch flags and GitHub-sourced secrets on Fly. It applies `.github/fly-env-desired-state.json`. Full runbook: [launch-flags.md](launch-flags.md).

```
gh workflow run "Fly Env Sync (operator)" -f app=backend-spring-lake-3890 -f mode=plan
gh workflow run "Fly Env Sync (operator)" -f app=backend-spring-lake-3890 -f mode=apply -f confirm=SET
```

`plan` is read-only. It prints, for each managed name, the declared state, the Fly status, an in-machine match / differs / absent result and the action. Names, statuses and those words are the only output: no value, no digest. `apply` stages exactly the planned changes (`--stage`, no restart) and proves every managed name is present or absent as declared. Add `-f deploy_staged=true` to apply them now with one rolling restart, which is skipped when nothing changed, then prove the running machine matches. A secret whose manifest entry is `github-secret` is copied from the GitHub Actions secret of the same name; the plan fails with a fix if that secret is empty. The Apple sign-in keys are not in the manifest; their own workflow handles them.

`GOOGLE_CLIENT_IDS` is marked required for launch (`launch: 'required'` in `ENV_RULES`): flip its manifest entry to `github-secret` to copy it. The Google Calendar OAuth names are declared `present` (they are on Fly today and owned elsewhere); the calendar flags are excluded and stay off.

After an apply without `deploy_staged`, deploy as usual, then run the plan again (every row should read `keep`) and Fly Env Truth to confirm.

---

## Operator setup after this lands

First, understand which of the two jobs a branch-protection required check can even apply to. A branch-protection required status check gates **pull requests into `main`**, so only a job that runs on `pull_request` is eligible. Of the two gating jobs:

- `test-deploy-readiness` **runs on every pull request** (no `paths:` filter), so it is PR-eligible and can be a required check.
- `deploy-readiness-gate` **does not run on pull requests**. It only runs on `workflow_dispatch` and on push to `release/*`, and it enforces itself by exiting non-zero (hard-blocking, no `continue-on-error`) on those surfaces. It needs no branch-protection wiring, and it must **never** be added to the required-check list: a required check that never reports on a pull request stays permanently pending and blocks every merge to `main`.

With that in mind, the operator actions after this merges:

1. `deploy-readiness-gate` is already enforced by its own workflow trigger — there is nothing to add to branch protection for it. Do **not** add it to `scripts/setup-branch-protection.sh`; doing so would permanently block every pull request. The strict prod-deploy block is live the moment the workflow is on `main`.

2. `test-deploy-readiness` is the PR-eligible check and is already listed in the canonical required-check list in `scripts/setup-branch-protection.sh`. Running that script makes it a required check that blocks merges. If you want to keep it informational for longer during the pre-launch burn-down, comment its line out of `REQUIRED_CHECKS` before running the script, and re-add it once the board has been stable for a while.

---

## Where the pieces live

| Piece | Path |
| --- | --- |
| The orchestrator board and its tests | `test/deploy-readiness.spec.ts` |
| The section registry (which scanners run, in what order, gating or informational) | `test/prod-readiness.config.ts` |
| The sub-scanners (including `env-registration.ts`) | `test/prod-readiness/` |
| The env registry (tier, real default, reason for every env name) | `src/common/env-validation.ts` (`ENV_RULES`) |
| The in-machine env-truth classifier | `scripts/env-truth/fly-env-classifier.js` |
| The env workflows | `.github/workflows/fly-env-truth.yml`, `.github/workflows/fly-env-sync.yml` |
| The switch registry | `prod-switches.yml` |
| The learning ledger (false positives and tracked debt) | `test/prod-readiness/__fixtures__/learning-ledger.json` |
| The CI workflow with both jobs | `.github/workflows/h4-readiness.yml` |
