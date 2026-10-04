#!/usr/bin/env bash
# Operator 116 pause snapshot. Re-runnable. Needs bash api_credentials=["github"].
# For every worktree under /home/user/workspace/wt: record repo, branch, HEAD, dirty/untracked files, commits not on any remote.
# If anything is not on GitHub (unpushed commits, uncommitted or untracked files), build a snapshot commit with a temporary
# index (worktree and real index untouched), parent = HEAD, and push it to wip/op116/<worktree> in that product repo
# (private; no workflow triggers on wip/* pushes). Writes ops/pause116/WORKTREES.md.
set -u
W=/home/user/workspace
OUT=$W/ops/pause116
mkdir -p "$OUT"
T=$(TZ=America/Los_Angeles date "+%Y-%m-%d %H:%M")
{
echo "# Worktree snapshot (operator 116) — $T PDT"
echo
echo "Every worktree's state at pause. 'saved to' = branch in the product repo holding everything not otherwise on GitHub"
echo "(unpushed commits plus uncommitted/untracked files as one snapshot commit on top of HEAD)."
echo
echo "| worktree | repo | branch | HEAD | changed files | unpushed commits | saved to |"
echo "|---|---|---|---|---|---|---|"
} > "$OUT/WORKTREES.md"
for d in "$W"/wt/*/; do
  d=${d%/}; name=$(basename "$d")
  [ -e "$d/.git" ] || continue
  cd "$d" || continue
  url=$(git remote get-url origin 2>/dev/null)
  repo=$(basename -s .git "$url")
  br=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  head=$(git rev-parse HEAD 2>/dev/null)
  changed=$(git status --porcelain 2>/dev/null | grep -v -E ' node_modules/?$|^\?\? node_modules' | wc -l)
  git fetch -q origin 2>/dev/null
  unp=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo "?")
  saved="-"
  if [ "$unp" != "0" ] || [ "$changed" != "0" ]; then
    commit=$head
    if [ "$changed" != "0" ]; then
      tmpidx=$(mktemp); cp "$(git rev-parse --git-path index)" "$tmpidx" 2>/dev/null
      GIT_INDEX_FILE=$tmpidx git add -A -- . ':(exclude)node_modules' 2>/dev/null
      tree=$(GIT_INDEX_FILE=$tmpidx git write-tree)
      commit=$(git -c user.name="TGP Agent 116" -c user.email="agent@tgp.invalid" commit-tree "$tree" -p "$head" -m "WIP pause snapshot ($name, operator 116, $T PDT): uncommitted and untracked files")
      rm -f "$tmpidx"
    fi
    wb="wip/op116/$name"
    if git push -q -f origin "$commit:refs/heads/$wb" 2>/dev/null; then saved="$wb @ ${commit:0:12}"; else saved="PUSH FAILED"; fi
  fi
  echo "| $name | $repo | $br | ${head:0:12} | $changed | $unp | $saved |" >> "$OUT/WORKTREES.md"
done
cat "$OUT/WORKTREES.md"
