#!/usr/bin/env bash
# scripts/ci/verify-fly-release.sh
#
# Post-deploy artifact binding (G16). Reads the Fly Machines JSON for the app
# (`flyctl machines list --json -a <app>`, or a file/stdin for tests) and exits
# 0 only when every started machine in the app process group runs ONE image
# whose reference tag is the label we asked flyctl to build
# (IMAGE_LABEL, "sha-<release sha>") and whose OCI labels carry
# GH_SHA == RELEASE_SHA. The resolved digest is appended to the evidence
# manifest so the release record names the exact image, not just a source SHA.
#
# What this proves: the machines now serving traffic run an image built from the
# authorized commit by this workflow run. What it does not prove: that the image
# content is bit-equivalent to an independent rebuild (no reproducible build
# here) or that the deployed service is healthy for customers (that is the
# separate /readyz probe and Fly health checks).
#
# Usage: MACHINES_JSON=<file> RELEASE_SHA=<sha> IMAGE_LABEL=sha-<sha> \
#        [MANIFEST=<release-evidence json>] [PROCESS_GROUP=app] verify-fly-release.sh

set -Eeuo pipefail
fail() { echo "::error::verify-fly-release: $*" >&2; exit 1; }

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${IMAGE_LABEL:?IMAGE_LABEL is required}"
MACHINES_JSON="${MACHINES_JSON:-/dev/stdin}"
PROCESS_GROUP="${PROCESS_GROUP:-app}"
MANIFEST="${MANIFEST:-}"

command -v jq >/dev/null 2>&1 || fail "jq not available"
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_SHA must be 40-hex"

DATA=$(cat "$MACHINES_JSON")
printf '%s' "$DATA" | jq -e 'type == "array"' >/dev/null 2>&1 || fail "machines JSON is not an array"

# Machines that matter: started members of the serving process group.
SERVING=$(printf '%s' "$DATA" | jq -c --arg pg "$PROCESS_GROUP" '
  [ .[] | select((.config.metadata.fly_process_group // "app") == $pg) | select(.state == "started") ]')
COUNT=$(printf '%s' "$SERVING" | jq 'length')
[[ "$COUNT" -gt 0 ]] || fail "no started machines in process group '${PROCESS_GROUP}'; cannot attest a release that is not running"

BAD=$(printf '%s' "$SERVING" | jq -r --arg tag "$IMAGE_LABEL" --arg sha "$RELEASE_SHA" '
  .[] | select(
      (.image_ref.tag // "") != $tag
      or ((.image_ref.labels.GH_SHA // "") != $sha)
      or ((.image_ref.digest // "") | test("^sha256:[0-9a-f]{64}$") | not)
  ) | "\(.id) tag=\(.image_ref.tag // "?") GH_SHA=\(.image_ref.labels.GH_SHA // "?") digest=\(.image_ref.digest // "?")"')
[[ -z "$BAD" ]] || fail "machine(s) not running the authorized image ${IMAGE_LABEL} / GH_SHA ${RELEASE_SHA}: ${BAD//$'\n'/; }"

DIGESTS=$(printf '%s' "$SERVING" | jq -r '[.[] | .image_ref.digest] | unique | .[]')
DIGEST_COUNT=$(printf '%s\n' "$DIGESTS" | sed '/^$/d' | wc -l | tr -d ' ')
[[ "$DIGEST_COUNT" -eq 1 ]] || fail "started machines run ${DIGEST_COUNT} distinct image digests; release is not converged"
DIGEST=$(printf '%s\n' "$DIGESTS" | head -n1)
IMAGE_REF=$(printf '%s' "$SERVING" | jq -r '.[0].image_ref | "\(.registry)/\(.repository):\(.tag)"')
echo "verify-fly-release: OK ${COUNT} machine(s) on ${IMAGE_REF}@${DIGEST} (GH_SHA ${RELEASE_SHA})"

if [[ -n "$MANIFEST" ]]; then
  [[ -f "$MANIFEST" ]] || fail "manifest ${MANIFEST} not found"
  tmp=$(mktemp)
  jq --arg ref "$IMAGE_REF" --arg digest "$DIGEST" --arg tag "$IMAGE_LABEL" --argjson machines "$(printf '%s' "$SERVING" | jq -c '[.[] | {id, region, state}]')" \
    '.image = {ref: $ref, digest: $digest, tag: $tag, machines: $machines}' "$MANIFEST" >"$tmp" && mv "$tmp" "$MANIFEST"
  echo "verify-fly-release: manifest ${MANIFEST} updated with image digest"
fi
