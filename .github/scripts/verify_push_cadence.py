#!/usr/bin/env python3
"""
verify_push_cadence.py — R15 enforcement (push cadence).

Hard rule: agents push every 2 minutes of active work. CI can't see 2-min
granularity, but it CAN see "this commit existed for >24h before being
pushed." That's the catastrophic failure mode this script catches —
sandbox-only work that almost got stranded.

For each commit in the PR's branch (not already on main), compare:
    - committer date (when the commit was made)
    - push date (when GitHub first saw it, via the GraphQL `pushedDate`
      or the workflow's run trigger time as a fallback)

If any commit was made >24h before being pushed, fail.

We intentionally do NOT use authorDate, which agents can rewrite.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta

THRESHOLD = timedelta(hours=24)


def run(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, text=True).strip()


def commits_in_branch() -> list[str]:
    # Commits that are on this branch but not on origin/main.
    try:
        run(["git", "fetch", "origin", "main", "--depth", "200"])
    except subprocess.CalledProcessError:
        # Shallow / detached cases — fall back to last 50 commits.
        pass
    try:
        out = run([
            "git", "log",
            "origin/main..HEAD",
            "--pretty=format:%H",
        ])
    except subprocess.CalledProcessError:
        out = run([
            "git", "log",
            "-n", "50",
            "--pretty=format:%H",
        ])
    return [sha for sha in out.splitlines() if sha]


def committer_date(sha: str) -> datetime:
    iso = run(["git", "show", "-s", "--format=%cI", sha])
    return datetime.fromisoformat(iso)


def pushed_date_via_gh(sha: str) -> datetime | None:
    """Query GitHub for when this commit was first pushed to the repo."""
    try:
        out = subprocess.check_output(
            [
                "gh", "api",
                f"/repos/{os.environ.get('GITHUB_REPOSITORY', '')}"
                f"/commits/{sha}",
            ],
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    data = json.loads(out)
    # GitHub doesn't expose pushedDate on this endpoint, but the commit's
    # `commit.committer.date` is what's in the object. We use the workflow
    # run start time as a proxy upper bound for "when GitHub first saw
    # this": if the workflow is running now, GitHub had it by now.
    return None  # signal: fall back to workflow-run-time below.


def workflow_run_time() -> datetime:
    # Best available "GitHub saw this" timestamp.
    return datetime.now(tz=timezone.utc)


def main() -> int:
    commits = commits_in_branch()
    if not commits:
        print("✅ verify-push-cadence OK — no new commits beyond main.")
        return 0

    now = workflow_run_time()
    violations: list[tuple[str, timedelta]] = []

    for sha in commits:
        committed = committer_date(sha).astimezone(timezone.utc)
        age = now - committed
        if age > THRESHOLD:
            violations.append((sha, age))

    if violations:
        print(
            "❌ verify-push-cadence FAILED — the following commits were "
            f"made >{THRESHOLD} before being pushed (R15 violation):\n",
            file=sys.stderr,
        )
        for sha, age in violations:
            hours = age.total_seconds() / 3600
            short = sha[:8]
            print(
                f"      {short}  age at push: {hours:.1f}h",
                file=sys.stderr,
            )
        print(
            "\nR15 requires agents to push every 2 minutes of active work. "
            "Commits older than 24h on push indicate work was sitting in "
            "a sandbox — the exact failure mode that strands canonical "
            "docs.\n\n"
            "If this is legitimate (e.g. a rebase replayed old commits), "
            "amend the commits to refresh committer dates before pushing.",
            file=sys.stderr,
        )
        return 1

    print(
        f"✅ verify-push-cadence OK — {len(commits)} commits, "
        f"all pushed within {THRESHOLD}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
