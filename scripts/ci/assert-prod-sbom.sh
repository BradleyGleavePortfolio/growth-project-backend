#!/usr/bin/env bash
# scripts/ci/assert-prod-sbom.sh
#
# Production-dependency denylist + sentinel check for a CycloneDX SBOM (used by
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
#
# Scope (S2-R2-A-04): this is NOT a closure proof. It shows the SBOM carries no
# lockfile-dev packages and no denylisted tools, and that the sentinel runtime
# packages are present. It does not prove the SBOM lists every production
# package or matches the installed tree bit-for-bit.

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
jq -e '.components | type == "array"' "$SBOM_FILE" >/dev/null 2>&1 \
  || fail "${SBOM_FILE} components is not a list; regenerate the SBOM with cdxgen"
COUNT=$(jq '.components | length' "$SBOM_FILE") || fail "could not count the components of ${SBOM_FILE}"
[[ "$COUNT" -gt 0 ]] || fail "SBOM has zero components; an empty scan is not evidence"

# Fail closed (C-695-1): every value below comes from a plain command
# substitution checked with `|| fail`, never from an unchecked process
# substitution, so a jq, sort or comm failure stops the check with its reason
# instead of yielding an empty list that reads as "0 dev-only leaks".
jq empty "$LOCKFILE" >/dev/null 2>&1 \
  || fail "lockfile ${LOCKFILE} is not valid JSON; restore it from git or run npm install"
jq -e '.packages | type == "object"' "$LOCKFILE" >/dev/null 2>&1 \
  || fail "lockfile ${LOCKFILE} has no \"packages\" map (npm lockfile v2 or v3 needed); regenerate it with npm 7 or later"

# name@version of every component
COMPONENTS=$(jq -r '.components[] | "\(.name)@\(.version // "")"' "$SBOM_FILE" | sort -u) \
  || fail "could not list the components of ${SBOM_FILE}"

# name@version that appears in the lockfile ONLY as `dev: true` entries
# (lockfile v2/v3 `packages` map). A nested dev copy of a name@version that
# also exists as a production entry is not dev-only.
lock_nv() { # $1 = dev | prod
  jq -r --arg f "$1" '
    .packages | to_entries[] | select(.key != "")
    | select(if $f == "dev" then (.value.dev == true) else (.value.dev != true) end)
    | (.key | sub("^.*node_modules/"; "")) + "@" + (.value.version // "")' "$LOCKFILE" | sort -u
}
DEV=$(lock_nv dev) || fail "could not read the dev entries of ${LOCKFILE}"
PROD=$(lock_nv prod) || fail "could not read the production entries of ${LOCKFILE}"
[[ -n "$PROD" ]] || fail "lockfile ${LOCKFILE} lists no production packages; the dev-only check has nothing to compare against"
DEV_ONLY=$(comm -23 <(printf '%s\n' "$DEV") <(printf '%s\n' "$PROD")) \
  || fail "could not compare the dev and production entries of ${LOCKFILE}"

LEAK=$(comm -12 <(printf '%s\n' "$COMPONENTS") <(printf '%s\n' "$DEV_ONLY")) \
  || fail "could not compare ${SBOM_FILE} with the dev-only entries of ${LOCKFILE}"
[[ -z "$LEAK" ]] || fail "dev-only packages present in production SBOM: $(printf '%s' "$LEAK" | tr '\n' ' ')"

NAMES=$(jq -r '.components[].name' "$SBOM_FILE" | sort -u) || fail "could not list the component names of ${SBOM_FILE}"
# has_name <name>: 0 when <name> is one whole line of NAMES, 1 when it is not.
# A pure shell pattern match: no pipe, here-string, temp file or child
# process, so nothing can fail and read as "absent" (C-695-2). The earlier
# `printf | grep -q` lost a SIGPIPE race under pipefail, and a here-string
# that bash could not create (no free descriptor, no temp file) exited 1 like
# "no match". The quoted operand matches literally: `*`, `?` and `[` in a
# name are not patterns.
has_name() {
  [[ $'\n'"${NAMES}"$'\n' == *$'\n'"$1"$'\n'* ]]
}
for d in $DENY_LIST; do
  if has_name "$d"; then fail "build/test tool '${d}' present in production SBOM"; fi
done
for r in $REQUIRE_LIST; do
  has_name "$r" || fail "required runtime package '${r}' missing from production SBOM"
done

SHA=$(sha256sum "$SBOM_FILE" | awk '{print $1}')
echo "assert-prod-sbom: OK ${COUNT} components, 0 dev-only leaks, required runtime packages present"
echo "assert-prod-sbom: sha256 ${SHA}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "components=${COUNT}"; echo "sha256=${SHA}"; } >> "$GITHUB_OUTPUT"
fi
