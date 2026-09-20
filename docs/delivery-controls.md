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
5. the `production` environment exists and has at least one protection
   rule of type `required_reviewers` (`REQUIRED_ENVIRONMENT`); admins
   bypass is reported in the manifest.

Everything read is written to `release-evidence/manifest.json`
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
  `GH_SHA=<release_sha>` and passing checks.
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

## 6. Hosted settings — required, currently UNKNOWN / not enforced

Read 2026-09-20 (evidence in the private evidence repo): `production`
environment existed with **no** protection rules and
`can_admins_bypass=true`; `main` had no branch protection (404) and no
rulesets. The gate therefore **fails closed today** (step 5 above) until
an authorized operator configures:

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

## 7. Recovery

Forward-only through the gated path: revert on `main` via PR → checks →
dispatch `Fly Deploy` with the new head. The previous running image is
recorded in `machines-before.json` of the last release manifest. The direct
`fly deploy --image registry.fly.io/<app>:sha-<previous>` route in
`docs/deploy-runbook.md` §3 is **ungated** and must be recorded as an
emergency action.

### 7.1 Database state after a rollback (S1 requirement, wired here)

`scripts/release.sh` step 4 runs every `prisma/migrations/*/verify.sql`
(catalog verifiers) after `prisma migrate deploy`; a failing verifier fails
the release_command and Fly keeps the old machines. Prisma's "up to date"
is not truth after an out-of-band reversal; only the verifier is. Do **not**
use `prisma migrate resolve --rolled-back` after a *successful* migration
was reversed out-of-band (it refuses with P3012, or silently no-ops if an
earlier failed row exists). Recovery is a transactional manual forward
(`psql --single-transaction -v ON_ERROR_STOP=1 -f migration.sql`) followed
by `verify.sql`, under separate production authorization. Migration and
verifier contents are S1-owned; this repo only wires their execution order.
This candidate does **not** include the S1 migration itself (base
c23b9d9f); on the integrated head the loop picks up whatever verifiers
exist.

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
- `dependency-audit.yml` (S3 lane) is already listed in `REQUIRED_WORKFLOWS`
  and `REQUIRED_CHECKS`; until it lands on `main` with job name
  `npm audit (high+critical, whole graph)` the release gate fails closed on
  every release. That is the intended order: compose first, then release.
