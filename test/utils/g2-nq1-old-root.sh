#!/usr/bin/env bash
# S7-3' G2 N/Q1 T fixture: create (or preflight) the detached checkout of the accepted R head
# 7d2895e1 (the T writer / Q0 readers / R schema) that test/utils/g2-nq1-bootstrap.sh step 4
# requires. Derived by substitution from the accepted S5 helper test/utils/g2-pg17-old-root.sh
# (unchanged): the same clone + detached checkout recipe, with the identity gate inverted where
# the T root, unlike O, MUST carry E and R and the R-shaped (optional) ledger provenance.
#
# Why this exists: a `git archive | tar` extraction is NOT a Git repository, so it can
# never satisfy bootstrap's identity gate (`git rev-parse HEAD` == T and a clean
# relevant-path diff). The fixture must be a real detached checkout. This script clones
# the candidate root itself (which must contain the R head in its history) and checks out
# it detached, changing no ref, worktree
# metadata or file of the candidate repository. It then runs the exact offline checks
# bootstrap will repeat, so the recipe is verified before any database or dependency work.
#
# Usage: G2_NQ1_OLD_ROOT=<path> bash test/utils/g2-nq1-old-root.sh [create|preflight]
#   create     (default) clone + detached checkout at the R head when the path does not exist,
#              then preflight. Refuses to reuse a path that is not that checkout.
#   preflight  only verify an existing path.
# Optional: G2_NQ1_OLD_ROOT_SHARED=1 uses `git clone --shared` (objects read through
#   alternates from the candidate's object store; zero copy). Default is a self-contained
#   local clone (hardlinked/copied objects) that keeps working if the source moves.
# Needs git only. Never deletes anything; never touches PostgreSQL, node_modules, hosted
# or customer resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OLD_HEAD=7d2895e1fe03ea82353e8ce0b07aacaf66af74c8
E_MIGRATION=20270118000000_scout_ledger_platform_expand
R_MIGRATION=20270120000000_scout_identity_ready
EXPECTED_MIGRATIONS=169
MODE="${1:-create}"
[[ -n "${G2_NQ1_OLD_ROOT:-}" ]] || { echo "missing G2_NQ1_OLD_ROOT" >&2; exit 2; }
[[ "$MODE" == create || "$MODE" == preflight ]] || { echo "usage: $0 [create|preflight]" >&2; exit 2; }
case "$G2_NQ1_OLD_ROOT" in /*) ;; *) echo "G2_NQ1_OLD_ROOT must be absolute" >&2; exit 2;; esac
[[ "$G2_NQ1_OLD_ROOT" != "$ROOT" && "$G2_NQ1_OLD_ROOT" != "$ROOT"/* ]] \
  || { echo "old root must live outside the candidate root $ROOT" >&2; exit 2; }

# The candidate must carry the R head in its own history; otherwise the shared node_modules
# rule in bootstrap (identical package.json/lock) has no basis either.
git -C "$ROOT" cat-file -e "$OLD_HEAD^{commit}" || { echo "candidate root does not contain the R head $OLD_HEAD" >&2; exit 3; }
git -C "$ROOT" merge-base --is-ancestor "$OLD_HEAD" HEAD || { echo "R head $OLD_HEAD is not an ancestor of candidate HEAD" >&2; exit 3; }

if [[ "$MODE" == create ]]; then
  if [[ -e "$G2_NQ1_OLD_ROOT" ]]; then
    [[ -f "$G2_NQ1_OLD_ROOT/.git" || -d "$G2_NQ1_OLD_ROOT/.git" ]] \
      || { echo "$G2_NQ1_OLD_ROOT exists but is not a Git checkout (an archive extraction cannot pass the identity gate); remove it" >&2; exit 4; }
    echo "old root already exists; verifying only"
  else
    # --no-checkout + checkout --detach: HEAD is the exact R commit, on no branch.
    # Nothing in the source repository changes either way.
    if [[ "${G2_NQ1_OLD_ROOT_SHARED:-0}" == 1 ]]; then
      git clone --quiet --shared --no-checkout "$ROOT" "$G2_NQ1_OLD_ROOT"
    else
      git clone --quiet --no-checkout "$ROOT" "$G2_NQ1_OLD_ROOT"
    fi
    git -C "$G2_NQ1_OLD_ROOT" checkout --quiet --detach "$OLD_HEAD"
  fi
fi

# ---- Offline preflight: exactly the bootstrap step-4 gate, plus the spec's byte checks.
[[ "$(git -C "$G2_NQ1_OLD_ROOT" rev-parse HEAD)" == "$OLD_HEAD" ]] || { echo "old root is not $OLD_HEAD" >&2; exit 4; }
git -C "$G2_NQ1_OLD_ROOT" symbolic-ref -q HEAD >/dev/null && { echo "old root HEAD must be detached, not a branch" >&2; exit 4; }
git -C "$G2_NQ1_OLD_ROOT" diff --quiet HEAD -- package.json package-lock.json src prisma \
  || { echo "old root has uncommitted source/dependency changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ between T and candidate; a shared node_modules is unsafe" >&2; exit 4; }
[[ -d "$G2_NQ1_OLD_ROOT/prisma/migrations/$E_MIGRATION" && -d "$G2_NQ1_OLD_ROOT/prisma/migrations/$R_MIGRATION" ]] \
  || { echo "old root lacks E or R; it is not the accepted R head" >&2; exit 4; }
OLD_COUNT="$(find "$G2_NQ1_OLD_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$OLD_COUNT" == "$EXPECTED_MIGRATIONS" ]] || { echo "old root has $OLD_COUNT migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 4; }
# N/Q1 ships no migration: the candidate's migration tree is byte-identical to the T root's.
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- prisma/migrations \
  || { echo "candidate migrations differ from the accepted R head; N/Q1 must ship none" >&2; exit 4; }
for file in scout-reconstruct.service.ts scout-roster.service.ts scout-entities.service.ts; do
  cmp -s "$G2_NQ1_OLD_ROOT/src/scout/$file" <(git -C "$ROOT" show "$OLD_HEAD:src/scout/$file") \
    || { echo "old root src/scout/$file is not byte-identical to $OLD_HEAD" >&2; exit 4; }
done
# The T ledger model carries R's OPTIONAL provenance (`String?`); the N candidate makes it required.
grep -q 'model ScoutReconstructionLedger' "$G2_NQ1_OLD_ROOT/prisma/schema.prisma" || { echo "old schema lacks the ledger model" >&2; exit 4; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$G2_NQ1_OLD_ROOT/prisma/schema.prisma" | grep -Eq 'source_platform +String\?' \
  || { echo "old ledger model does not carry R's optional source_platform" >&2; exit 4; }
# Dependencies are shared read-only by bootstrap through a symlink; report provenance if present.
if [[ -L "$G2_NQ1_OLD_ROOT/node_modules" ]]; then
  echo "node_modules symlink -> $(readlink "$G2_NQ1_OLD_ROOT/node_modules")"
elif [[ -e "$G2_NQ1_OLD_ROOT/node_modules" ]]; then
  echo "old root has its own node_modules directory (not the shared symlink); bootstrap will not replace it" >&2; exit 4
fi
echo "old_root=$G2_NQ1_OLD_ROOT head=$(git -C "$G2_NQ1_OLD_ROOT" rev-parse HEAD) detached=yes migrations=$OLD_COUNT" \
  "alternates=$(cat "$(git -C "$G2_NQ1_OLD_ROOT" rev-parse --absolute-git-dir)/objects/info/alternates" 2>/dev/null || echo none)"
echo "G2_NQ1_OLD_ROOT_OK"
