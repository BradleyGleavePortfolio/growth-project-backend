import json
import pathlib
import subprocess

ROOT = pathlib.Path("/home/user/workspace/ops/aud-125/AUD-SOL-L1-125")
ORDER = [
    ("backend", 776), ("backend", 779), ("backend", 778),
    ("mobile", 410), ("mobile", 402), ("mobile", 405), ("mobile", 407),
    ("mobile", 412), ("backend", 780), ("mobile", 404), ("mobile", 406),
    ("backend", 785), ("mobile", 413), ("backend", 783), ("mobile", 409),
    ("backend", 782), ("backend", 777), ("mobile", 408), ("mobile", 414),
    ("mobile", 415), ("backend", 781), ("backend", 784),
]
rows = []
for repo, number in ORDER:
    receipt = json.loads((ROOT / f"{repo}-{number}-receipt.json").read_text())
    live = json.loads(subprocess.check_output([
        "gh", "api", f"repos/BradleyGleavePortfolio/growth-project-{repo}/pulls/{number}",
        "--jq", "{head:.head.sha,state,merged,merge_commit_sha}",
    ], text=True))
    receipt["live_at_handoff"] = live
    receipt["head_unchanged"] = live["head"] == receipt["head"]
    rows.append(receipt)
checks_404 = json.loads(subprocess.check_output([
    "gh", "api",
    "repos/BradleyGleavePortfolio/growth-project-mobile/commits/0930dfeb93f7b6f805fd1373b3a199a6c9755d5c/check-runs",
], text=True))
data = {
    "job": "AUD-SOL-L1-125", "rows": rows, "B_total": sum(r["B"] for r in rows),
    "new_verdicts_posted": 21, "existing_exact_head_verdicts_skipped": 1,
    "A_total": 2, "U_total": 0, "C_total": 1,
    "mobile_404_final_checks": [
        {k: c[k] for k in ("name", "status", "conclusion", "details_url")}
        for c in checks_404["check_runs"]
    ],
}
(ROOT / "AUD-SOL-L1-125-results.json").write_text(json.dumps(data, indent=2) + "\n")
lines = [
    "# AUD-SOL-L1-125 — exact-head L1 handoff",
    "",
    "## Scope",
    "22 queue PRs accounted for: 21 new verdict comments, one existing exact-head Sol approval skipped.",
    "No other lens's current-head verdict was read. No code push, merge, deployment, local build/test, or production/provider action.",
    "",
    "## Results",
    "",
    "| PR | Exact audited head | Verdict | B | Verdict receipt |",
    "|---|---|---|---:|---|",
]
for row in rows:
    prefix = "b" if row["repo"] == "backend" else "m"
    lines.append(
        f"| {prefix}#{row['number']} | `{row['head']}` | {row['verdict']} | {row['B']} "
        f"| [Exact-head comment]({row['url']}) |"
    )
lines += [
    "",
    "## B list",
    "- **B-776-1:** A coach fully refunds a recurring plan and then tries to restart billing, but launch production has FEATURE_DUNNING_V2 off, so the new refund pause ends access while the restart returns flag_off. Smallest fix: permit owning-coach refund restart/read-model visibility independently of nonpayment rollout; alternative is an explicit owner-approved activation prerequisite. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/776#issuecomment-6025292807).",
    "- **B-778-1:** A coach edits cadence/price while an existing recurring contract is disputed/refunded, and the active/trialing/past_due-only predicate allows it although Stripe retains the old contract; app cadence and later billing then differ. Smallest fix: reuse a genuine live-contract predicate in pricing enforcement and pricing_locked. [Sol verdict](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/778#issuecomment-6025315964).",
    "",
    "## CI blockers (A=2, B=0 on b#785)",
    "- build-and-test: unchanged expected signup/login limits and exact public route inventory fail after the changed contract. [Failed job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37525742910/job/112482163738).",
    "- R75: new casts (+1 as any, +2 as unknown as, +6 as never). [Failed job](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37525742609/job/112482162777).",
    "",
    "## U list",
    "None found in reviewed deltas.",
    "",
    "## C one-liners",
    "b#781: C (edge, deferred to 10k clients): unusual calendar/device-clock behavior; not investigated.",
    "",
    "## Covered by existing verdicts / dependencies",
    "- m#406 current exact-head Sol approval already existed; no duplicate was posted. [Existing verdict](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/406#issuecomment-6024663006).",
    "- m#405 and m#407 mobile-slice approvals do not close their backend companion findings on b#776 and b#778.",
    "- m#404 advanced from the originally listed ab6d426b to 0930dfeb before this review; reviewed the new deduplication delta and posted at 0930dfeb. Its checks were running at verdict time and are now green. [Current-head CI](https://github.com/BradleyGleavePortfolio/growth-project-mobile/actions/runs/37530806852/job/112499384946).",
    "",
    "## PRs opened",
    "None.",
    "",
    "## Not fixed (needs operator)",
    "B-776-1, B-778-1, and the two b#785 PR-caused CI failures are left for the authorized builders/operator.",
    "",
    "## Live head verification at handoff",
]
for row in rows:
    prefix = "b" if row["repo"] == "backend" else "m"
    live = row["live_at_handoff"]
    lines.append(
        f"- {prefix}#{row['number']}: {'head unchanged' if row['head_unchanged'] else 'HEAD MOVED'}; "
        f"live `{live['head']}`, state `{live['state']}`, merged `{live['merged']}`. "
        f"[PR](https://github.com/BradleyGleavePortfolio/growth-project-{row['repo']}/pull/{row['number']})."
    )
lines += [
    "",
    "## HANDOFF",
    "All queue work is saved under ops/aud-125/AUD-SOL-L1-125/: per-PR .json evidence, .md verdicts and -receipt.json posting receipts; aggregate results JSON is authoritative for audited heads.",
    "Notifications: ops/lanes125/notify/AUD-SOL-L1-125.txt.",
    "Operator action: route the two Bs and b#785 CI repair; retain exact-head dual-lens/required-check gates. No user decision beyond the already held dunning activation alternative was assumed.",
]
report = pathlib.Path("/home/user/workspace/ops/reports/AUD-SOL-L1-125.md")
report.parent.mkdir(parents=True, exist_ok=True)
report.write_text("\n".join(lines) + "\n")
with pathlib.Path("/home/user/workspace/ops/lanes125/notify/AUD-SOL-L1-125.txt").open("a") as stream:
    stream.write("done | PRs: 22 reviewed/accounted, 21 new verdicts + m#406 existing | B=2 U=0 | needs operator: b#776,b#778,b#785\n")
print(json.dumps(data, indent=2))
print(f"SAVED {report}")
