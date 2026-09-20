#!/usr/bin/env bash
# migration-delta.sh — fail closed when a release may apply Prisma migrations
# without the operator having said so.
#
# Env:
#   MACHINES_JSON   flyctl machines list --json taken BEFORE the deploy
#   RELEASE_SHA     the authorized commit (checked out; full history available)
#   MIGRATIONS_ACK  workflow input; must equal "apply-migrations" when needed
#   MANIFEST        evidence manifest to extend (.migrations = {...})
#   PROCESS_GROUP   default "app"
#   MIGRATION_PATHS default "prisma/migrations prisma/schema.prisma"
#
# Rules: previous commit = GH_SHA label of the started machines in the group
# (must be one 40-hex value). If it is unknown, not in this repository's
# history, or the diff of MIGRATION_PATHS between it and RELEASE_SHA is
# non-empty, the release is refused unless MIGRATIONS_ACK == "apply-migrations".
# An empty delta with a stray acknowledgement is also refused (the input must
# mean something).
set -Eeuo pipefail
fail() { echo "::error::migration-delta: $*" >&2; exit 1; }

: "${MACHINES_JSON:?}" "${RELEASE_SHA:?}" "${MANIFEST:?}"
MIGRATIONS_ACK="${MIGRATIONS_ACK:-}"
PROCESS_GROUP="${PROCESS_GROUP:-app}"
MIGRATION_PATHS="${MIGRATION_PATHS:-prisma/migrations prisma/schema.prisma}"
ACK_WORD="apply-migrations"

[[ -f "$MACHINES_JSON" ]] || fail "machines json ${MACHINES_JSON} not found"
[[ -f "$MANIFEST" ]] || fail "manifest ${MANIFEST} not found"
[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "RELEASE_SHA must be 40-hex"
git cat-file -e "${RELEASE_SHA}^{commit}" 2>/dev/null || fail "RELEASE_SHA ${RELEASE_SHA} is not a commit in this checkout"

prev=$(jq -r --arg g "$PROCESS_GROUP" '
  [ .[] | select(.state == "started")
        | select((.config.metadata.fly_process_group // "app") == $g)
        | .image_ref.labels.GH_SHA // "unknown" ] | unique | join(",")' "$MACHINES_JSON")

status=""; files_json="[]"
if [[ -z "$prev" ]]; then
  status="unknown: no started machine in process group ${PROCESS_GROUP}"
elif [[ ! "$prev" =~ ^[0-9a-f]{40}$ ]]; then
  status="unknown: running GH_SHA label is '${prev}'"
elif ! git cat-file -e "${prev}^{commit}" 2>/dev/null; then
  status="unknown: running commit ${prev} is not in this repository's history"
else
  # shellcheck disable=SC2086
  files=$(git diff --name-only "$prev" "$RELEASE_SHA" -- $MIGRATION_PATHS || fail "git diff failed")
  files_json=$(printf '%s\n' "$files" | jq -R -s -c 'split("\n") | map(select(length > 0))')
  if [[ -z "$files" ]]; then status="empty"; else status="non-empty"; fi
fi

case "$status" in
  empty)
    [[ -z "$MIGRATIONS_ACK" ]] || fail "no migration/schema delta between ${prev} and ${RELEASE_SHA}, but migrations input is '${MIGRATIONS_ACK}'; leave it empty when nothing changes"
    echo "migration-delta: OK no prisma/migrations or schema change since running commit ${prev}" ;;
  non-empty)
    [[ "$MIGRATIONS_ACK" == "$ACK_WORD" ]] || fail "release changes $(printf '%s' "$files_json" | jq -r 'length') migration/schema file(s) since running commit ${prev} ($(printf '%s' "$files_json" | jq -r 'join(", ")' | cut -c1-400)); release_command will apply them before rollout. Refused without migrations input '${ACK_WORD}'"
    echo "migration-delta: acknowledged $(printf '%s' "$files_json" | jq -r 'length') migration/schema file(s) since ${prev}" ;;
  unknown*)
    [[ "$MIGRATIONS_ACK" == "$ACK_WORD" ]] || fail "cannot compute migration delta (${status}); refused without migrations input '${ACK_WORD}'"
    echo "migration-delta: delta ${status}; proceeding on explicit acknowledgement" ;;
esac

jq --arg prev "${prev:-}" --arg status "$status" --argjson files "$files_json" --arg ack "$MIGRATIONS_ACK" \
   --arg paths "$MIGRATION_PATHS" \
   '.migrations = {previous_running_sha: (if $prev == "" then null else $prev end), status: $status, paths: ($paths | split(" ")), files: $files, acknowledged: ($ack == "apply-migrations")}' \
   "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
