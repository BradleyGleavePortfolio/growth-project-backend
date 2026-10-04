#!/usr/bin/env bash
# Land the fees stack as one (MERGE_DEPENDENCY_GUIDE rule 11), agent 119.
# Step A (after dual APPROVE on #684/#697/#685/#686 at the heads below): fast-forward piece branches top-down to the
# fees top, then put the audited landing candidate on #681's branch. Step B (after both lenses APPROVE #681 at the
# candidate and all required checks are green): merge #681 with --match-head-commit.
set -euo pipefail
R=BradleyGleavePortfolio/growth-project-backend
TOP=30a118ddfd75339375ea4f6f6288669f3cbebfd5
CAND=0bc3696d2bd1a25a4e963776db6f7f531881e4eb
declare -A HEAD=([681]=e9650dc4 [682]=70f879a2 [683]=cc183e0a [684]=9fb9c48f [697]=c2585c97 [685]=a61d50f4 [686]=30a118dd)
step=${1:-}
cd /home/user/workspace/repos/growth-project-backend
git fetch -q origin
for n in 681 682 683 684 697 685 686; do
  h=$(gh pr view $n -R $R --json headRefOid --jq .headRefOid)
  if [ "$step" = A ] && [ "${h:0:8}" != "${HEAD[$n]}" ]; then echo "MOVED #$n $h"; exit 1; fi
done
if [ "$step" = A ]; then
  # top-down: each base branch fast-forwards to TOP (no force: plain push of a descendant)
  for b in agent115/fee-split-5-money-protocol-specs agent117/fee-split-4b-tests agent115/fee-split-4-checkout-wiring \
           agent115/fee-split-3-charge-settlement agent115/fee-split-2-transfer-orchestrator; do
    git merge-base --is-ancestor origin/$b $TOP || { echo "not ff: $b"; exit 1; }
    git push -q origin $TOP:refs/heads/$b && echo "ff $b -> ${TOP:0:8}"
  done
  git merge-base --is-ancestor origin/agent115/fee-split-1-ledger-foundation $CAND || { echo "cand not ff"; exit 1; }
  test "$(git rev-parse $CAND^{tree})" = 317ea5ca8fb132892f02cf9d81ef9511a81c882d || { echo "tree mismatch"; exit 1; }
  git push -q origin $CAND:refs/heads/agent115/fee-split-1-ledger-foundation && echo "#681 head -> ${CAND:0:8}"
fi
if [ "$step" = B ]; then
  h=$(gh pr view 681 -R $R --json headRefOid --jq .headRefOid); test "$h" = "$CAND" || { echo "681 head $h"; exit 1; }
  gh pr ready 681 -R $R 2>/dev/null || true
  gh pr merge 681 -R $R --merge --match-head-commit $CAND
  git fetch -q origin; echo "main now $(git rev-parse origin/main)"
fi
