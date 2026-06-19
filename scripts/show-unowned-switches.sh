#!/usr/bin/env bash
#
# scripts/show-unowned-switches.sh
#
# Lists every switch in prod-switches.yml still owned by `unowned`, with a
# summary count and the current unowned ratio. Used by maintainers to chip
# away at the ownership backlog (F-B17). The deploy-readiness suite enforces a
# hard ceiling on this ratio; this script is the human-facing companion that
# shows WHICH switches are still unclaimed so they can be triaged.
#
# Usage:
#   ./scripts/show-unowned-switches.sh            # human-readable
#   ./scripts/show-unowned-switches.sh --names    # bare names, one per line
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${REPO_ROOT}/prod-switches.yml"

if [[ ! -f "${REGISTRY}" ]]; then
  echo "prod-switches.yml not found at ${REGISTRY}" >&2
  exit 1
fi

# Walk the YAML line-by-line tracking the current entry name; emit the name
# when its owner line reads exactly `unowned`. Avoids a YAML dep so the script
# runs anywhere bash + awk exist (CI minimal images included).
mapfile -t UNOWNED < <(
  awk '
    /^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {
      name = $0
      sub(/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/, "", name)
      gsub(/"/, "", name)
      next
    }
    /^[[:space:]]*owner:[[:space:]]*/ {
      owner = $0
      sub(/^[[:space:]]*owner:[[:space:]]*/, "", owner)
      gsub(/"/, "", owner)
      if (owner == "unowned" && name != "") print name
    }
  ' "${REGISTRY}"
)

TOTAL=$(awk '/^[[:space:]]*-[[:space:]]*name:[[:space:]]*/ {c++} END {print c+0}' "${REGISTRY}")
COUNT=${#UNOWNED[@]}

if [[ "${1:-}" == "--names" ]]; then
  printf '%s\n' "${UNOWNED[@]}"
  exit 0
fi

echo "Unowned switches: ${COUNT} / ${TOTAL}"
if [[ ${TOTAL} -gt 0 ]]; then
  PCT=$(awk -v c="${COUNT}" -v t="${TOTAL}" 'BEGIN { printf "%.1f", (c/t)*100 }')
  echo "Unowned ratio:    ${PCT}%"
fi
echo
if [[ ${COUNT} -gt 0 ]]; then
  echo "Claim these by setting an owner in prod-switches.yml:"
  printf '  - %s\n' "${UNOWNED[@]}"
fi
