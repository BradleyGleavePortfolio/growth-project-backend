#!/usr/bin/env bash
# GH-LANES trigger: create a run commit (harness tree + PROOF_TARGET) on proof/run/<label> and push it.
# Usage (from a clone of the backend that has the proof/harness branch fetched, with a clean tree):
#   proof/trigger.sh <label> <40-hex target sha> [KEY=VALUE ...]      push remote: $PROOF_REMOTE (default origin)
#   KEYs: STAGES=a,b  PKG_LOCK_SHA256=<64hex>  EXPECT_TOTAL_s11=127  EXPECT_TOTAL_s10b=41  EXPECT_<stage>=<n>
# The label must be new (a run branch is never reused or force-pushed). Prints the run commit.
set -euo pipefail
[ $# -ge 2 ] || { sed -n 2,6p "$0"; exit 64; }
LABEL=$1; SHA=$2; shift 2; REMOTE=${PROOF_REMOTE:-origin}
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || { echo "bad label" >&2; exit 64; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || echo "warning: '$SHA' is not 40-hex; preflight will refuse it (negative control?)" >&2
BR=proof/run/$LABEL
git fetch -q "$REMOTE" +refs/heads/proof/harness:refs/remotes/$REMOTE/proof/harness
git ls-remote --exit-code "$REMOTE" "refs/heads/$BR" >/dev/null 2>&1 && { echo "$BR already exists on $REMOTE; use a new label" >&2; exit 76; }
PREV=$(git rev-parse --abbrev-ref HEAD)
git checkout -q -B "$BR" "$REMOTE/proof/harness"
{ echo "$SHA"; for kv in "$@"; do echo "$kv"; done; } >PROOF_TARGET
git add PROOF_TARGET
git commit -q -m "proof run $LABEL: $SHA"
git push -q "$REMOTE" "HEAD:refs/heads/$BR"
RUN=$(git rev-parse HEAD); git checkout -q "$PREV"
echo "RUN_COMMIT=$RUN BRANCH=$BR"
echo "watch: gh run list --repo BradleyGleavePortfolio/growth-project-backend --branch $BR"
