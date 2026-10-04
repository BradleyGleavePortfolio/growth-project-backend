#!/usr/bin/env bash
# rebuild_sandbox.sh (agent 118 for agent 119). Run from Computer bash with api_credentials=["github"]. Idempotent.
# Clones the three repos (full blobs), restores ops/ from the newest snapshot, installs shared deps in the background.
set -uo pipefail
W=/home/user/workspace; O=BradleyGleavePortfolio
mkdir -p $W/repos && cd $W/repos
for r in growth-project-backend growth-project-mobile tgp-agent-context; do
  [ -d $r/.git ] || gh repo clone $O/$r $r -- -q
  git -C $r fetch -q origin
done
git -C growth-project-backend fetch -q origin 'refs/heads/wip/*:refs/remotes/origin/wip/*'
if [ ! -d $W/ops/op118 ]; then
  for s in op119 op118 op117; do
    if git -C growth-project-backend rev-parse -q --verify origin/wip/$s/ops-snapshot >/dev/null; then
      git -C growth-project-backend archive origin/wip/$s/ops-snapshot ops | tar -x -C $W && echo "ops restored from wip/$s/ops-snapshot"; break
    fi
  done
fi
cp -n $W/repos/tgp-agent-context/handoffs/op-116/tools/* $W/ops/ 2>/dev/null || true
mkdir -p $W/ops/op118 $W/ops/lanes118/{claims,locks,notify}
cp -n $W/repos/tgp-agent-context/handoffs/op-118/tools/* $W/ops/op118/ 2>/dev/null || true
cp -n $W/repos/tgp-agent-context/handoffs/op-118/{JOBS118.md,_COMMON_118.md} $W/ops/lanes118/ 2>/dev/null || true
for k in backend mobile; do
  mkdir -p $W/deps/$k && cp $W/repos/growth-project-$k/package.json $W/repos/growth-project-$k/package-lock.json $W/deps/$k/
done
if [ ! -f $W/deps/backend/READY ] || [ ! -f $W/deps/mobile/READY ]; then
  setsid nohup bash $W/ops/install_deps.sh > $W/ops/install_deps.log 2>&1 < /dev/null & disown
  echo "deps install started (ops/install_deps.log; READY files appear when done)"
fi
df -h / | tail -1; nproc; free -g | awk 'NR==2{print "RAM GB: "$2}'
