#!/usr/bin/env bash
# B-SHEET6-119: place every prior lens probe (B-SHEET5 set + both S3D delta probes) into worktree $1
set -e; W=$1; O=/home/user/workspace/ops; C=$W/src/components/__tests__
bash $O/aud-119/B-SHEET5-119-place.sh $W
cp $O/aud-119/AUD-SOL-S3D-119/delta-probes.test.tsx $C/audSolS3D119.deltaProbes.test.tsx
cp $O/aud-119/AUD-OPUS-S3D-119/probes/audOpusS3D119.delta344.test.tsx $C/
