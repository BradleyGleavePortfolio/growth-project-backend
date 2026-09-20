#!/usr/bin/env bash
# Fake `gh` for test/ci/release-evidence-gate.spec.ts.
# `gh api <path>` prints the file $FAKE_GH_DIR/<encoded path>; a missing file
# behaves like an API error (non-zero exit, message on stderr).
set -euo pipefail
[[ "${1:-}" == "api" ]] || { echo "fake gh: unsupported command $*" >&2; exit 2; }
path=$2
key=$(printf '%s' "$path" | sed -e 's#/#__#g' -e 's#?#_Q_#g' -e 's#&#_A_#g' -e 's#=#_E_#g')
file="${FAKE_GH_DIR:?}/${key}"
echo "$path" >> "${FAKE_GH_DIR}/.calls"
if [[ ! -f "$file" ]]; then
  echo "gh: HTTP 404: Not Found (https://api.github.com/${path})" >&2
  exit 1
fi
cat "$file"
