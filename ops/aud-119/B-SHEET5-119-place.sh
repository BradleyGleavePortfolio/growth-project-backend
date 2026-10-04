#!/usr/bin/env bash
# place lens probes into worktree $1
set -e; W=$1; O=/home/user/workspace/ops
C=$W/src/components/__tests__; L=$W/src/lib/__tests__; H=$W/src/hooks/__tests__
mkdir -p $C $L $H
cp $O/aud-119/AUD-OPUS-S123-119/probes/audOpusS123119.plans344.test.tsx $C/
cp $O/aud-119/AUD-OPUS-S123-119/probes/audOpusS123119.probe343.test.tsx $C/
cp $O/aud-119/AUD-OPUS-S123-119/probes/audOpusS123119.probe342.test.ts $L/
cp $O/aud-118/AUD-OPUS-SH3-118/audOpusSH3118.yourPlans.probe.test.tsx $C/audOpusSH3118.replay.test.tsx
cp $O/aud-119/AUD-SOL-S123-119/planAuthority.test.tsx $C/audSolS123119.planAuthority.test.tsx
cp $O/aud-119/AUD-SOL-S123-119/planRecovery-replayed.test.tsx $C/audSolS123119.planRecovery.test.tsx
cp $O/aud-119/AUD-SOL-S123-119/openPlanAction-current.test.tsx $C/audSolS123119.openPlanAction.test.tsx
cp $O/aud-119/AUD-SOL-S123-119/nativeRejection-replayed.test.tsx $H/audSolS123119.nativeRejection.test.tsx
for f in $O/aud-119/B-SHEET4-119/prior-probes/*; do b=$(basename $f)
  if grep -q "'\.\./PackageSelectionSheet'\|'\.\./purchase/" $f; then cp $f $C/; elif grep -q "'\.\./usePackagePurchase'" $f; then cp $f $H/; else cp $f $L/; fi; done
