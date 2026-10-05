#!/usr/bin/env bash
# B-WIZ3-122: one mobile CI lane at the new #351 head: typecheck + every wizard/money spec in #345-#351 + prior lens probes (unchanged copies).
set -euo pipefail
wt=/home/user/workspace/wt/B-WIZ3-122-351lane; head=$1; suf=$2
[ -d $wt ] || git -C /home/user/workspace/growth-project-mobile worktree add -q --detach $wt $head
cd $wt; git checkout -q --detach $head
C=src/components/coach/setup/__tests__
cp /home/user/workspace/ops/aud-120/AUD-OPUS-W12D-120/audOpusW12D_120_346.test.tsx $C/audOpusW12D_120_346.test.tsx
cp /home/user/workspace/ops/aud-119/AUD-SOL-W12-119/346-lifecycle-hydration.test.tsx $C/audit119Lifecycle.test.tsx
cp /home/user/workspace/ops/aud-119/AUD-OPUS-W12-119/audOpusW12_119_346.test.tsx $C/audOpusW12_119_346.test.tsx
: > .ci-lane-tsc
git add -f $C/audOpusW12D_120_346.test.tsx $C/audit119Lifecycle.test.tsx $C/audOpusW12_119_346.test.tsx .ci-lane-tsc
git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit -qm "ci: lens probes + tsc marker (never merge)" --no-verify
MB=$(git merge-base origin/main ed29833cb2d5c597f0be3a557877bd3cf29d85a3)
specs=$(git diff --name-only $MB HEAD | grep -E '(__tests__/|\.test\.)' | grep -E '\.(test)\.(ts|tsx|js)$' | sort -u)
echo "$specs" > /home/user/workspace/ops/aud-122/B-WIZ3-122/lane-specs-$suf.txt
/home/user/workspace/ops/ci-lane/ci_lane.sh mobile "$wt" "ci/B-WIZ3-122-351-$suf" $specs
git reset -q --hard $head
