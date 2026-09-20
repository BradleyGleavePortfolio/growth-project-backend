# Delivery controls — what is enforced, what is claimed, what is not

Repository-local description of the fail-closed delivery path introduced
2026-09-20. This file is the canonical reference; anything that contradicts
it in `docs/deploy-runbook.md` is stale and should be fixed there.

## 1. Two separate authorizations

| Authorization | Mechanism | Who/what decides |
| --- | --- | --- |
| **Merge to `main`** | Branch protection / ruleset: required checks `build-and-test`, `rls-floor-guard`, `rls-live-tests`, `mwb-3-live-tests`, `danger`, `Banned cast tokens (R75 / R100.A2)`, `CodeQL JS/TS (javascript-typescript)`, `test-deploy-readiness`, `build-sbom`, `npm audit (high+critical, whole graph)`; strict up-to-date; linear history; conversation resolution. | `scripts/setup-branch-protection.sh` (NOT yet run — see §6). |
| **Deploy to Fly** | `Fly Deploy` (`.github/workflows/fly-deploy.yml`): `workflow_dispatch` only, `release_sha` + `confirm=deploy` inputs, job `Release evidence gate` (`scripts/ci/release-evidence-gate.sh`) then job `deploy` bound to environment `production`. | A human dispatch **and** the environment's required reviewers (once configured). |

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
   has a run **on that head sha** whose *newest* attempt is
   `completed/success`; a newer failed run beats an older success; a
   missing, skipped, cancelled, in-progress or duplicate-name-with-one-failure
   job fails the gate;
3. a CodeQL analysis exists for that sha with an empty `error` and
   `rules_count > 0` (an "uploaded nothing" analysis is refused);
4. the `sbom.yml` artifact for that sha contains `sbom.cdx.json` and a
   matching `sbom.cdx.json.sha256`, and `scripts/ci/assert-prod-sbom.sh`
   re-proves it against the checked-out lockfile (no dev-only packages,
   production set present);
5. the `production` environment exists, has at least one protection
   rule of type `required_reviewers` with ≥1 reviewer, **and**
   `can_admins_bypass == false` (`REQUIRED_ENVIRONMENT`). Admin bypass is
   a hard requirement, not a recorded observation: the manifest does not
   carry the bypass flag; a bypass-enabled environment fails the gate.

Everything read is written to
`release-evidence/release-evidence-<release_sha>.json`
(`schema: tgp.release-evidence.v1`) and uploaded. The gate is a consumer of
checks; it does not run tests itself and cannot approve its own change.

Negatives are covered by `test/ci/release-evidence-gate.spec.ts`
(fixture GitHub API server) and `test/ci/delivery-artifact.spec.ts`.

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
rulesets. The workflows here bind to `environment: production`; GitHub
creates that environment, unprotected, on first dispatch — so the gate
**fails closed today** (step 5 above) until an authorized operator
configures:

1. environment `production`: required reviewers (≥1 real human account;
   never a second account of the same person — G05), deployment branch
   policy `main` only, admins bypass off; move `FLY_API_TOKEN` from the
   repository secret store into this environment (the other `fly-*-set`
   workflows are bound to the same environment for that reason);
2. branch protection / ruleset for `main` as in §1, run via
   `scripts/setup-branch-protection.sh` with an **explicit**
   `REQUIRED_APPROVING_REVIEW_COUNT` (0 = recorded single-maintainer
   decision; 1 requires a second maintainer) and `CHECKS_APP_ID=15368`
   (GitHub Actions) so required check names are bound to the Actions app.

Until those are read back, the state of hosted settings is **UNKNOWN**
and nothing here should be described as enforced.

## 7. Recovery — by failure stage

A `Fly Deploy` run has three distinct failure stages with different
database consequences. Recovery text that does not name the stage is wrong.

| Stage | What has changed | Recovery |
|---|---|---|
| **A. Before `release_command` step 2** — gate refused, image build failed, `release.sh` step 0 (verifier contract) or step 1 refused | Nothing: no image rolled out, no migration applied. | Fix forward on `main`; re-dispatch. No production action. |
| **B. `release_command` failed at/after step 2** — `prisma migrate deploy` ran (fully or partially), then a later step (status, catalog verifier, accounting) refused | Machines still run the previous image (Fly does not roll out on a non-zero release_command). The **database may be ahead of the running code**: applied migrations stay applied. | Do **not** delete or edit an applied migration directory (a later `migrate deploy` would then refuse with a history mismatch — that fails closed, it does not roll back). Read `_prisma_migrations`, decide forward-fix vs. manual transactional reverse (S1-owned content, separate production authorization), then re-dispatch. See `docs/deploy-runbook.md` §11.4. |
| **C. After rollout** — `verify-fly-release.sh` or `/readyz` failed, or a defect is found later | New image is serving; schema is at `release_sha`. | Code rollback is a forward deploy of a revert commit through the gated path (revert code only — never revert a migration by deleting its directory). The previous image is recorded in `machines-before.json` of the last manifest (`image_ref.tag`; for the first gated release that tag is a Fly `deployment-*` tag, not `sha-*`, because the current production image was not built by this workflow). The direct `fly deploy --image registry.fly.io/<app>:<previous-tag>` route (`deploy-runbook.md` §3) is **ungated** and must be recorded as an emergency action. |

Reading a `release.sh` failure: the banner says `FAIL at line N`; lines in
step 0/1 are stage A, anything from step 2 onward is stage B. A process
killed outright (SIGKILL/OOM, machine destroyed) prints no banner — Fly's
release status is the only signal in that case.

The read-only `Fly Logs (operator)` workflow (`fly-logs.yml`) is the
supported way to pull recent logs during recovery. The former
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

Ownership: the contract *file* and runner are S2's; the verifier *content*
(role/grant/RLS postconditions) is S1's. When a migration ships a
`verify.sql`, its directory name is added to the contract in the same
change. The contract currently names
`20261224000000_rls_close_public_exposure`; a candidate containing this
contract but not that S1 migration cannot release (fails at step 0, no
database contact) — the intended composition order.

Prisma's "up to date" is not truth after an out-of-band reversal; only the
verifier is. Do **not** use `prisma migrate resolve --rolled-back` after a
*successful* migration was reversed out-of-band (it refuses with P3012, or
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
- Whether `GITHUB_TOKEN` can read environment protection rules on this
  plan is unmeasured; if the API returns 403 the gate fails closed.
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
