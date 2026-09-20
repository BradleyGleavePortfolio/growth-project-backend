#!/usr/bin/env bash
# scripts/ci/release-evidence-gate.sh
#
# Fail-closed release evidence gate (G07/G09/G16/G17). Run by
# .github/workflows/fly-deploy.yml before any `flyctl deploy`.
#
# Given one exact 40-hex commit (RELEASE_SHA), it exits 0 only when ALL of the
# following are true for THAT commit, as reported by the GitHub API; any other
# state - missing, skipped, in progress, cancelled, failed, expired, from a
# fork, from a pull_request event, on another branch, older-success-but-newer-
# failure, unreadable API - exits non-zero. There is no tolerated fallback.
#
#   1. RELEASE_SHA is a full 40-hex SHA and equals DISPATCH_SHA (the commit the
#      dispatching workflow definition came from). Deploying anything other
#      than the exact head the gate itself was read from is refused, so a push
#      that lands between operator authorization and dispatch fails closed.
#   2. For every required workflow (REQUIRED_WORKFLOWS, "path=job1,job2;..."):
#      the NEWEST run whose head_sha == RELEASE_SHA, whose repository and
#      head_repository are this repository (not a fork), whose event is
#      push / workflow_dispatch / schedule (never pull_request), and whose
#      head_branch is TRUSTED_BRANCH, is completed with conclusion success, and
#      every listed job in that run is completed with conclusion success.
#      A newer failed/in-progress run beats an older success (newest wins).
#   3. A CodeQL code-scanning analysis exists whose commit_sha == RELEASE_SHA
#      (proves the SARIF upload happened, not merely that the job was green).
#   4. The SBOM run for RELEASE_SHA produced a non-expired artifact named
#      "sbom-cyclonedx-<RELEASE_SHA>"; it is downloaded, must parse as
#      CycloneDX with >0 components, and its sha256 is recorded.
#   5. The deployment environment (REQUIRED_ENVIRONMENT, default "production")
#      exists with a required_reviewers protection rule and no admin bypass,
#      so the human authorization step cannot be skipped by dispatching before
#      the hosted settings are in place (environments auto-create unprotected).
#
# Output: $OUT_DIR/release-evidence-<sha>.json (the evidence manifest the deploy
# step attaches to the release) and the downloaded SBOM.
#
# Only `gh api` is used to talk to GitHub, so the whole script is testable with
# a fake `gh` on PATH (see test/ci/release-evidence-gate.spec.ts).

set -Eeuo pipefail

fail() { echo "::error::release-evidence-gate: $*" >&2; exit 1; }

: "${GH_REPO:?GH_REPO (owner/repo) is required}"
: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${DISPATCH_SHA:?DISPATCH_SHA is required}"
TRUSTED_BRANCH="${TRUSTED_BRANCH:-main}"
OUT_DIR="${OUT_DIR:-release-evidence}"
SBOM_WORKFLOW_PATH="${SBOM_WORKFLOW_PATH:-.github/workflows/sbom.yml}"
REQUIRED_ENVIRONMENT="${REQUIRED_ENVIRONMENT:-production}"
# Default required set. Job names must match the `name:`/id emitted by each
# workflow. Format: "<workflow path>=<job>,<job>;<workflow path>=<job>".
REQUIRED_WORKFLOWS="${REQUIRED_WORKFLOWS:-.github/workflows/ci.yml=build-and-test,rls-floor-guard,rls-live-tests,mwb-3-live-tests;.github/workflows/codeql.yml=CodeQL JS/TS (javascript-typescript);.github/workflows/sbom.yml=build-sbom}"

command -v gh >/dev/null 2>&1 || fail "gh CLI not available"
command -v jq >/dev/null 2>&1 || fail "jq not available"
command -v unzip >/dev/null 2>&1 || fail "unzip not available"

# --- 1. exact head binding ---------------------------------------------------
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_SHA must be a full lowercase 40-hex commit SHA (got '${RELEASE_SHA}')"
[[ "$RELEASE_SHA" == "$DISPATCH_SHA" ]] || fail "RELEASE_SHA ${RELEASE_SHA} != dispatched head ${DISPATCH_SHA}; refusing to deploy a commit other than the exact head this gate was read from"
[[ "$GH_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GH_REPO must be owner/repo"

mkdir -p "$OUT_DIR"

# gh api wrapper: any non-zero exit or non-JSON body is a hard failure.
api() {
  local path=$1 body
  if ! body=$(gh api "$path" 2>"$OUT_DIR/.api-err"); then
    fail "GitHub API read failed for ${path}: $(tr '\n' ' ' <"$OUT_DIR/.api-err" | cut -c1-300)"
  fi
  printf '%s' "$body" | jq -e . >/dev/null 2>&1 || fail "GitHub API returned non-JSON for ${path}"
  printf '%s' "$body"
}

# --- 2. required workflow runs for this exact sha ----------------------------
RUNS_JSON=$(api "repos/${GH_REPO}/actions/runs?head_sha=${RELEASE_SHA}&per_page=100")
TOTAL_RUNS=$(printf '%s' "$RUNS_JSON" | jq '.workflow_runs | length')
echo "release-evidence-gate: ${TOTAL_RUNS} workflow run(s) reported for ${RELEASE_SHA}"

MANIFEST_RUNS='[]'
SBOM_RUN_ID=''

IFS=';' read -r -a REQ_ENTRIES <<<"$REQUIRED_WORKFLOWS"
[[ ${#REQ_ENTRIES[@]} -gt 0 ]] || fail "REQUIRED_WORKFLOWS is empty"
for entry in "${REQ_ENTRIES[@]}"; do
  [[ -n "$entry" ]] || continue
  wf_path=${entry%%=*}
  jobs_csv=${entry#*=}
  [[ -n "$wf_path" && -n "$jobs_csv" && "$wf_path" != "$entry" ]] || fail "malformed REQUIRED_WORKFLOWS entry '${entry}'"

  # Trusted-provenance filter, then newest run wins.
  newest=$(printf '%s' "$RUNS_JSON" | jq -c \
    --arg path "$wf_path" --arg sha "$RELEASE_SHA" --arg repo "$GH_REPO" --arg branch "$TRUSTED_BRANCH" '
    [ .workflow_runs[]
      | select(.path == $path)
      | select(.head_sha == $sha)
      | select(.repository.full_name == $repo)
      | select(.head_repository.full_name == $repo)
      | select(.event == "push" or .event == "workflow_dispatch" or .event == "schedule")
      | select(.head_branch == $branch)
    ] | sort_by(.run_number) | reverse | .[0] // empty')
  [[ -n "$newest" ]] || fail "no trusted run of ${wf_path} for ${RELEASE_SHA} (same-repo, ${TRUSTED_BRANCH}, non-PR event). Missing evidence is not success."

  run_id=$(printf '%s' "$newest" | jq -r '.id')
  run_status=$(printf '%s' "$newest" | jq -r '.status')
  run_conclusion=$(printf '%s' "$newest" | jq -r '.conclusion // "null"')
  run_number=$(printf '%s' "$newest" | jq -r '.run_number')
  [[ "$run_status" == "completed" ]] || fail "newest ${wf_path} run #${run_number} (id ${run_id}) is '${run_status}', not completed"
  [[ "$run_conclusion" == "success" ]] || fail "newest ${wf_path} run #${run_number} (id ${run_id}) concluded '${run_conclusion}', not success (an older success does not override the newest result)"

  JOBS_JSON=$(api "repos/${GH_REPO}/actions/runs/${run_id}/jobs?per_page=100")
  IFS=',' read -r -a want_jobs <<<"$jobs_csv"
  for job in "${want_jobs[@]}"; do
    # Every entry with this name must be completed/success (duplicate names, e.g.
    # re-run attempts listed together, are not resolved by taking the first one).
    job_state=$(printf '%s' "$JOBS_JSON" | jq -r --arg n "$job" '
      [ .jobs[] | select(.name == $n) ]
      | if length == 0 then "missing"
        elif all(.[]; .status == "completed" and .conclusion == "success") then "completed/success"
        else (map("\(.status)/\(.conclusion // "null")") | join("|")) end')
    [[ "$job_state" == "completed/success" ]] || fail "job '${job}' in ${wf_path} run ${run_id} is '${job_state}', required completed/success for every entry (skipped/neutral/missing/duplicate-failed are not success)"
  done

  echo "release-evidence-gate: OK ${wf_path} run #${run_number} (id ${run_id}) jobs: ${jobs_csv}"
  MANIFEST_RUNS=$(printf '%s' "$MANIFEST_RUNS" | jq -c --argjson r "$newest" --arg jobs "$jobs_csv" \
    '. + [{path: $r.path, id: $r.id, run_number: $r.run_number, event: $r.event, conclusion: $r.conclusion, html_url: $r.html_url, required_jobs: ($jobs | split(","))}]')
  [[ "$wf_path" == "$SBOM_WORKFLOW_PATH" ]] && SBOM_RUN_ID=$run_id
done

# --- 3. CodeQL analysis actually uploaded for this sha -----------------------
ANALYSES_JSON=$(api "repos/${GH_REPO}/code-scanning/analyses?ref=refs/heads/${TRUSTED_BRANCH}&per_page=100")
analysis=$(printf '%s' "$ANALYSES_JSON" | jq -c --arg sha "$RELEASE_SHA" '
  [ .[] | select(.commit_sha == $sha) | select(.tool.name == "CodeQL") ] | sort_by(.created_at) | reverse | .[0] // empty')
[[ -n "$analysis" ]] || fail "no CodeQL code-scanning analysis recorded for ${RELEASE_SHA}; a green job without an uploaded analysis is not evidence"
analysis_id=$(printf '%s' "$analysis" | jq -r '.id')
# An upload that analysed nothing (extraction error, zero rules evaluated) is
# not a scan. results_count may legitimately be 0; rules_count may not.
analysis_problem=$(printf '%s' "$analysis" | jq -r '
  if ((.error // "") != "") then "error=\(.error)"
  elif ((.rules_count // 0) <= 0) then "rules_count=\(.rules_count // "null")"
  else "" end')
[[ -z "$analysis_problem" ]] || fail "CodeQL analysis ${analysis_id} for ${RELEASE_SHA} analysed nothing (${analysis_problem}); empty or errored scans are not success"
echo "release-evidence-gate: OK CodeQL analysis ${analysis_id} for ${RELEASE_SHA} (rules_count $(printf '%s' "$analysis" | jq -r '.rules_count'), results_count $(printf '%s' "$analysis" | jq -r '.results_count // "null"'))"

# --- 4. SBOM artifact bound to this sha -------------------------------------
[[ -n "$SBOM_RUN_ID" ]] || fail "SBOM workflow ${SBOM_WORKFLOW_PATH} is not in REQUIRED_WORKFLOWS; artifact proof impossible"
ARTIFACTS_JSON=$(api "repos/${GH_REPO}/actions/runs/${SBOM_RUN_ID}/artifacts?per_page=100")
sbom_name="sbom-cyclonedx-${RELEASE_SHA}"
artifact=$(printf '%s' "$ARTIFACTS_JSON" | jq -c --arg n "$sbom_name" '
  [ .artifacts[] | select(.name == $n) | select(.expired == false) ] | .[0] // empty')
[[ -n "$artifact" ]] || fail "SBOM artifact '${sbom_name}' missing or expired on run ${SBOM_RUN_ID}"
artifact_id=$(printf '%s' "$artifact" | jq -r '.id')

SBOM_ZIP="$OUT_DIR/${sbom_name}.zip"
if ! gh api "repos/${GH_REPO}/actions/artifacts/${artifact_id}/zip" >"$SBOM_ZIP" 2>"$OUT_DIR/.api-err"; then
  fail "could not download SBOM artifact ${artifact_id}: $(tr '\n' ' ' <"$OUT_DIR/.api-err" | cut -c1-300)"
fi
rm -f "$OUT_DIR/sbom.cdx.json" "$OUT_DIR/sbom.cdx.json.sha256"
unzip -o -q "$SBOM_ZIP" sbom.cdx.json sbom.cdx.json.sha256 -d "$OUT_DIR" || fail "SBOM artifact zip does not contain sbom.cdx.json and sbom.cdx.json.sha256"
SBOM_FILE="$OUT_DIR/sbom.cdx.json"
sbom_sha256=$(sha256sum "$SBOM_FILE" | awk '{print $1}')
sidecar_sha256=$(awk '{print $1}' "$OUT_DIR/sbom.cdx.json.sha256" | head -1)
[[ "$sidecar_sha256" == "$sbom_sha256" ]] || fail "SBOM sha256 sidecar (${sidecar_sha256:-empty}) does not match downloaded sbom.cdx.json (${sbom_sha256})"
# Re-run the full production-closure proof against the lockfile of the release
# commit (the gate job checks out RELEASE_SHA), not just the CycloneDX shape.
SBOM_ASSERT="${SBOM_ASSERT:-scripts/ci/assert-prod-sbom.sh}"
LOCKFILE="${LOCKFILE:-package-lock.json}"
[[ -f "$SBOM_ASSERT" ]] || fail "SBOM assertion script ${SBOM_ASSERT} not found in the checked-out release commit"
[[ -f "$LOCKFILE" ]] || fail "lockfile ${LOCKFILE} not found in the checked-out release commit"
GITHUB_OUTPUT=/dev/null bash "$SBOM_ASSERT" "$SBOM_FILE" "$LOCKFILE" || fail "downloaded SBOM failed the production-closure proof against ${LOCKFILE}"
sbom_components=$(jq '.components | length' "$SBOM_FILE")
echo "release-evidence-gate: OK SBOM artifact ${artifact_id} (${sbom_components} components, sha256 ${sbom_sha256}, sidecar match, closure proof re-run)"

# --- 5. deployment environment is actually protected -------------------------
ENV_JSON=$(api "repos/${GH_REPO}/environments/${REQUIRED_ENVIRONMENT}")
env_ok=$(printf '%s' "$ENV_JSON" | jq -r '
  ( [ .protection_rules[]? | select(.type == "required_reviewers") | (.reviewers // []) | length ] | add // 0 ) as $reviewers
  | if ($reviewers > 0) and (.can_admins_bypass == false) then "ok"
    else "reviewers=\($reviewers) can_admins_bypass=\(.can_admins_bypass)" end')
[[ "$env_ok" == "ok" ]] || fail "environment '${REQUIRED_ENVIRONMENT}' is not protected (${env_ok}); a deploy without a required human reviewer and with admin bypass is refused"
echo "release-evidence-gate: OK environment ${REQUIRED_ENVIRONMENT} has required reviewers and no admin bypass"

# --- manifest ----------------------------------------------------------------
MANIFEST="$OUT_DIR/release-evidence-${RELEASE_SHA}.json"
jq -n \
  --arg repo "$GH_REPO" --arg sha "$RELEASE_SHA" --arg branch "$TRUSTED_BRANCH" \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson runs "$MANIFEST_RUNS" --argjson analysis "$analysis" \
  --argjson artifact_id "$artifact_id" --arg sbom_sha256 "$sbom_sha256" --argjson sbom_components "$sbom_components" \
  --arg environment "$REQUIRED_ENVIRONMENT" \
  '{
    schema: "tgp.release-evidence.v1",
    repository: $repo, release_sha: $sha, trusted_branch: $branch, generated_at: $generated_at,
    environment: $environment,
    required_runs: $runs,
    codeql_analysis: {id: $analysis.id, commit_sha: $analysis.commit_sha, created_at: $analysis.created_at, url: $analysis.url,
                      rules_count: $analysis.rules_count, results_count: $analysis.results_count},
    sbom: {artifact_id: $artifact_id, name: ("sbom-cyclonedx-" + $sha), sha256: $sbom_sha256, components: $sbom_components,
           scope: "npm production closure of the release commit (no OS packages, Node binary, Prisma engine binaries or build-stage tools)"},
    image: null
  }' >"$MANIFEST"
echo "release-evidence-gate: PASS for ${RELEASE_SHA}; manifest ${MANIFEST}"
