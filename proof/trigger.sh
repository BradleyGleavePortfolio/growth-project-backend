#!/usr/bin/env bash
# GH-LANES trigger: create a run commit whose ONLY parent is exactly the reviewed harness commit and whose tree differs
# from it only by PROOF_TARGET (line 1 = target, HARNESS_SHA=<that commit>, then your KEY=VALUE lines), and push it to
# proof/run/<label>. The aggregate re-verifies parent == HARNESS_SHA and diff == PROOF_TARGET; consumers must still check
# the summary's harness_sha against the reviewed SHA out of band.
# Usage (from a clean backend clone):
#   [HARNESS_SHA=<40hex>] [PROOF_REMOTE=origin] proof/trigger.sh <label> <40-hex target sha> [KEY=VALUE ...]
#   KEYs: EXPECT_TOTAL_s11=N EXPECT_TOTAL_s10b=N EXPECT_<stage>=N PKG_LOCK_SHA256=<64hex>; diagnostic subset: STAGES=a,b PARTIAL=1
# The label must be new (a run branch is never reused or force-pushed). Prints the run commit.
set -euo pipefail
DEFAULT_HARNESS_SHA=""   # set by the launcher commit that follows each reviewed harness commit
[ $# -ge 2 ] || { sed -n 2,10p "$0"; exit 64; }
LABEL=$1; SHA=$2; shift 2; REMOTE=${PROOF_REMOTE:-origin}; H=${HARNESS_SHA:-$DEFAULT_HARNESS_SHA}
[[ "$H" =~ ^[0-9a-f]{40}$ ]] || { echo "HARNESS_SHA (40-hex) required" >&2; exit 64; }
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || { echo "bad label" >&2; exit 64; }
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || echo "warning: '$SHA' is not 40-hex; preflight will refuse it (negative control?)" >&2
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "working tree not clean" >&2; exit 64; }
for kv in "$@"; do case "$kv" in HARNESS_SHA=*) echo "HARNESS_SHA is set by the launcher, not as a KEY" >&2; exit 64;; esac; done
BR=proof/run/$LABEL
git fetch -q "$REMOTE" +refs/heads/proof/harness:refs/remotes/$REMOTE/proof/harness
[ "$(git cat-file -t "$H" 2>/dev/null)" = commit ] && git merge-base --is-ancestor "$H" "$REMOTE/proof/harness" \
  || { echo "HARNESS_SHA $H is not a commit on $REMOTE/proof/harness" >&2; exit 70; }
git ls-remote --exit-code "$REMOTE" "refs/heads/$BR" >/dev/null 2>&1 && { echo "$BR already exists on $REMOTE; use a new label" >&2; exit 76; }
PREV=$(git rev-parse --abbrev-ref HEAD)
git checkout -q -B "$BR" "$H"
[ ! -e PROOF_TARGET ] || { git checkout -q "$PREV"; echo "harness tree already has PROOF_TARGET" >&2; exit 70; }
{ echo "$SHA"; echo "HARNESS_SHA=$H"; for kv in "$@"; do echo "$kv"; done; } >PROOF_TARGET
git add PROOF_TARGET
git commit -q -m "proof run $LABEL: $SHA (harness $H)"
[ "$(git rev-parse HEAD^)" = "$H" ] && [ "$(git diff --name-only HEAD^ HEAD)" = PROOF_TARGET ] || { echo "run commit binding check failed" >&2; exit 70; }
git push -q "$REMOTE" "HEAD:refs/heads/$BR"
RUN=$(git rev-parse HEAD); git checkout -q "$PREV"
echo "RUN_COMMIT=$RUN BRANCH=$BR HARNESS_SHA=$H"
echo "watch: gh run list --repo BradleyGleavePortfolio/growth-project-backend --branch $BR"
