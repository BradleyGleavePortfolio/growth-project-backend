#!/usr/bin/env bash
# wiz2_lane.sh <pr 345|346|347> <branch-suffix> : adds lens probe files in a throwaway commit, runs ci lane, removes the commit.
set -euo pipefail
pr=$1; suf=$2
wt=/home/user/workspace/wt/B-WIZ2-119-$pr
A=/home/user/workspace/ops/aud-119
cd "$wt"
test -z "$(git status --porcelain --untracked-files=no)" || { echo "dirty tree"; exit 3; }
L=src/lib/coachSetup/__tests__; C=src/components/coach/setup/__tests__
cp $A/AUD-SOL-W12-119/345-retired-writer.test.ts $L/audit119RetiredWriter.test.ts
cp $A/AUD-SOL-W12-119/345-contract-replay.test.ts $L/audit119Replay.test.ts
cp $A/AUD-OPUS-W12-119/audOpusW12_119_345.test.ts $L/audOpusW12_119_345.test.ts
specs="$L/w1FixRound119.test.ts $L/w1FixRound118.test.ts $L/audit119RetiredWriter.test.ts $L/audit119Replay.test.ts $L/audOpusW12_119_345.test.ts $C/connectCopyStates.test.ts"
files="$L/audit119RetiredWriter.test.ts $L/audit119Replay.test.ts $L/audOpusW12_119_345.test.ts"
if [ "$pr" != 345 ]; then
  cp $A/AUD-SOL-W12-119/346-lifecycle-hydration.test.tsx $C/audit119Lifecycle.test.tsx
  cp $A/AUD-OPUS-W12-119/audOpusW12_119_346.test.tsx $C/audOpusW12_119_346.test.tsx
  files="$files $C/audit119Lifecycle.test.tsx $C/audOpusW12_119_346.test.tsx"
  specs="$specs $C/audit119Lifecycle.test.tsx $C/audOpusW12_119_346.test.tsx $C/packageCreateDurability.test.tsx $C/packageCreateIdempotency.test.tsx $C/w2FixRound118.test.tsx"
  [ -f $C/w2FixRound119.test.tsx ] && specs="$specs $C/w2FixRound119.test.tsx"
fi
if [ "$pr" = 347 ]; then
  specs="$specs ${EXTRA347:-}"
fi
git add -f $files
git -c user.name="Bradley Gleave" -c user.email="bradley@bradleytgpcoaching.com" commit -qm "ci: lens probes (never merge)" --no-verify
/home/user/workspace/ops/ci-lane/ci_lane.sh mobile "$wt" "ci/B-WIZ2-119-$pr-$suf" $specs
git reset -q --hard HEAD~1
git status --short
