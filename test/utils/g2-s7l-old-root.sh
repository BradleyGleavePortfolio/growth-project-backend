#!/usr/bin/env bash
# S7-L G2 OLD fixture: create (or preflight) the detached checkout of the S7-L base head
# (OLD_HEAD below: the accepted S8-B head 93389265) that test/utils/g2-s7l-bootstrap.sh
# step 4 requires. Derived by substitution from the committed N/Q1 helper
# test/utils/g2-nq1-old-root.sh (blob 4569f5fe at 61b93cff, unchanged): the same clone +
# detached checkout recipe; the identity gate here requires the OLD root to carry E, R and the
# pre-S7-L schema (no ScoutImport lifecycle fields) while the candidate
# ships exactly S7-L.
#
# Why this exists: a `git archive | tar` extraction is NOT a Git repository, so it can
# never satisfy bootstrap's identity gate (`git rev-parse HEAD` == T and a clean
# relevant-path diff). The fixture must be a real detached checkout. This script clones
# the candidate root itself (which must contain the R head in its history) and checks out
# it detached, changing no ref, worktree
# metadata or file of the candidate repository. It then runs the exact offline checks
# bootstrap will repeat, so the recipe is verified before any database or dependency work.
#
# Usage: G2_S7L_OLD_ROOT=<path> bash test/utils/g2-s7l-old-root.sh [create|preflight]
#   create     (default) clone + detached checkout at OLD_HEAD when the path does not exist,
#              then preflight. Refuses to reuse a path that is not that checkout.
#   preflight  only verify an existing path.
# Optional: G2_S7L_OLD_ROOT_SHARED=1 uses `git clone --shared` (objects read through
#   alternates from the candidate's object store; zero copy). Default is a self-contained
#   local clone (hardlinked/copied objects) that keeps working if the source moves.
# Needs git only. Never deletes anything; never touches PostgreSQL, node_modules, hosted
# or customer resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# OLD side pin (kept identical in test/utils/g2-s7l-bootstrap.sh and g2-s7l-pg-harness.ts).
OLD_HEAD=93389265a846095b846fa8f1fb0dad782fb6ee9f
E_MIGRATION=20270118000000_scout_ledger_platform_expand
R_MIGRATION=20270120000000_scout_identity_ready
C_MIGRATION=20270121000000_scout_identity_contract
S8B_MIGRATION=20270122000000_scout_native_provenance_expand
S7L_MIGRATION=20270123000000_scout_run_lifecycle_expand
# 164 base + S1 + C1 + E + B + R + C + S8-B = 171 at the accepted S8-B head.
EXPECTED_MIGRATIONS=171
MODE="${1:-create}"
[[ -n "${G2_S7L_OLD_ROOT:-}" ]] || { echo "missing G2_S7L_OLD_ROOT" >&2; exit 2; }
[[ "$MODE" == create || "$MODE" == preflight ]] || { echo "usage: $0 [create|preflight]" >&2; exit 2; }
case "$G2_S7L_OLD_ROOT" in /*) ;; *) echo "G2_S7L_OLD_ROOT must be absolute" >&2; exit 2;; esac
[[ "$G2_S7L_OLD_ROOT" != "$ROOT" && "$G2_S7L_OLD_ROOT" != "$ROOT"/* ]] \
  || { echo "old root must live outside the candidate root $ROOT" >&2; exit 2; }

# The candidate must carry OLD_HEAD in its own history; otherwise the shared node_modules
# rule in bootstrap (identical package.json/lock) has no basis either.
git -C "$ROOT" cat-file -e "$OLD_HEAD^{commit}" || { echo "candidate root does not contain the OLD head $OLD_HEAD" >&2; exit 3; }
git -C "$ROOT" merge-base --is-ancestor "$OLD_HEAD" HEAD || { echo "OLD head $OLD_HEAD is not an ancestor of candidate HEAD" >&2; exit 3; }

if [[ "$MODE" == create ]]; then
  if [[ -e "$G2_S7L_OLD_ROOT" ]]; then
    [[ -f "$G2_S7L_OLD_ROOT/.git" || -d "$G2_S7L_OLD_ROOT/.git" ]] \
      || { echo "$G2_S7L_OLD_ROOT exists but is not a Git checkout (an archive extraction cannot pass the identity gate); remove it" >&2; exit 4; }
    echo "old root already exists; verifying only"
  else
    # --no-checkout + checkout --detach: HEAD is the exact OLD commit, on no branch.
    # Nothing in the source repository changes either way.
    if [[ "${G2_S7L_OLD_ROOT_SHARED:-0}" == 1 ]]; then
      git clone --quiet --shared --no-checkout "$ROOT" "$G2_S7L_OLD_ROOT"
    else
      git clone --quiet --no-checkout "$ROOT" "$G2_S7L_OLD_ROOT"
    fi
    git -C "$G2_S7L_OLD_ROOT" checkout --quiet --detach "$OLD_HEAD"
  fi
fi

# ---- Offline preflight: exactly the bootstrap step-4 gate, plus the spec's byte checks.
[[ "$(git -C "$G2_S7L_OLD_ROOT" rev-parse HEAD)" == "$OLD_HEAD" ]] || { echo "old root is not $OLD_HEAD" >&2; exit 4; }
git -C "$G2_S7L_OLD_ROOT" symbolic-ref -q HEAD >/dev/null && { echo "old root HEAD must be detached, not a branch" >&2; exit 4; }
git -C "$G2_S7L_OLD_ROOT" diff --quiet HEAD -- package.json package-lock.json src prisma \
  || { echo "old root has uncommitted source/dependency changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ between OLD and candidate; a shared node_modules is unsafe" >&2; exit 4; }
[[ -d "$G2_S7L_OLD_ROOT/prisma/migrations/$E_MIGRATION" && -d "$G2_S7L_OLD_ROOT/prisma/migrations/$R_MIGRATION" && -d "$G2_S7L_OLD_ROOT/prisma/migrations/$C_MIGRATION" && -d "$G2_S7L_OLD_ROOT/prisma/migrations/$S8B_MIGRATION" ]] \
  || { echo "old root lacks E, R, C or S8-B; it is not a descendant of the accepted S8-B head" >&2; exit 4; }
[[ ! -d "$G2_S7L_OLD_ROOT/prisma/migrations/$S7L_MIGRATION" ]] || { echo "old root unexpectedly contains S7-L" >&2; exit 4; }
OLD_COUNT="$(find "$G2_S7L_OLD_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$OLD_COUNT" == "$EXPECTED_MIGRATIONS" ]] || { echo "old root has $OLD_COUNT migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 4; }
# The candidate ships exactly S7-L: its migration tree differs from the OLD root's by
# migration.sql + down.sql of S7L_MIGRATION and nothing else.
[[ "$(git -C "$ROOT" diff --name-only "$OLD_HEAD" HEAD -- prisma/migrations | sort | tr '\n' ' ')" \
  == "prisma/migrations/$S7L_MIGRATION/down.sql prisma/migrations/$S7L_MIGRATION/migration.sql " ]] \
  || { echo "candidate migrations differ from $OLD_HEAD by other than exactly S7-L's two files" >&2; exit 4; }
for file in scout.service.ts scout-ingest.service.ts scout.dto.ts scout-reconstruct.service.ts; do
  cmp -s "$G2_S7L_OLD_ROOT/src/scout/$file" <(git -C "$ROOT" show "$OLD_HEAD:src/scout/$file") \
    || { echo "old root src/scout/$file is not byte-identical to $OLD_HEAD" >&2; exit 4; }
done
# The OLD schema is the pre-S7-L shape (S8-B present, no ScoutImport lifecycle fields); the candidate adds them.
grep -q 'model ScoutReconstructionLedger ' "$G2_S7L_OLD_ROOT/prisma/schema.prisma" || { echo "old schema lacks the ScoutReconstructionLedger model" >&2; exit 4; }
grep -q 'model ImportNativeProvenance ' "$G2_S7L_OLD_ROOT/prisma/schema.prisma" \
  || { echo "old schema lacks S8-B's ImportNativeProvenance model; not the accepted S8-B head" >&2; exit 4; }
! awk '/model ScoutImport \{/,/\}/' "$G2_S7L_OLD_ROOT/prisma/schema.prisma" | grep -Eq '^ +(mode|import_intent_id|phase|execution_epoch|fenced_at) +' \
  || { echo "old ScoutImport model already carries S7-L's lifecycle fields" >&2; exit 4; }
# Dependencies are shared read-only by bootstrap through a symlink; report provenance if present.
if [[ -L "$G2_S7L_OLD_ROOT/node_modules" ]]; then
  echo "node_modules symlink -> $(readlink "$G2_S7L_OLD_ROOT/node_modules")"
elif [[ -e "$G2_S7L_OLD_ROOT/node_modules" ]]; then
  echo "old root has its own node_modules directory (not the shared symlink); bootstrap will not replace it" >&2; exit 4
fi
echo "old_root=$G2_S7L_OLD_ROOT head=$(git -C "$G2_S7L_OLD_ROOT" rev-parse HEAD) detached=yes migrations=$OLD_COUNT" \
  "alternates=$(cat "$(git -C "$G2_S7L_OLD_ROOT" rev-parse --absolute-git-dir)/objects/info/alternates" 2>/dev/null || echo none)"
echo "G2_S7L_OLD_ROOT_OK"
