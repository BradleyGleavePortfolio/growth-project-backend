#!/usr/bin/env bash
# S10-D D1 — the CORE DIFF = 0 gate (docs/decisions/2026-09-26-s10-induction.md D-S10-5).
#
# Usage: scripts/s10-core-diff-gate.sh <B> [<HEAD>]
#   <B>     the pinned baseline: a full 40-hex commit id (recorded immutably in the D2 grant).
#   <HEAD>  optional; must resolve to the checked-out HEAD (the working-tree checks 2 and 5 are
#           only meaningful for the checkout). Defaults to HEAD.
# Run from anywhere inside the repository. Exit 0 = gate passes; any other exit = gate fails.
#
# Checks (any failure, or any tool exit >= 2, fails):
#   1  B is an ancestor of HEAD
#   2  the working tree is clean, untracked files included
#   3  `git diff --name-only B HEAD` equals the allowed per-source set exactly, and every allowed
#      path is present at HEAD as a regular blob of mode 100644 (no symlink/gitlink/executable)
#   4  every other path is byte-identical between B and HEAD
#   5  `rg -F -l s10_unseen src --type ts` exits 1 on HEAD's src
#   6  the same over B's src exits 1
#   7  RUN_REASON_CODES, COMPLETENESS_BASIS_KINDS, OBSERVATION_CONFLICT_CODES and
#      docs/contracts/importer-openapi.json are unchanged
# Check 8 (three negative controls on scratch branches) is parent-run; see the D1 summary.
#
# Every command's status and output is captured first and then tested; nothing is piped into a
# `grep -q` (which could SIGPIPE its producer under pipefail and mask a result).

set -euo pipefail
unset RIPGREP_CONFIG_PATH GIT_DIR GIT_WORK_TREE

ALLOWED=(
  'src/scout/induction/sources/s10_unseen.json'
  'src/scout/reconstruct/native/sources/s10_unseen.json'
  'src/scout/reconstruct/sources/s10_unseen.json'
  'test/fixtures/scout/s10_unseen/signer-test-key.json'
  'test/fixtures/scout/s10_unseen/staged-rows.json'
  'test/fixtures/scout/s10_unseen/statements.json'
  'test/scout/s10/s10-unseen.e2e.spec.ts'
  'test/scout/s10/s10-unseen.pg.spec.ts'
)

# Files whose bytes carry the closed vocabularies of check 7.
VOCAB_FILES=(
  'docs/contracts/importer-openapi.json'
  'src/scout/induction/contract.ts'
  'src/scout/lifecycle/reason-codes.ts'
)
VOCAB_SYMBOLS=(
  'RUN_REASON_CODES:src/scout/lifecycle/reason-codes.ts'
  'COMPLETENESS_BASIS_KINDS:src/scout/induction/contract.ts'
  'OBSERVATION_CONFLICT_CODES:src/scout/induction/contract.ts'
)

fail() {
  printf 's10-core-diff-gate: FAIL [%s] %s\n' "$1" "$2" >&2
  exit 1
}
pass() { printf 's10-core-diff-gate: ok   [%s] %s\n' "$1" "$2"; }

# ── arguments ────────────────────────────────────────────────────────────────────────────
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail args 'usage: s10-core-diff-gate.sh <B-40-hex> [<HEAD>]'
BASE_ARG="$1"
HEAD_ARG="${2:-HEAD}"
[[ "$BASE_ARG" =~ ^[0-9a-f]{40}$ ]] || fail args "B must be a full 40-hex commit id: $BASE_ARG"

command -v git >/dev/null 2>&1 || fail tools 'git not found'
command -v rg >/dev/null 2>&1 || fail tools 'rg not found'

set +e
TOP="$(git rev-parse --show-toplevel 2>&1)"; rc=$?
set -e
[ "$rc" -eq 0 ] || fail repo "not inside a git work tree: $TOP"
cd "$TOP"

set +e
BASE="$(git rev-parse --verify --quiet "${BASE_ARG}^{commit}")"; rc_b=$?
HEAD_COMMIT="$(git rev-parse --verify --quiet "${HEAD_ARG}^{commit}")"; rc_h=$?
CHECKED_OUT="$(git rev-parse --verify --quiet 'HEAD^{commit}')"; rc_c=$?
set -e
[ "$rc_b" -eq 0 ] && [ "$BASE" = "$BASE_ARG" ] || fail args "B is not a commit: $BASE_ARG"
[ "$rc_h" -eq 0 ] || fail args "HEAD is not a commit: $HEAD_ARG"
[ "$rc_c" -eq 0 ] || fail args 'no checked-out HEAD'
[ "$HEAD_COMMIT" = "$CHECKED_OUT" ] ||
  fail args "<HEAD> ($HEAD_COMMIT) must be the checked-out HEAD ($CHECKED_OUT)"
[ "$BASE" != "$HEAD_COMMIT" ] || fail args 'B equals HEAD: nothing to gate'

# ── 1: ancestry ──────────────────────────────────────────────────────────────────────────
set +e
git merge-base --is-ancestor "$BASE" "$HEAD_COMMIT"; rc=$?
set -e
[ "$rc" -eq 0 ] || fail 1 "B is not an ancestor of HEAD (git exit $rc)"
pass 1 'B is an ancestor of HEAD'

# ── 2: clean working tree ────────────────────────────────────────────────────────────────
set +e
STATUS="$(git status --porcelain --untracked-files=all 2>&1)"; rc=$?
set -e
[ "$rc" -eq 0 ] || fail 2 "git status exited $rc"
[ -z "$STATUS" ] || fail 2 "working tree not clean:
$STATUS"
pass 2 'working tree clean (untracked included)'

# ── 3: changed paths equal the allowed set exactly ───────────────────────────────────────
set +e
CHANGED="$(git -c core.quotePath=false diff --no-renames --name-only "$BASE" "$HEAD_COMMIT" 2>&1)"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail 3 "git diff --name-only exited $rc"
CHANGED_SORTED="$(printf '%s\n' "$CHANGED" | LC_ALL=C sort -u)"
ALLOWED_SORTED="$(printf '%s\n' "${ALLOWED[@]}" | LC_ALL=C sort -u)"
[ "$CHANGED_SORTED" = "$ALLOWED_SORTED" ] || fail 3 "changed paths differ from the allowed set.
changed:
$CHANGED_SORTED
allowed:
$ALLOWED_SORTED"
# Each allowed path must be a regular, non-executable file at HEAD: mode 100644, type blob. A
# symlink (120000), gitlink/submodule (160000), executable (100755) or tree is refused.
TAB="$(printf '\t')"
for path in "${ALLOWED[@]}"; do
  set +e
  ENTRY="$(git -c core.quotePath=false ls-tree --full-tree "$HEAD_COMMIT" -- "$path" 2>&1)"; rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail 3 "git ls-tree exited $rc for $path"
  [ -n "$ENTRY" ] || fail 3 "allowed path missing (deleted?) at HEAD: $path"
  case "$ENTRY" in
    *$'\n'*) fail 3 "more than one tree entry for $path:
$ENTRY" ;;
  esac
  META="${ENTRY%%"$TAB"*}"
  NAME="${ENTRY#*"$TAB"}"
  [ "$NAME" = "$path" ] || fail 3 "tree entry name mismatch for $path: $NAME"
  MODE="${META%% *}"
  REST="${META#* }"
  TYPE="${REST%% *}"
  [ "$MODE" = '100644' ] && [ "$TYPE" = 'blob' ] ||
    fail 3 "allowed path is not a regular 100644 blob at HEAD (mode $MODE, type $TYPE): $path"
done
pass 3 "changed paths == allowed set (${#ALLOWED[@]} paths, all present as 100644 blobs)"

# ── 4: every other path byte-identical ───────────────────────────────────────────────────
EXCLUDES=()
for path in "${ALLOWED[@]}"; do EXCLUDES+=(":(exclude,literal)${path}"); done
set +e
git diff --no-renames --binary --exit-code --quiet "$BASE" "$HEAD_COMMIT" -- . "${EXCLUDES[@]}"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail 4 "a path outside the allowed set differs (git diff exit $rc)"
pass 4 'every other path byte-identical'

# ── 5: no slug literal in HEAD src ───────────────────────────────────────────────────────
set +e
HITS="$(rg -F -l s10_unseen src --type ts 2>&1)"; rc=$?
set -e
[ "$rc" -eq 1 ] || fail 5 "rg over HEAD src exited $rc (expected 1):
$HITS"
pass 5 'no s10_unseen literal in HEAD src/**/*.ts'

# ── 6: the same over B's src ─────────────────────────────────────────────────────────────
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
set +e
git archive --format=tar "$BASE" src >"$SCRATCH/base-src.tar"; rc=$?
set -e
[ "$rc" -eq 0 ] || fail 6 "git archive of B src exited $rc"
set +e
tar -x -f "$SCRATCH/base-src.tar" -C "$SCRATCH"; rc=$?
set -e
[ "$rc" -eq 0 ] || fail 6 "tar exited $rc"
[ -d "$SCRATCH/src" ] || fail 6 'B has no src directory'
set +e
HITS="$(cd "$SCRATCH" && rg -F -l s10_unseen src --type ts 2>&1)"; rc=$?
set -e
[ "$rc" -eq 1 ] || fail 6 "rg over B src exited $rc (expected 1):
$HITS"
pass 6 'no s10_unseen literal in B src/**/*.ts'

# ── 7: closed vocabularies and the importer contract unchanged ───────────────────────────
for file in "${VOCAB_FILES[@]}"; do
  set +e
  git cat-file -e "${BASE}:${file}" 2>/dev/null; rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail 7 "vocabulary file absent at B: $file"
done
for entry in "${VOCAB_SYMBOLS[@]}"; do
  symbol="${entry%%:*}"
  file="${entry#*:}"
  set +e
  BLOB="$(git show "${BASE}:${file}" 2>&1)"; rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail 7 "cannot read $file at B (git exit $rc)"
  case "$BLOB" in
    *"export const ${symbol}"*) ;;
    *) fail 7 "$symbol is not declared in $file at B" ;;
  esac
done
set +e
git diff --no-renames --binary --exit-code --quiet "$BASE" "$HEAD_COMMIT" -- "${VOCAB_FILES[@]}"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail 7 "a vocabulary file or the importer contract changed (git diff exit $rc)"
pass 7 'RUN_REASON_CODES, COMPLETENESS_BASIS_KINDS, OBSERVATION_CONFLICT_CODES, importer-openapi.json unchanged'

printf 's10-core-diff-gate: PASS B=%s HEAD=%s\n' "$BASE" "$HEAD_COMMIT"
