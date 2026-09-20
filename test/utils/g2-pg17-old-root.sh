#!/usr/bin/env bash
# S5 G2 preserved-O fixture: create (or preflight) the detached checkout of the O
# writer source 925780e0 that test/utils/g2-pg17-bootstrap.sh step 4 requires.
#
# Why this exists: a `git archive | tar` extraction is NOT a Git repository, so it can
# never satisfy bootstrap's identity gate (`git rev-parse HEAD` == O and a clean
# relevant-path diff). The fixture must be a real detached checkout. This script clones
# the candidate root itself (which must contain O in its history, e.g. a bundle restore of
# the candidate on the public base) and checks out O detached, changing no ref, worktree
# metadata or file of the candidate repository. It then runs the exact offline checks
# bootstrap will repeat, so the recipe is verified before any database or dependency work.
#
# Usage: G2_PG17_OLD_ROOT=<path> bash test/utils/g2-pg17-old-root.sh [create|preflight]
#   create     (default) clone + detached checkout at O when the path does not exist,
#              then preflight. Refuses to reuse a path that is not that checkout.
#   preflight  only verify an existing path.
# Optional: G2_PG17_OLD_ROOT_SHARED=1 uses `git clone --shared` (objects read through
#   alternates from the candidate's object store; zero copy). Default is a self-contained
#   local clone (hardlinked/copied objects) that keeps working if the source moves.
# Needs git only. Never deletes anything; never touches PostgreSQL, node_modules, hosted
# or customer resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OLD_HEAD=925780e0a1906593e5383c618311b6b17364b8dc
E_MIGRATION=20270118000000_scout_ledger_platform_expand
MODE="${1:-create}"
[[ -n "${G2_PG17_OLD_ROOT:-}" ]] || { echo "missing G2_PG17_OLD_ROOT" >&2; exit 2; }
[[ "$MODE" == create || "$MODE" == preflight ]] || { echo "usage: $0 [create|preflight]" >&2; exit 2; }
case "$G2_PG17_OLD_ROOT" in /*) ;; *) echo "G2_PG17_OLD_ROOT must be absolute" >&2; exit 2;; esac
[[ "$G2_PG17_OLD_ROOT" != "$ROOT" && "$G2_PG17_OLD_ROOT" != "$ROOT"/* ]] \
  || { echo "old root must live outside the candidate root $ROOT" >&2; exit 2; }

# The candidate must carry O in its own history; otherwise the shared node_modules
# rule in bootstrap (identical package.json/lock) has no basis either.
git -C "$ROOT" cat-file -e "$OLD_HEAD^{commit}" || { echo "candidate root does not contain O $OLD_HEAD" >&2; exit 3; }
git -C "$ROOT" merge-base --is-ancestor "$OLD_HEAD" HEAD || { echo "O $OLD_HEAD is not an ancestor of candidate HEAD" >&2; exit 3; }

if [[ "$MODE" == create ]]; then
  if [[ -e "$G2_PG17_OLD_ROOT" ]]; then
    [[ -f "$G2_PG17_OLD_ROOT/.git" || -d "$G2_PG17_OLD_ROOT/.git" ]] \
      || { echo "$G2_PG17_OLD_ROOT exists but is not a Git checkout (an archive extraction cannot pass the identity gate); remove it" >&2; exit 4; }
    echo "old root already exists; verifying only"
  else
    # --no-checkout + checkout --detach: HEAD is the exact O commit, on no branch.
    # Nothing in the source repository changes either way.
    if [[ "${G2_PG17_OLD_ROOT_SHARED:-0}" == 1 ]]; then
      git clone --quiet --shared --no-checkout "$ROOT" "$G2_PG17_OLD_ROOT"
    else
      git clone --quiet --no-checkout "$ROOT" "$G2_PG17_OLD_ROOT"
    fi
    git -C "$G2_PG17_OLD_ROOT" checkout --quiet --detach "$OLD_HEAD"
  fi
fi

# ---- Offline preflight: exactly the bootstrap step-4 gate, plus the spec's byte checks.
[[ "$(git -C "$G2_PG17_OLD_ROOT" rev-parse HEAD)" == "$OLD_HEAD" ]] || { echo "old root is not $OLD_HEAD" >&2; exit 4; }
git -C "$G2_PG17_OLD_ROOT" symbolic-ref -q HEAD >/dev/null && { echo "old root HEAD must be detached, not a branch" >&2; exit 4; }
git -C "$G2_PG17_OLD_ROOT" diff --quiet HEAD -- package.json package-lock.json src prisma \
  || { echo "old root has uncommitted source/dependency changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ between O and candidate; a shared node_modules is unsafe" >&2; exit 4; }
[[ ! -d "$G2_PG17_OLD_ROOT/prisma/migrations/$E_MIGRATION" ]] || { echo "old root unexpectedly contains E" >&2; exit 4; }
OLD_COUNT="$(find "$G2_PG17_OLD_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$OLD_COUNT" == "164" ]] || { echo "old root has $OLD_COUNT migrations, expected 164" >&2; exit 4; }
for file in scout-reconstruct.service.ts scout-roster.service.ts scout-entities.service.ts; do
  cmp -s "$G2_PG17_OLD_ROOT/src/scout/$file" <(git -C "$ROOT" show "$OLD_HEAD:src/scout/$file") \
    || { echo "old root src/scout/$file is not byte-identical to $OLD_HEAD" >&2; exit 4; }
done
# Only the ledger model must lack the E column (the staging model carries source_platform pre-E).
grep -q 'model ScoutReconstructionLedger' "$G2_PG17_OLD_ROOT/prisma/schema.prisma" || { echo "old schema lacks the ledger model" >&2; exit 4; }
! awk '/model ScoutReconstructionLedger \{/,/\}/' "$G2_PG17_OLD_ROOT/prisma/schema.prisma" | grep -q source_platform \
  || { echo "old ledger model unexpectedly has source_platform" >&2; exit 4; }
# Dependencies are shared read-only by bootstrap through a symlink; report provenance if present.
if [[ -L "$G2_PG17_OLD_ROOT/node_modules" ]]; then
  echo "node_modules symlink -> $(readlink "$G2_PG17_OLD_ROOT/node_modules")"
elif [[ -e "$G2_PG17_OLD_ROOT/node_modules" ]]; then
  echo "old root has its own node_modules directory (not the shared symlink); bootstrap will not replace it" >&2; exit 4
fi
echo "old_root=$G2_PG17_OLD_ROOT head=$(git -C "$G2_PG17_OLD_ROOT" rev-parse HEAD) detached=yes migrations=$OLD_COUNT" \
  "alternates=$(cat "$(git -C "$G2_PG17_OLD_ROOT" rev-parse --absolute-git-dir)/objects/info/alternates" 2>/dev/null || echo none)"
echo "G2_PG17_OLD_ROOT_OK"
