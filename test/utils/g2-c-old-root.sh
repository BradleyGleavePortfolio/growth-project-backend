#!/usr/bin/env bash
# S7-3' G2 C old-side fixture: create (or preflight) the detached checkout of the accepted N/Q1
# head (the N writer / Q1 readers / R schema with both narrow keys still declared) that
# test/utils/g2-c-bootstrap.sh step 4 requires. Derived by substitution from the accepted N/Q1
# helper test/utils/g2-nq1-old-root.sh (unchanged): the same clone + detached checkout recipe,
# with the identity gate moved to the N/Q1 head: the old root MUST carry E and R, MUST NOT carry
# C, and carries N's REQUIRED ledger provenance plus both narrow `@@unique` declarations.
# OLD_HEAD is a placeholder until the parent records N/Q1 acceptance (phase 2 fill).
#
# Why this exists: a `git archive | tar` extraction is NOT a Git repository, so it can
# never satisfy bootstrap's identity gate (`git rev-parse HEAD` == the N/Q1 head and a clean
# relevant-path diff). The fixture must be a real detached checkout. This script clones
# the candidate root itself (which must contain the N/Q1 head in its history) and checks out
# it detached, changing no ref, worktree
# metadata or file of the candidate repository. It then runs the exact offline checks
# bootstrap will repeat, so the recipe is verified before any database or dependency work.
#
# Usage: G2_C_OLD_ROOT=<path> bash test/utils/g2-c-old-root.sh [create|preflight]
#   create     (default) clone + detached checkout at the N/Q1 head when the path does not exist,
#              then preflight. Refuses to reuse a path that is not that checkout.
#   preflight  only verify an existing path.
# Optional: G2_C_OLD_ROOT_SHARED=1 uses `git clone --shared` (objects read through
#   alternates from the candidate's object store; zero copy). Default is a self-contained
#   local clone (hardlinked/copied objects) that keeps working if the source moves.
# Needs git only. Never deletes anything; never touches PostgreSQL, node_modules, hosted
# or customer resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OLD_HEAD=29e60705d8c4e1228fd1d2f248c7e53b6b8e56dd
E_MIGRATION=20270118000000_scout_ledger_platform_expand
R_MIGRATION=20270120000000_scout_identity_ready
C_MIGRATION=20270121000000_scout_identity_contract
EXPECTED_MIGRATIONS=169
MODE="${1:-create}"
[[ -n "${G2_C_OLD_ROOT:-}" ]] || { echo "missing G2_C_OLD_ROOT" >&2; exit 2; }
[[ "$MODE" == create || "$MODE" == preflight ]] || { echo "usage: $0 [create|preflight]" >&2; exit 2; }
case "$G2_C_OLD_ROOT" in /*) ;; *) echo "G2_C_OLD_ROOT must be absolute" >&2; exit 2;; esac
[[ "$G2_C_OLD_ROOT" != "$ROOT" && "$G2_C_OLD_ROOT" != "$ROOT"/* ]] \
  || { echo "old root must live outside the candidate root $ROOT" >&2; exit 2; }

# The candidate must carry the N/Q1 head in its own history; otherwise the shared node_modules
# rule in bootstrap (identical package.json/lock) has no basis either.
[[ "$OLD_HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo "OLD_HEAD is not a filled commit id ($OLD_HEAD); N/Q1 acceptance not recorded" >&2; exit 3; }
git -C "$ROOT" cat-file -e "$OLD_HEAD^{commit}" || { echo "candidate root does not contain the N/Q1 head $OLD_HEAD" >&2; exit 3; }
git -C "$ROOT" merge-base --is-ancestor "$OLD_HEAD" HEAD || { echo "N/Q1 head $OLD_HEAD is not an ancestor of candidate HEAD" >&2; exit 3; }

if [[ "$MODE" == create ]]; then
  if [[ -e "$G2_C_OLD_ROOT" ]]; then
    [[ -f "$G2_C_OLD_ROOT/.git" || -d "$G2_C_OLD_ROOT/.git" ]] \
      || { echo "$G2_C_OLD_ROOT exists but is not a Git checkout (an archive extraction cannot pass the identity gate); remove it" >&2; exit 4; }
    echo "old root already exists; verifying only"
  else
    # --no-checkout + checkout --detach: HEAD is the exact N/Q1 commit, on no branch.
    # Nothing in the source repository changes either way.
    if [[ "${G2_C_OLD_ROOT_SHARED:-0}" == 1 ]]; then
      git clone --quiet --shared --no-checkout "$ROOT" "$G2_C_OLD_ROOT"
    else
      git clone --quiet --no-checkout "$ROOT" "$G2_C_OLD_ROOT"
    fi
    git -C "$G2_C_OLD_ROOT" checkout --quiet --detach "$OLD_HEAD"
  fi
fi

# ---- Offline preflight: exactly the bootstrap step-4 gate, plus the spec's byte checks.
[[ "$(git -C "$G2_C_OLD_ROOT" rev-parse HEAD)" == "$OLD_HEAD" ]] || { echo "old root is not $OLD_HEAD" >&2; exit 4; }
git -C "$G2_C_OLD_ROOT" symbolic-ref -q HEAD >/dev/null && { echo "old root HEAD must be detached, not a branch" >&2; exit 4; }
git -C "$G2_C_OLD_ROOT" diff --quiet HEAD -- package.json package-lock.json src prisma \
  || { echo "old root has uncommitted source/dependency changes" >&2; exit 4; }
git -C "$ROOT" diff --quiet "$OLD_HEAD" HEAD -- package.json package-lock.json \
  || { echo "dependency manifests differ between N/Q1 and candidate; a shared node_modules is unsafe" >&2; exit 4; }
[[ -d "$G2_C_OLD_ROOT/prisma/migrations/$E_MIGRATION" && -d "$G2_C_OLD_ROOT/prisma/migrations/$R_MIGRATION" ]] \
  || { echo "old root lacks E or R; it is not the accepted N/Q1 head" >&2; exit 4; }
[[ ! -e "$G2_C_OLD_ROOT/prisma/migrations/$C_MIGRATION" ]] \
  || { echo "old root carries C; it is not the accepted N/Q1 head" >&2; exit 4; }
OLD_COUNT="$(find "$G2_C_OLD_ROOT/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l)"
[[ "$OLD_COUNT" == "$EXPECTED_MIGRATIONS" ]] || { echo "old root has $OLD_COUNT migrations, expected $EXPECTED_MIGRATIONS" >&2; exit 4; }
# C ships exactly two files: the candidate's migration tree differs from the N/Q1 root's by
# EXACTLY $C_MIGRATION/{down.sql,migration.sql} (the same gate bootstrap step 4 repeats).
EXPECTED_C_DIFF="$(printf 'prisma/migrations/%s/down.sql\nprisma/migrations/%s/migration.sql' "$C_MIGRATION" "$C_MIGRATION")"
ACTUAL_C_DIFF="$(git -C "$ROOT" diff --name-only "$OLD_HEAD" HEAD -- prisma/migrations | LC_ALL=C sort)"
[[ "$ACTUAL_C_DIFF" == "$EXPECTED_C_DIFF" ]] \
  || { echo "candidate migrations differ from the accepted N/Q1 head by other than exactly C's two files:" >&2; echo "$ACTUAL_C_DIFF" >&2; exit 4; }
for file in scout-reconstruct.service.ts scout-roster.service.ts scout-entities.service.ts scout-ingest.service.ts scout-cursor.ts; do
  cmp -s "$G2_C_OLD_ROOT/src/scout/$file" <(git -C "$ROOT" show "$OLD_HEAD:src/scout/$file") \
    || { echo "old root src/scout/$file is not byte-identical to $OLD_HEAD" >&2; exit 4; }
done
# The old ledger model carries N's REQUIRED provenance (`String`) and BOTH narrow `@@unique`
# declarations; the C candidate removes the narrow declarations only.
grep -q 'model ScoutReconstructionLedger' "$G2_C_OLD_ROOT/prisma/schema.prisma" || { echo "old schema lacks the ledger model" >&2; exit 4; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$G2_C_OLD_ROOT/prisma/schema.prisma" | grep -Eq 'source_platform +String( |$)' \
  || { echo "old ledger model does not carry N's required source_platform" >&2; exit 4; }
awk '/model ScoutIngestEntity \{/,/\}/' "$G2_C_OLD_ROOT/prisma/schema.prisma" | grep -Fq '@@unique([coach_id, intent_id, source_id])' \
  || { echo "old staging model lacks the narrow @@unique; it is not the pre-C schema" >&2; exit 4; }
awk '/model ScoutReconstructionLedger \{/,/\}/' "$G2_C_OLD_ROOT/prisma/schema.prisma" | grep -Fq '@@unique([coach_id, intent_id, entity_type, source_id])' \
  || { echo "old ledger model lacks the narrow @@unique; it is not the pre-C schema" >&2; exit 4; }
# Dependencies are shared read-only by bootstrap through a symlink; report provenance if present.
if [[ -L "$G2_C_OLD_ROOT/node_modules" ]]; then
  echo "node_modules symlink -> $(readlink "$G2_C_OLD_ROOT/node_modules")"
elif [[ -e "$G2_C_OLD_ROOT/node_modules" ]]; then
  echo "old root has its own node_modules directory (not the shared symlink); bootstrap will not replace it" >&2; exit 4
fi
echo "old_root=$G2_C_OLD_ROOT head=$(git -C "$G2_C_OLD_ROOT" rev-parse HEAD) detached=yes migrations=$OLD_COUNT" \
  "alternates=$(cat "$(git -C "$G2_C_OLD_ROOT" rev-parse --absolute-git-dir)/objects/info/alternates" 2>/dev/null || echo none)"
echo "G2_C_OLD_ROOT_OK"
