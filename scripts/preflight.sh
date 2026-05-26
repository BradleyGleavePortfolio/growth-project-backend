#!/usr/bin/env bash
# R50 — pre-push preflight grep gate for the backend repo.
#
# Audit #5 P0-X follow-up: a centralised grep harness that runs the same
# forbidden-pattern checks the audits make manually, so a fix author can
# self-verify before forcing a push. Exit non-zero on any match.
#
# Run from repo root: ./scripts/preflight.sh
#
# Excluded paths are listed once at the top so adding a new exclusion
# touches one place. node_modules / dist / .git are skipped everywhere.

set -u
set -o pipefail

EXIT=0

EXCLUDES=(
    --exclude-dir=.git
    --exclude-dir=node_modules
    --exclude-dir=dist
    --exclude-dir=coverage
)

# Files whose entire purpose is to enumerate the forbidden tokens. The
# checker itself, the house-rules doc that lists banned words, and the
# audit/findings markdown shouldn't trigger false positives.
SELF_REFERENTIAL_EXCLUDES=(
    --exclude=preflight.sh
    --exclude=HOUSE_RULES.md
    --exclude=BACKLOG.md
    --exclude=PRE_EXISTING_TEST_FAILURES.md
)

# Helper: run grep and report. $1=label, $2=pattern, $3..N=additional grep flags.
check() {
    local label="$1"
    local pattern="$2"
    shift 2
    # shellcheck disable=SC2207
    local matches
    matches=$(grep -rnE "${EXCLUDES[@]}" "$@" "$pattern" . 2>/dev/null || true)
    if [ -n "$matches" ]; then
        echo "FAIL [$label] — forbidden pattern found:"
        echo "$matches" | head -40
        echo "----"
        EXIT=1
    else
        echo "PASS [$label]"
    fi
}

# 1) R45 — banned hostname assembled from parts so this very script does
# not trip the check. Literal "tgp" + "." + "app".
banned_host="tgp"
banned_host="${banned_host}.app"
check "R45 banned hostname" "$banned_host"

# 2) Raw `new Error(` in PR-locked surfaces. R44 bans raw new Error in
# the customer-money-handling paths specifically (storefront +
# share-link). Repo-wide enforcement is tracked separately (~200
# pre-existing call sites); this preflight catches regressions in the
# locked scope only.
matches=$(grep -rnE "${EXCLUDES[@]}" \
    "new Error\\(" src/storefront src/share-link 2>/dev/null || true)
if [ -n "$matches" ]; then
    # Filter doc-comment matches (lines whose code portion begins with
    # `*` or `//` — these are comments referencing the historical
    # pattern, which the audit explicitly allows).
    real=$(echo "$matches" | awk -F: '{
        line=$0
        # Drop the file:lineno: prefix to inspect the code portion.
        sub(/^[^:]+:[0-9]+:/, "", line)
        # Skip pure-comment lines.
        if (line ~ /^[[:space:]]*\*/) next
        if (line ~ /^[[:space:]]*\/\//) next
        print
    }')
    if [ -n "$real" ]; then
        echo "FAIL [raw new Error in storefront/share-link] — typed domain error required:"
        echo "$real" | head -20
        echo "----"
        EXIT=1
    else
        echo "PASS [raw new Error in storefront/share-link] (only documentation comments)"
    fi
else
    echo "PASS [raw new Error in storefront/share-link]"
fi

# 3) toISOString().split( — banned date pattern in PR-locked surfaces.
# ~50 pre-existing call sites in src/coach, src/habits, src/log,
# src/prep-guide, src/water — tracked separately for repo-wide cleanup.
# Preflight catches regressions in the locked storefront/share-link
# scope only.
matches=$(grep -rnE "${EXCLUDES[@]}" \
    "toISOString\\(\\)\\.split\\(" src/storefront src/share-link 2>/dev/null || true)
if [ -n "$matches" ]; then
    echo "FAIL [toISOString().split in storefront/share-link]:"
    echo "$matches" | head -20
    echo "----"
    EXIT=1
else
    echo "PASS [toISOString().split in storefront/share-link]"
fi

# 4) Co-Authored-By in commit history main..HEAD.
if git rev-parse --verify main >/dev/null 2>&1; then
    coauth=$(git log main..HEAD --format="%B" 2>/dev/null | grep -iE "co-authored-by" || true)
    if [ -n "$coauth" ]; then
        echo "FAIL [Co-Authored-By trailers] — PR commits contain Co-Authored-By"
        echo "$coauth" | head -10
        echo "----"
        EXIT=1
    else
        echo "PASS [Co-Authored-By trailers]"
    fi
else
    echo "SKIP [Co-Authored-By trailers] — no main ref locally"
fi

# 5) subscription_status outside coach_subscriptions paths. The locked
# rule is the table is named coach_subscriptions; subscription_status as
# a field name is the deprecated shape. Allow the field to appear in
# migration files that explicitly DROP it.
matches=$(grep -rnE "${EXCLUDES[@]}" "subscription_status" src 2>/dev/null \
    | grep -v "coach_subscriptions" || true)
if [ -n "$matches" ]; then
    echo "WARN [subscription_status outside coach_subscriptions]:"
    echo "$matches" | head -40
    echo "(deprecated field still referenced — see docs/BACKLOG.md BL-2026-05-25-006)"
    echo "----"
    # NON-fatal — tracked by BL-2026-05-25-006. The audit accepted the
    # residue under that charter; do not fail preflight on it.
else
    echo "PASS [subscription_status]"
fi

# 6) Forbidden marketing/finance lexicon in source. Restrict to .ts /
# .tsx / .js source files — markdown docs may legitimately discuss the
# rules themselves. Per docs/HOUSE_RULES.md the `Income` token is
# explicitly carved out for diagnostic domain terms ("Income
# Architecture", "debt_to_income") so the preflight grep does not
# enforce it; that one stays a code-review check. `finance` is also
# carved out as a load-bearing product term and is not in this list.
for token in 'netWorth' 'confetti' 'trophy' 'revolutionary' 'gamechang'; do
    matches=$(grep -rnE "${EXCLUDES[@]}" "${SELF_REFERENTIAL_EXCLUDES[@]}" \
        --include="*.ts" --include="*.tsx" --include="*.js" \
        -i "\\b${token}\\b" src 2>/dev/null || true)
    if [ -n "$matches" ]; then
        echo "FAIL [forbidden token '$token'] in src/:"
        echo "$matches" | head -20
        echo "----"
        EXIT=1
    else
        echo "PASS [forbidden token '$token']"
    fi
done

# 7) console.log outside scripts/ and test/. Production code should use
# Nest Logger.
matches=$(grep -rnE "${EXCLUDES[@]}" --exclude-dir=scripts --exclude-dir=test --exclude-dir=__tests__ \
    "console\\.log\\(" src 2>/dev/null || true)
if [ -n "$matches" ]; then
    echo "FAIL [console.log in src/] — use Nest Logger instead:"
    echo "$matches" | head -40
    echo "----"
    EXIT=1
else
    echo "PASS [console.log in src/]"
fi

echo
if [ "$EXIT" -eq 0 ]; then
    echo "preflight: all checks passed"
else
    echo "preflight: one or more checks failed — fix before push"
fi
exit "$EXIT"
