#!/usr/bin/env bash
#
# scripts/preflight.sh — R50 preflight grep gate.
#
# Runs every gate the canonical project rules expose as grep-checkable
# AND exits non-zero on any REGRESSION introduced since origin/main.
# Pre-existing violations on origin/main are tracked via
# docs/BACKLOG.md (or the equivalent audit-cycle deferrals); preflight
# is the regression gate, not the cleanup gate.
#
# Gates encoded here:
#   1. R45 — the literal "tgp.app" is banned anywhere in source. This
#      gate is ABSOLUTE (not diff-only): the project has zero tolerance
#      for the banned hostname on any branch.
#   2. R44 — raw `new Error(` is banned in src/. DIFF-ONLY against
#      origin/main so historical patterns do not block routine work.
#   3. R44 — `toISOString().split/.slice` is banned in src/ for date
#      bucketing. DIFF-ONLY.
#   4. House rule — commits in this PR must NOT carry a
#      `Co-Authored-By:` trailer for the AI author. ABSOLUTE.
#   5. P3-2 — net-new `subscription_status` references in src/.
#      DIFF-ONLY.
#   6. Forbidden tokens (audit-cycle locks): "Income" as a bare word
#      (with the docs/HOUSE_RULES carve-out for `debt_to_income` and
#      the legitimate `Income Architecture` diagnostic feature),
#      netWorth, confetti, trophy, revolutionary, gamechang.
#      DIFF-ONLY so the diagnostic feature's longstanding "Income
#      Architecture" usage does not block routine work; net-new
#      occurrences are caught.
#   7. `console.log(` outside scripts/ and test/. DIFF-ONLY.
#
# Diff-only gates compare new (+) lines in `git diff origin/main...HEAD`
# against the forbidden pattern. Removed lines and unchanged lines are
# ignored so a contributor cleaning up an unrelated file is not blamed
# for a pre-existing violation they happened to touch.
#
# Usage:
#   ./scripts/preflight.sh         # run all gates
#   ./scripts/preflight.sh -v      # verbose: list every check
#
# Exits 0 on a clean tree, non-zero on the first regression.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
fail() {
  FAIL=$((FAIL + 1))
  printf '\033[31mFAIL\033[0m  %s\n' "$*" >&2
}
ok() {
  printf '\033[32m ok \033[0m  %s\n' "$*"
}

# Resolve base ref. Prefer origin/main, fall back to local main.
base_ref="origin/main"
git rev-parse "$base_ref" >/dev/null 2>&1 || base_ref="main"

# Helper: emit added lines from the diff scoped to src/, excluding
# test/, dist/, and node_modules/. Comment lines (`//`, ` *`, `/*`)
# are filtered out so documentation about what NOT to do — including
# inline rule-text and audit-finding back-references — does not trip
# the lexical gates. The grep matches the typescript / javascript
# comment forms after a leading '+'.
diff_added_src() {
  # `git diff base...HEAD` is the symmetric-difference form: it shows
  # only commits on HEAD that are not on base, ignoring main commits
  # merged into HEAD. Filter to (a) src/ files, (b) lines starting
  # with '+' that are NOT the '+++' file marker, and (c) non-comment
  # added lines.
  git diff "$base_ref...HEAD" -- 'src/**/*.ts' 'src/**/*.tsx' 2>/dev/null \
    | grep -E "^\+[^+]" \
    | grep -vE "^\+\s*(//|/\*|\*\s|\*$|\*/)" || true
}

# 1. R45 absolute — banned hostname literal.
banned_part1="tgp"
banned_part2=".app"
banned_literal="${banned_part1}${banned_part2}"
if grep -rn \
     --exclude-dir=.git \
     --exclude-dir=node_modules \
     --exclude-dir=dist \
     --exclude-dir=coverage \
     --exclude="preflight.sh" \
     "$banned_literal" .; then
  fail "R45: banned hostname found above (absolute gate)"
else
  ok "R45: no banned hostname in source (absolute)"
fi

# 2. R44 diff-only — raw new Error( in src/ (not test/).
added_new_error=$(diff_added_src | grep -E "new Error\(" || true)
if [ -n "$added_new_error" ]; then
  printf '%s\n' "$added_new_error" >&2
  fail "R44: raw new Error(...) introduced in src/ — use a typed domain error"
else
  ok "R44: no new raw new Error( in src/ since $base_ref"
fi

# 3. R44 diff-only — toISOString().split/.slice in src/.
added_iso=$(diff_added_src | grep -E "toISOString\(\)\.(split|slice)\(" || true)
if [ -n "$added_iso" ]; then
  printf '%s\n' "$added_iso" >&2
  fail "R44: toISOString().split/.slice introduced in src/ — use bucketDateLocal()"
else
  ok "R44: no new toISOString().split/.slice in src/ since $base_ref"
fi

# 4. House rule absolute — no Co-Authored-By trailer in this PR's commits.
coauth_hits=$(git log "$base_ref..HEAD" --format="%B" 2>/dev/null \
  | grep -iE "^Co-Authored-By:" || true)
if [ -n "$coauth_hits" ]; then
  printf '%s\n' "$coauth_hits" >&2
  fail "House rule: Co-Authored-By trailer present in PR commits (absolute)"
else
  ok "House rule: no Co-Authored-By trailers in PR commits"
fi

# 5. subscription_status diff-only.
added_subscription_status=$(diff_added_src \
  | grep -E "\bsubscription_status\b" || true)
if [ -n "$added_subscription_status" ]; then
  printf '%s\n' "$added_subscription_status" >&2
  fail "Forbidden field: net-new subscription_status reference in src/"
else
  ok "No net-new subscription_status references in src/ since $base_ref"
fi

# 6. Forbidden tokens diff-only across src/ + docs/. The DOCS_HOUSE_RULES
# self-reference is excluded so the rule definition itself does not trip
# the rule.
added_forbidden=$(git diff "$base_ref...HEAD" \
    -- 'src/**' 'docs/**' \
    ':(exclude)docs/HOUSE_RULES.md' \
    2>/dev/null \
  | grep -E "^\+[^+]" \
  | grep -E '\b(Income|netWorth|confetti|trophy|revolutionary|gamechang)' || true)
if [ -n "$added_forbidden" ]; then
  printf '%s\n' "$added_forbidden" >&2
  fail "Forbidden token introduced in src/ or docs/"
else
  ok "No net-new forbidden marketing/legacy tokens since $base_ref"
fi

# 7. console.log diff-only in src/.
added_console=$(diff_added_src | grep -E "console\.log\(" || true)
if [ -n "$added_console" ]; then
  printf '%s\n' "$added_console" >&2
  fail "console.log( introduced in src/ — use NestJS Logger"
else
  ok "No net-new console.log( in src/ since $base_ref"
fi

# Summary.
if [ "$FAIL" -gt 0 ]; then
  printf '\n\033[31mpreflight: %d gate(s) failed\033[0m\n' "$FAIL" >&2
  exit 1
fi
printf '\n\033[32mpreflight: all gates clean\033[0m\n'
exit 0
