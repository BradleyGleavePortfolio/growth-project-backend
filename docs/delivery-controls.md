# Delivery controls — what is enforced, what is claimed, what is not

Repository-local description of the fail-closed delivery path introduced
2026-09-20. This file is the canonical reference; anything that contradicts
it in `docs/deploy-runbook.md` is stale and should be fixed there.

## 1. Two separate authorizations

| Authorization                                              | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Who/what decides                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Merge to `main`**                                        | Branch protection / ruleset: 11 required checks (exactly the live list, read back 2026-10-02 after 16:41 PDT) `build-and-test`, `rls-floor-guard`, `rls-live-tests`, `mwb-3-live-tests`, `npm audit (high+critical, whole graph)`, `CodeQL JS/TS (javascript-typescript)`, `Banned cast tokens (R75 / R100.A2)`, `build-sbom`, `danger`, `Schema parity (migrations match schema.prisma)`, `community-live-tests` (owner 2026-10-02 16:38), all bound to the GitHub Actions app; strict up-to-date; enforce admins; linear history OFF (changing it needs the owner's explicit words); conversation resolution OFF (audits are issue comments); operator 2026-10-02. | `scripts/setup-branch-protection.sh` (NOT yet run — see §6).                                                                                                                                                                                                                                  |
| **Deploy to Fly**                                          | `Fly Deploy` (`.github/workflows/fly-deploy.yml`): `workflow_dispatch` only, `release_sha` + `confirm=deploy` inputs, job `Release evidence gate` (`scripts/ci/release-evidence-gate.sh`) then job `deploy` bound to environment `production`.                                                                                                                                                                                                                                                                                                                                                                                                                       | A human dispatch. Since 2026-11-26 the `production` environment has **no required reviewer**: the owner removed it and gave a standing approval for every deploy ("I auto approve all deploys from now on", #ALM-E7; decision ALM-D7 op 2, see §2.1), so the dispatch is the only human step. |
| **Run a production secrets, flag, seed or shell workflow** | The eight operator workflows of §2.2 (`fly-secrets-set`, `fly-db-secrets-set`, `fly-apple-signin-set`, `fly-launch-env-set`, `fly-recent-auth-set`, `fly-env-sync`, `fly-env-truth`, `house-seed`): `workflow_dispatch` only, job `secrets-environment-guard` (`scripts/ci/secrets-environment-guard.sh`), then the job bound to environment `production-secrets`.                                                                                                                                                                                                                                                                                                   | The owner approves each run in GitHub (decision ALM-D11 op 1, 2026-11-27). No operator or agent approves one.                                                                                                                                                                                 |

A green merge is **not** a deploy authorization. Nothing deploys on `push`.

## 2. Release evidence gate (`scripts/ci/release-evidence-gate.sh`)

Runs in the `evidence-gate` job with `contents/actions/security-events: read`
and refuses the release unless, for the **exact** `release_sha`:

1. the sha is 40-hex, is a commit on `origin/main` (not a fork, not a
   branch tip), and equals the checked-out `github.sha`;
2. every required workflow job (`REQUIRED_WORKFLOWS`, default
   `ci.yml=build-and-test|rls-floor-guard|rls-live-tests|mwb-3-live-tests;
codeql.yml=CodeQL JS/TS (javascript-typescript); sbom.yml=build-sbom;
dependency-audit.yml=npm audit (high+critical, whole graph)`)
   has a run **on that head sha** whose _newest_ attempt is
   `completed/success`; a newer failed run beats an older success; a
   missing, skipped, cancelled, in-progress or duplicate-name-with-one-failure
   job fails the gate;
3. a CodeQL analysis exists for that sha with an empty `error` and
   `rules_count > 0` (an "uploaded nothing" analysis is refused);
4. the `sbom.yml` artifact for that sha contains `sbom.cdx.json` and a
   matching `sbom.cdx.json.sha256`, and `scripts/ci/assert-prod-sbom.sh`
   re-proves it against the checked-out lockfile (no dev-only packages,
   production set present);
5. the `production` environment exists **and** `can_admins_bypass ==
false` (`REQUIRED_ENVIRONMENT`). A required reviewer is no longer
   demanded (§2.1): with no reviewer the gate logs `has no required
reviewer: deploys are auto-approved by the owner (ALM-D7 op 2, ...)`,
   with ≥1 reviewer it logs `has required reviewers and no admin bypass`,
   and the manifest records `required_reviewers` (the count) and
   `reviewer_rule` (`owner standing approval (ALM-D7 op 2)` or `required
human reviewer, no admin bypass`). Admin bypass is a hard requirement,
   not a recorded observation: the manifest does not carry the bypass flag;
   a bypass-enabled environment fails the gate, with or without a reviewer,
   and so does an unknown flag.

### 2.1 Required reviewer removed on the owner's word (2026-11-26)

On 2026-11-26 the owner removed the required reviewer from the `production`
environment ("I auto approve all deploys from now on", #ALM-E7; "done now
you can deploy", #ALM-E9) and chose decision ALM-D7 option 2 (#ALM-E16):
the gate accepts a `production` environment with no required human
reviewer. Admin bypass is still off.

What the gate still proves before any deploy: checks 1-4 above, unchanged
(the exact commit, every required workflow green on it, an uploaded CodeQL
analysis, the SBOM and its production-closure proof), that the
`production` environment exists with admin bypass off, and the manifest
names the rule that let the deploy through. The deploy job still runs in
that environment (`fly-deploy.yml`), so its other rules, such as a
deployment branch policy, still apply.

What is gone: the second human step. The person who dispatches `Fly
Deploy` on `main` with `confirm=deploy` and the exact sha is now the only
human decision; once the evidence is green, nobody else approves the
deploy job.

Putting the reviewer back takes two steps: (1) in GitHub, Settings >
Environments > `production` > Required reviewers, add at least one real
person and keep "Allow administrators to bypass configured protection
rules" off (the gate accepts this at once and logs the reviewer line);
(2) revert #1261 (merge commit `430cdb60`), the PR that made this
change, together with #1264, the docs follow-up that describes it, so the
gate again refuses a deploy when the environment has no reviewer.

Everything read is written to
`release-evidence/release-evidence-<release_sha>.json`
(`schema: tgp.release-evidence.v1`) and uploaded. The gate is a consumer of
checks; it does not run tests itself and cannot approve its own change.

Negatives are covered by `test/ci/release-evidence-gate.spec.ts`
(fixture GitHub API server) and `test/ci/delivery-artifact.spec.ts`.

### 2.2 Production secrets, flags, seed and shell wait for the owner (2026-11-27, decision ALM-D11 op 1)

Removing the `production` reviewer (§2.1) also removed the human approval
from every other workflow bound to `production`. On 2026-11-27 the owner
chose decision ALM-D11 option 1 (#ALM-E25): these workflows run only in a
separate environment, `production-secrets`, whose required reviewer (the
owner) approves each run. Code deploys stay automatic (§2.1).

What moved (each workflow's one real job now runs in `production-secrets`):

| Workflow                                                   | What it does to production                                                                                                                                                          | Secrets it reads                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fly Secrets Set (`fly-secrets-set.yml`)                    | writes the Stripe and Sentry keys and the public URLs to Fly (machines restart)                                                                                                     | `FLY_API_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SENTRY_DSN`                                                                                                                                 |
| Fly DB Secrets Set (`fly-db-secrets-set.yml`)              | writes the database URLs to Fly and deploys them                                                                                                                                    | `FLY_API_TOKEN`, `DATABASE_URL`, `DIRECT_URL`                                                                                                                                                               |
| Fly Apple Sign-In Secrets Set (`fly-apple-signin-set.yml`) | writes the Sign in with Apple key to Fly                                                                                                                                            | `FLY_API_TOKEN`, `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY`                                                                                                                                          |
| Fly Launch Env Set (`fly-launch-env-set.yml`)              | writes the checkout and AI cost secrets to Fly                                                                                                                                      | `FLY_API_TOKEN`, `GUEST_CHECKOUT_PII_SALT`, `LANDING_VIEW_HASH_SECRET`, `CHECKOUT_RECOVERY_SECRET`, `COACH_AI_MAX_ACTUAL_CENTS`, `COACH_AI_VALUE_MULTIPLIER`, `ANDROID_CERT_SHA256_FINGERPRINTS` (optional) |
| Fly Recent Auth Set (`fly-recent-auth-set.yml`)            | writes the recent-auth secret and its lifetime to Fly                                                                                                                               | `FLY_API_TOKEN`, `RECENT_AUTH_SECRET`, `RECENT_AUTH_TTL_MS`                                                                                                                                                 |
| Fly Env Sync (`fly-env-sync.yml`)                          | plan: opens a shell on a production machine to read names; apply: stages every launch flag and 32 secrets from GitHub, and with `deploy_staged` deploys them with a rolling restart | `FLY_API_TOKEN` and the 32 names its manifest sources from GitHub                                                                                                                                           |
| Fly Env Truth (`fly-env-truth.yml`)                        | opens a shell on a production machine and reports which names are set (no values)                                                                                                   | `FLY_API_TOKEN`                                                                                                                                                                                             |
| House Seed (`house-seed.yml`)                              | opens a shell on a production machine and writes the house program set (dry-run reads only); from `main` only                                                                       | `FLY_API_TOKEN`                                                                                                                                                                                             |

The 48 secret names the eight read (names only, never a value):

| name                               | workflows that read it                                                                                                                      | also read outside the eight  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `ANDROID_CERT_SHA256_FINGERPRINTS` | fly-launch-env-set                                                                                                                          | none                         |
| `APPLE_SIGNIN_KEY_ID`              | fly-apple-signin-set                                                                                                                        | none                         |
| `APPLE_SIGNIN_PRIVATE_KEY`         | fly-apple-signin-set                                                                                                                        | none                         |
| `CHECKOUT_RECOVERY_SECRET`         | fly-launch-env-set                                                                                                                          | none                         |
| `COACH_AI_MAX_ACTUAL_CENTS`        | fly-launch-env-set                                                                                                                          | none                         |
| `COACH_AI_VALUE_MULTIPLIER`        | fly-launch-env-set                                                                                                                          | none                         |
| `CONTRACT_PDF_URL_SECRET`          | fly-env-sync                                                                                                                                | none                         |
| `DATABASE_URL`                     | fly-db-secrets-set                                                                                                                          | none                         |
| `DATA_EXPORT_DOWNLOAD_SECRET`      | fly-env-sync                                                                                                                                | none                         |
| `DIRECT_URL`                       | fly-db-secrets-set                                                                                                                          | none                         |
| `FITBIT_CLIENT_ID`                 | fly-env-sync                                                                                                                                | none                         |
| `FITBIT_CLIENT_SECRET`             | fly-env-sync                                                                                                                                | none                         |
| `FLY_API_TOKEN`                    | fly-secrets-set, fly-db-secrets-set, fly-apple-signin-set, fly-launch-env-set, fly-recent-auth-set, fly-env-sync, fly-env-truth, house-seed | fly-deploy, fly-secrets-list |
| `GARMIN_CLIENT_ID`                 | fly-env-sync                                                                                                                                | none                         |
| `GARMIN_CLIENT_SECRET`             | fly-env-sync                                                                                                                                | none                         |
| `GARMIN_WEBHOOK_SALT`              | fly-env-sync                                                                                                                                | none                         |
| `GOOGLE_CLIENT_IDS`                | fly-env-sync                                                                                                                                | none                         |
| `GOOGLE_OAUTH_CLIENT_ID`           | fly-env-sync                                                                                                                                | none                         |
| `GOOGLE_OAUTH_CLIENT_SECRET`       | fly-env-sync                                                                                                                                | none                         |
| `GOOGLE_OAUTH_REDIRECT_URI`        | fly-env-sync                                                                                                                                | none                         |
| `GUEST_CHECKOUT_PII_SALT`          | fly-launch-env-set                                                                                                                          | none                         |
| `LANDING_VIEW_HASH_SECRET`         | fly-launch-env-set                                                                                                                          | none                         |
| `METRICS_AUTH_TOKEN`               | fly-env-sync                                                                                                                                | none                         |
| `MWB_AUTOSAVE_LOCK_TOKEN_SECRET`   | fly-env-sync                                                                                                                                | none                         |
| `OURA_CLIENT_ID`                   | fly-env-sync                                                                                                                                | none                         |
| `OURA_CLIENT_SECRET`               | fly-env-sync                                                                                                                                | none                         |
| `POLAR_CLIENT_ID`                  | fly-env-sync                                                                                                                                | none                         |
| `POLAR_CLIENT_SECRET`              | fly-env-sync                                                                                                                                | none                         |
| `PUBLIC_LISTING_CURSOR_SECRET`     | fly-env-sync                                                                                                                                | none                         |
| `RECENT_AUTH_SECRET`               | fly-recent-auth-set                                                                                                                         | none                         |
| `RECENT_AUTH_TTL_MS`               | fly-recent-auth-set                                                                                                                         | none                         |
| `SCHEDULING_WEBHOOK_SECRET`        | fly-env-sync                                                                                                                                | none                         |
| `SENTRY_DSN`                       | fly-secrets-set                                                                                                                             | fly-deploy                   |
| `SIGNUP_MARKER_SIGNING_SECRET`     | fly-env-sync                                                                                                                                | none                         |
| `STRAVA_CLIENT_ID`                 | fly-env-sync                                                                                                                                | none                         |
| `STRAVA_CLIENT_SECRET`             | fly-env-sync                                                                                                                                | none                         |
| `STRIPE_SECRET_KEY`                | fly-secrets-set                                                                                                                             | none                         |
| `STRIPE_WEBHOOK_SECRET`            | fly-secrets-set                                                                                                                             | none                         |
| `SUPABASE_ANON_KEY`                | fly-env-sync                                                                                                                                | none                         |
| `SUPABASE_SERVICE_ROLE_KEY`        | fly-env-sync                                                                                                                                | none                         |
| `VOICE_KEY_SIGNING_SECRET`         | fly-env-sync                                                                                                                                | none                         |
| `WAHOO_CLIENT_ID`                  | fly-env-sync                                                                                                                                | none                         |
| `WAHOO_CLIENT_SECRET`              | fly-env-sync                                                                                                                                | none                         |
| `WHOOP_CLIENT_ID`                  | fly-env-sync                                                                                                                                | none                         |
| `WHOOP_CLIENT_SECRET`              | fly-env-sync                                                                                                                                | none                         |
| `WHOOP_WEBHOOK_SALT`               | fly-env-sync                                                                                                                                | none                         |
| `WITHINGS_CLIENT_ID`               | fly-env-sync                                                                                                                                | none                         |
| `WITHINGS_CLIENT_SECRET`           | fly-env-sync                                                                                                                                | none                         |

What stays as it is: Fly Deploy (`fly-deploy.yml`) on `production`,
automatic once its evidence is green (§2.1, ALM-D7 op 2); Fly Secrets List
(`fly-secrets-list.yml`), which binds no environment and prints secret names
and digests only, although it holds the full `FLY_API_TOKEN`.

The guard. Each moved workflow starts with a job of its own,
`secrets-environment-guard`, bound to no environment, with `contents: read`
and `actions: read`. It runs `scripts/ci/secrets-environment-guard.sh`,
which reads the environment through the GitHub API and refuses (the run goes
red with the reason) unless:

1. `production-secrets` exists, with exactly that name;
2. it has at least one required reviewer;
3. admins cannot bypass its rules;
4. its deployment branches are "Selected branches and tags";
5. it has exactly one branch rule, a branch named `main`.

The real job needs the guard and runs only when it passed. The guard is a
separate job because GitHub creates an environment that a job names, with no
protection, the first time a job uses it, and a check inside that job would
run only after the job had entered the environment. With the guard first, a
dispatch made before the setup below stops before any job enters
`production-secrets` or reads a secret. If a setting is weakened later
(reviewer removed, admin bypass ticked, branch rule widened), every run
refuses again until it is put back.

The owner's setup, in GitHub (growth-project-backend > Settings):

1. Environments > New environment, named exactly `production-secrets`.
2. Tick "Required reviewers" and add himself. Leave "Prevent self-review"
   unticked: the operators dispatch under his account, so with it ticked
   nobody could approve their runs.
3. Untick "Allow administrators to bypass configured protection rules".
4. "Deployment branches and tags": "Selected branches and tags", then one
   rule, ref type Branch, name `main`.
5. Secrets: a secret these workflows read that is held only as a
   repository secret (Settings > Secrets and variables > Actions) needs
   nothing. One held as a `production` environment secret (Settings >
   Environments > `production`) must be added to `production-secrets` with
   the same value from its source; if a name is in both places, the
   `production` copy is the one these workflows used until now.

What the approval protects, and what it does not. Each run of the eight
waits for his approval, so nobody runs them without him. A secret kept at
repository level is still readable by a changed workflow on any branch that
names no environment; only secrets kept in `production-secrets` alone, with
its `main`-only rule, are locked to these jobs. Moving them is his later
call. Fly Env Sync's apply without `deploy_staged` only stages values; the
next Fly Deploy, which nobody approves (§2.1), puts them live, so "approved"
means "staged", not "live at approval".

Only the owner approves a `production-secrets` run, on the run page's review
button. No operator or agent approves one, from any machine, even where a
token in reach would allow it. A run left waiting may hold its workflow's
`fly-secrets-<app>` concurrency group, so the next secrets run queues behind
it: approve or reject each run when it comes. During an incident a rotation
waits for his approval too.

To undo ("secrets env off"): revert the PR that made this change; the eight
then run in `production` again, which has no reviewer.

## 3. Deploy job

- `needs: evidence-gate`, `result == 'success'`, output sha == `github.sha`.
- Records `flyctl machines list --json` **before** deploying; only the
  filtered view (`scripts/ci/filter-machines.sh`: id, state, image_ref,
  process group, check status) is uploaded — no machine `config`.
- `scripts/ci/migration-delta.sh`: diff of `prisma/migrations` and
  `prisma/schema.prisma` between the running machines' `GH_SHA` label and
  `release_sha`. Non-empty or unknown delta → refused unless the
  `migrations` input equals `apply-migrations`; empty delta with a stray
  acknowledgement is also refused. Reason: `fly.toml`
  `release_command = "bash ./scripts/release.sh"` applies migrations
  **before** rollout, so a deploy is also a schema change. Schema and
  migration content remain S1-owned; this only forces the operator to say
  so.
- `flyctl deploy --remote-only --image-label sha-<release_sha>
--build-arg GIT_SHA=... --wait-timeout 5m`, then
  `scripts/ci/verify-fly-release.sh` requires every started machine in the
  `app` process group to run image tag `sha-<release_sha>` with label
  `GH_SHA=<release_sha>` and one converged digest. It does **not** read
  `checks[].status`; service health after rollout is only the separate
  `curl https://<app>.fly.dev/readyz` step (`.ok == true and .db == "up"`).
- The manifest is finalized with `deploy_result = <job.status>` and
  uploaded as `release-manifest-<sha>-<job.status>` even on failure.

## 4. Provenance claims — precise wording

- **Claimed:** the deployed image's Fly tag and OCI label name the
  authorized commit; the gate proved CI/CodeQL/SBOM ran on that commit.
- **Not claimed:** that the image bytes were built from that tree.
  `flyctl deploy --remote-only` builds on a Fly builder; there is no
  attestation (no SLSA/`actions/attest`, no digest pinned back to a
  reproducible build). Source ↔ image equivalence is **unattested**.
- **Not measured:** no Docker image has been built in this change set
  (no container runtime available). An isolated host replay of the
  runtime stage (`npm ci --omit=dev` with lifecycle, `nest build`, the
  Dockerfile's artifact assertion) passed on 2026-09-20 — that is a control
  proof of the install/build steps, **not** runtime evidence of the image.
- Currently running production image (read 2026-09-20) carries
  `GH_SHA=5076a07a…`, deployed 2026-09-18 **before** this gate existed;
  it was not produced by this path.

## 5. SBOM scope

`sbom.yml` produces a CycloneDX SBOM of the **npm production dependency
closure** (`npm ci --omit=dev --ignore-scripts` on a manifest copy with
`devDependencies` removed, then `npm sbom`). It does **not** describe the
base image OS packages, Node runtime, or Prisma engine binaries. The
`.sha256` sidecar binds the file to the artifact, not to the image.

What `scripts/ci/assert-prod-sbom.sh` proves is narrower than "closure":
it is a **denylist + sentinel check** — no `name@version` that the lockfile
marks dev-only appears, an explicit list of build/test tools is absent, and
the `prisma` CLI (release_command dependency) plus a non-zero component
count are present. It does not prove the SBOM equals the exact installed
tree or that every production package is listed.

## 6. Hosted settings — required, currently UNKNOWN / not enforced

Read 2026-09-20 (evidence in the private evidence repo): the only
environment was named `noble-celebration / production` (no environment
named `production` existed) with **no** protection rules and
`can_admins_bypass=true`; `main` had no branch protection (404) and no
rulesets. The workflows here bind to `environment: production` (since
2026-11-27 only Fly Deploy does; the eight of §2.2 bind to
`production-secrets`); GitHub creates that environment, unprotected, on first dispatch — so the gate
**fails closed today** (step 5 above) until an authorized operator
configures:

1. environment `production`: admins bypass off (the gate refuses without
   it); required reviewers (≥1 real human account; never a second account
   of the same person — G05) are optional since 2026-11-26, when the owner
   removed them (§2.1); deployment branch policy `main` only; keep
   `FLY_API_TOKEN` a repository secret, because Fly Deploy, the eight
   workflows of §2.2 and Fly Secrets List (which binds no
   environment) all read the same token (as §8 of `docs/deploy-runbook.md`
   says); the `fly-*-set` workflows, Fly Env Sync, Fly Env Truth and House Seed now
   run in `production-secrets` (§2.2);
2. branch protection / ruleset for `main` as in §1, run via
   `scripts/setup-branch-protection.sh` with an **explicit**
   `REQUIRED_APPROVING_REVIEW_COUNT` (0 = recorded single-maintainer
   decision; 1 requires a second maintainer) and `CHECKS_APP_ID=15368`
   (GitHub Actions) so required check names are bound to the Actions app;
3. environment `production-secrets` (§2.2): at least one required reviewer
   (the owner), admins bypass off, deployment branches `main` only (one
   branch rule, `main`), and a copy of any secret its workflows read that is
   held as a `production` environment secret. The guard refuses every run of
   those workflows until all of that reads back.

Until those are read back, the state of hosted settings is **UNKNOWN**
and nothing here should be described as enforced.

## 7. Recovery — by failure stage

A `Fly Deploy` run has three distinct failure stages with different
database consequences. Recovery text that does not name the stage is wrong.

| Stage                                                                                                                                                                | What has changed                                                                                                                                                                 | Recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Before `release_command` step 2** — gate refused, image build failed, `release.sh` step 0 (verifier contract) or step 1 refused                                 | Nothing: no image rolled out, no migration applied.                                                                                                                              | Fix forward on `main`; re-dispatch. No production action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **B. `release_command` failed at/after step 2** — `prisma migrate deploy` ran (fully or partially), then a later step (status, catalog verifier, accounting) refused | Machines still run the previous image (Fly does not roll out on a non-zero release_command). The **database may be ahead of the running code**: applied migrations stay applied. | Do **not** delete or edit an applied migration directory (a later `migrate deploy` would then refuse with a history mismatch — that fails closed, it does not roll back). Read `_prisma_migrations`, decide forward-fix vs. manual transactional reverse (S1-owned content, separate production authorization), then re-dispatch. See `docs/deploy-runbook.md` §11.4.                                                                                                                                                                                                     |
| **C. After rollout** — `verify-fly-release.sh` or `/readyz` failed, or a defect is found later                                                                       | New image is serving; schema is at `release_sha`.                                                                                                                                | Code rollback is a forward deploy of a revert commit through the gated path (revert code only — never revert a migration by deleting its directory). The previous image is recorded in `machines-before.json` of the last manifest (`image_ref.tag`; for the first gated release that tag is a Fly `deployment-*` tag, not `sha-*`, because the current production image was not built by this workflow). The direct `fly deploy --image registry.fly.io/<app>:<previous-tag>` route (`deploy-runbook.md` §3) is **ungated** and must be recorded as an emergency action. |

Reading a `release.sh` failure: the banner says `FAIL at line N`; lines in
step 0/1 are stage A, anything from step 2 onward is stage B. A process
killed outright (SIGKILL/OOM, machine destroyed) prints no banner — Fly's
release status is the only signal in that case.

Production logs are read in the Fly dashboard, not through a workflow,
because this repository's Actions logs are public. The former
`fly-logs-dump.yml` was removed: it started a machine (`flyctl machine
start`) from a workflow described as diagnostic, outside any environment
gate, and interpolated its `app` input directly into shell.

### 7.1 Catalog verifiers and the required-verifier contract (S1 content, S2 wiring)

`scripts/release.sh`:

- **step 0** (before any database connection) enumerates
  `prisma/migrations/*/verify.sql` with a checked pipeline (a failing
  `find` refuses the release rather than reading as "no verifiers") and
  checks `scripts/release-required-verifiers.txt`: the file must exist and
  list ≥1 bare migration directory name (no path separators, no `..`, no
  duplicates, no CRLF), and every entry must resolve to a discovered
  `verify.sql`. Anything else exits non-zero **before `migrate deploy`**.
  The path is pinned — no environment variable can substitute a different
  contract file.
- **step 4** (after `migrate deploy`) runs every discovered verifier via
  `prisma db execute --url "$DIRECT_URL" --file <verifier>` and asserts
  `ran == discovered ≥ required ≥ 1`. A RAISE in any verifier fails the
  release_command (stage B above).
- **step 5** (after step 4; FOOD-SEED-BE) runs the compiled
  `dist/food-seed/scripts/seed-built-in-foods.js` on `DIRECT_URL`: it adds,
  in one transaction under an advisory lock, each food in
  `prisma/data/seed-foods.json` that the shared catalog (`FoodItem` rows
  with `created_by_user_id` NULL) lacks, keyed on name + brand with letter
  case and whitespace runs folded the same way in its SQL and its key, and never
  updates or deletes a row or reads a member's own food. Normal line:
  `[release] built-in foods: 65 present, 0 added`. Any seed food still
  missing afterwards, a refused insert (the transaction writes nothing) or
  a missing/empty seed file fails the release_command (stage B above) with a
  `[release] built-in foods FAILED: …` line naming the reason.
- **step 6** (after step 5; FOOD-USDA-BE) runs the compiled
  `dist/food-seed/scripts/load-usda-foods.js` on `DIRECT_URL`: it adds, in
  one transaction under its own advisory lock, each USDA SR Legacy and
  Foundation food in `prisma/data/usda-foods.jsonl.gz` (built from USDA's CSV
  files by `scripts/usda-foods/build.py`) that the shared catalog lacks,
  keyed on its `usda:<fdcId>` tag, as the row the live USDA import stores,
  and never updates or deletes a row or reads a member's own food. Normal
  line: `[release] USDA foods: 7980 present, 0 added (… ms)`. Any food still
  missing afterwards, a refused insert or a missing/bad data file fails the
  release_command with a `[release] USDA foods FAILED: …` line.

Ownership: the contract _file_ and runner are S2's; the verifier _content_
(role/grant/RLS postconditions) is S1's. When a migration ships a
`verify.sql`, its directory name is added to the contract in the same
change. The contract currently names
`20261224000000_rls_close_public_exposure`; a candidate containing this
contract but not that S1 migration cannot release (fails at step 0, no
database contact) — the intended composition order.

Prisma's "up to date" is not truth after an out-of-band reversal, and on
the pinned 6.19.3 it is also satisfied by a row marked `rolled_back_at`
after `prisma migrate resolve --rolled-back` while `migrate deploy` still
re-applies that migration (real composition run, S1S2-B-07): after any
resolve, re-run the release; only the verifier is truth. A green release
log contains `verifiers_passed = 1 (discovered=1, required=1)` but **not**
the verifier's own `VERIFY OK …` NOTICE — `prisma db execute` surfaces
failures (the RAISE text) but discards notices (S1S2-B-06); do not search
production logs for the "relations protected" line. Do **not** use `prisma migrate resolve --rolled-back` after a
_successful_ migration was reversed out-of-band (it refuses with P3012, or
silently no-ops if an earlier failed row exists). Recovery is a
transactional manual forward (`psql --single-transaction -v
ON_ERROR_STOP=1 -f migration.sql`) followed by `verify.sql`, under separate
production authorization.

Step 0 proves only that the required verifier files are present in **this
image** before **this** release_command mutates anything. It makes no
claim about production state, other machines, or earlier deploys.

## 8. Known limits (not fixed here)

- `flyctl` binary version is whatever `setup-flyctl` (pinned by commit)
  installs; the CLI itself is not pinned.
- The job token can read an environment's protection rules on this plan:
  the Fly Deploy gate read `production` in runs 45887904641, 45888670085
  and 45897205238 (2026-11-26). Whether it can read an environment's branch
  rules (`deployment-branch-policies`, check 5 of the §2.2 guard) is not yet
  measured. If either read returns 403, the gate or the guard fails closed.
- Field shapes for `flyctl machines list --json` (`image_ref.labels`,
  `config.metadata.fly_process_group`, `checks[].status`) were taken from
  a live read on 2026-09-20 and from Fly documentation; a schema change
  would fail the verifier, not pass it.
- These workflows have **not yet executed on GitHub** as changed; the
  first real dispatch is the first runtime evidence.
- Operator workflows (`fly-*.yml` other than `fly-deploy.yml`) take
  dispatch inputs only through step `env:` and use them quoted; the `app`
  input is checked against an explicit allowlist
  (`backend-spring-lake-3890`) before any credentialed command. `actionlint`
  does **not** flag `${{ inputs.* }}` inside `run:` (it is not in its
  untrusted-context list), so `test/ci/delivery-artifact.spec.ts` carries
  that structural check.
- `dependency-audit.yml` (S3 lane) is already listed in `REQUIRED_WORKFLOWS`
  and `REQUIRED_CHECKS`; until it lands on `main` with job name
  `npm audit (high+critical, whole graph)` the release gate fails closed on
  every release. That is the intended order: compose first, then release.
