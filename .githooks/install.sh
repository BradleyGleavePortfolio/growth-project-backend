#!/usr/bin/env bash
# Install repo-local git hooks. Run once after cloning.
set -euo pipefail
cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit-stale-warn
# Wire pre-commit-stale-warn as the actual pre-commit hook.
cp .githooks/pre-commit-stale-warn .githooks/pre-commit
chmod +x .githooks/pre-commit

echo "✅ Hooks installed. core.hooksPath = .githooks"
echo "   Active hook: pre-commit (warns on stale uncommitted files, R15)."
