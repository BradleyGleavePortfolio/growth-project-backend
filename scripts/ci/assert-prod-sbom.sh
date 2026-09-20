#!/usr/bin/env bash
# scripts/ci/assert-prod-sbom.sh
#
# Production-dependency proof for a CycloneDX SBOM (used by
# .github/workflows/sbom.yml, re-run by scripts/ci/release-evidence-gate.sh, tested in test/ci/delivery-artifact.spec.ts).
#
# Exits 0 only when SBOM_FILE:
#   1. is a CycloneDX document with more than zero components;
#   2. contains NO component that package-lock.json marks `dev: true`
#      (dev-only packages must never describe the production artifact);
#   3. contains none of the explicit build/test tooling names in DENY_LIST
#      (belt and braces against a mis-flagged lockfile);
#   4. contains every runtime package in REQUIRE_LIST — including the `prisma`
#      CLI, which fly.toml's release_command (scripts/release.sh) executes in
#      the production image.
# Prints a summary and the sha256 of the SBOM so the artifact can be bound to
# the commit in the release evidence manifest.

set -Eeuo pipefail
fail() { echo "::error::assert-prod-sbom: $*" >&2; exit 1; }

SBOM_FILE="${1:-${SBOM_FILE:-sbom.cdx.json}}"
LOCKFILE="${2:-${LOCKFILE:-package-lock.json}}"
DENY_LIST="${DENY_LIST:-jest ts-jest ts-node @nestjs/cli @nestjs/testing eslint typescript-eslint lefthook danger @cyclonedx/cdxgen supertest}"
REQUIRE_LIST="${REQUIRE_LIST:-@nestjs/core @prisma/client prisma}"

command -v jq >/dev/null 2>&1 || fail "jq not available"
[[ -f "$SBOM_FILE" ]] || fail "SBOM file not found: ${SBOM_FILE}"
[[ -f "$LOCKFILE" ]] || fail "lockfile not found: ${LOCKFILE}"

jq -e '.bomFormat == "CycloneDX"' "$SBOM_FILE" >/dev/null 2>&1 || fail "${SBOM_FILE} is not a CycloneDX document"
COUNT=$(jq '.components | length' "$SBOM_FILE")
[[ "$COUNT" -gt 0 ]] || fail "SBOM has zero components; an empty scan is not evidence"

# name@version of every component
COMPONENTS=$(jq -r '.components[] | "\(.name)@\(.version // "")"' "$SBOM_FILE" | sort -u)

# name@version that appears in the lockfile ONLY as `dev: true` entries
# (lockfile v2/v3 `packages` map). A nested dev copy of a name@version that
# also exists as a production entry is not dev-only.
lock_nv() { # $1 = jq filter on .value
  jq -r --arg f "$1" '
    .packages | to_entries[] | select(.key != "")
    | select(if $f == "dev" then (.value.dev == true) else (.value.dev != true) end)
    | (.key | sub("^.*node_modules/"; "")) + "@" + (.value.version // "")' "$LOCKFILE" | sort -u
}
DEV_ONLY=$(comm -23 <(lock_nv dev) <(lock_nv prod) || true)

LEAK=$(comm -12 <(printf '%s\n' "$COMPONENTS") <(printf '%s\n' "$DEV_ONLY") || true)
[[ -z "$LEAK" ]] || fail "dev-only packages present in production SBOM: $(printf '%s' "$LEAK" | tr '\n' ' ')"

NAMES=$(jq -r '.components[].name' "$SBOM_FILE" | sort -u)
for d in $DENY_LIST; do
  if printf '%s\n' "$NAMES" | grep -qxF "$d"; then fail "build/test tool '${d}' present in production SBOM"; fi
done
for r in $REQUIRE_LIST; do
  printf '%s\n' "$NAMES" | grep -qxF "$r" || fail "required runtime package '${r}' missing from production SBOM"
done

SHA=$(sha256sum "$SBOM_FILE" | awk '{print $1}')
echo "assert-prod-sbom: OK ${COUNT} components, 0 dev-only leaks, required runtime packages present"
echo "assert-prod-sbom: sha256 ${SHA}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "components=${COUNT}"; echo "sha256=${SHA}"; } >> "$GITHUB_OUTPUT"
fi
