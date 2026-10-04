#!/usr/bin/env bash
# Link shared deps into a worktree (agent 109). Usage: link_deps.sh <backend|mobile> <worktree>
# mobile: node_modules symlink. backend: private node_modules dir of symlinks + private @prisma/client copy,
# so `heavy.sh npx prisma generate` writes a worktree-private .prisma client.
set -euo pipefail
kind=$1; wt=$2; src=/home/user/workspace/deps/$kind/node_modules
[ -f /home/user/workspace/deps/$kind/READY ] || { echo "deps/$kind not READY yet; read code first and retry later"; exit 1; }
if [ "$kind" = mobile ]; then ln -sfn "$src" "$wt/node_modules"; echo linked; exit 0; fi
mkdir -p "$wt/node_modules/@prisma"
for e in "$src"/* "$src"/.bin; do n=$(basename "$e"); [ "$n" = "@prisma" ] && continue; ln -sfn "$e" "$wt/node_modules/$n"; done
for e in "$src"/@prisma/*; do n=$(basename "$e"); if [ "$n" = client ]; then rm -rf "$wt/node_modules/@prisma/client"; cp -r "$e" "$wt/node_modules/@prisma/client"; else ln -sfn "$e" "$wt/node_modules/@prisma/$n"; fi; done
echo "linked; now run: /home/user/workspace/ops/heavy.sh npx prisma generate (inside $wt)"
