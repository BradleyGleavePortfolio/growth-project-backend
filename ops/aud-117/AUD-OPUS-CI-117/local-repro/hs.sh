set -Eeuo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
NAMES=$'eslint\njest\nprisma'
has_name() {
  local rc=0
  grep -qxF -- "$1" <<<"$NAMES" || rc=$?
  case "$rc" in
    0 | 1) return "$rc" ;;
    *) fail "grep exited ${rc} while checking '${1}'" ;;
  esac
}
ulimit -n "${LIM:-1024}"
if has_name eslint; then echo "eslint PRESENT (correct)"; else echo "eslint ABSENT (wrong: denylist passes)"; fi
