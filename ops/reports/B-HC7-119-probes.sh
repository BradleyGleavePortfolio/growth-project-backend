#!/usr/bin/env bash
# copy both lenses' probes into worktree $1 (lane only; never pushed to a PR branch)
set -e
W=$1; A=/home/user/workspace/ops
cp $A/aud-119/AUD-SOL-H46D-119/disconnectRetry.sol119.test.ts $W/src/api/__tests__/
cp $A/aud-119/AUD-OPUS-H46-119/probes/useWearableConnections.opus119.test.tsx $A/aud-119/AUD-OPUS-H46D-119/probes/useWearableConnections.opus119d.test.tsx $A/aud-118/AUD-SOL-H45-118/useWearableConnections.sol118.test.tsx $A/aud-119/AUD-SOL-H46-119/useWearableConnections.sol119.test.tsx $A/aud-119/AUD-SOL-H46-119/useWearableConnections.transportSol119.test.tsx $W/src/hooks/
S=$W/src/screens/client/wearables/__tests__
cp $A/aud-118/AUD-OPUS-H45-118/probes/ConnectionsScreen.emptyImport.probe.test.tsx $A/aud-118/AUD-OPUS-H6-118/ConnectionsScreen.samsungRow.opus118.test.tsx $A/aud-118/AUD-SOL-H45-118/ConnectionsScreen.sol118.test.tsx $A/aud-118/AUD-OPUS-H45-118/probes/WearablesShell.settingsReturn.probe.test.tsx $A/aud-118/AUD-SOL-H6-118/audit364.samsungRetirement.test.tsx $S/
cp $A/aud-119/AUD-SOL-H46-119/audit364.samsungRetirement.adapted.test.tsx $S/audit364.samsungRetirement.hc4.test.tsx
cp $A/aud-119/AUD-OPUS-H46-119/probes/hcPrivacyTemplate.opus119.test.ts $A/aud-118/AUD-OPUS-H6-118/healthConnectRationale.opus118.test.ts $A/aud-119/AUD-OPUS-H46E-119/probes/onDeviceState.opus119e.test.ts $W/src/services/health/__tests__/
