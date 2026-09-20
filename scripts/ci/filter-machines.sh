#!/usr/bin/env bash
# filter-machines.sh <flyctl machines list --json output>
# Emits only the fields release evidence needs. Raw machine objects carry the
# full machine config (env, services, metadata) and are not uploaded.
set -Eeuo pipefail
IN="${1:?machines json path}"
jq '[ .[] | {
  id, name, region, state,
  image_ref: (.image_ref | {registry, repository, tag, digest, labels}),
  process_group: (.config.metadata.fly_process_group // null),
  checks: ((.checks // []) | map({name, status, updated_at})),
  updated_at
} ]' "$IN"
