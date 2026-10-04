#!/usr/bin/env bash
# Shared deps install (agent 109). Serialized through heavy.sh; scripts ignored (prisma generate runs per worktree).
set -uo pipefail
cd /home/user/workspace/deps/backend && /home/user/workspace/ops/heavy.sh npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && touch READY && echo backend-ok
cd /home/user/workspace/deps/mobile && /home/user/workspace/ops/heavy.sh npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --legacy-peer-deps && touch READY && echo mobile-ok
df -h / | tail -1
