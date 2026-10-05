#!/usr/bin/env python3
"""FIX ROUND 1 (OPENING) + READY FOR AUDIT on each S-SCHED-2 split piece (B-SPLIT-SCHED-120, agent 120).
usage: post_fr1.py [--dry] [k ...]   Posts only when the PR head equals the built head and every check that ran is green."""
import json, os, subprocess, sys

R = "BradleyGleavePortfolio/growth-project-backend"
D = os.path.dirname(os.path.abspath(__file__))
meta = json.load(open(os.path.join(D, "pieces_meta.json")))
stack = json.load(open(os.path.join(D, "stack.json")))
U = "https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/634#issuecomment-"
M = "6fc88c457b917d74773f881ffed60c9d3f8d9d35"
TREE = "0595cfd70254cde577bf1cc3a844fa0c179c1d20"
REQ = ["build-and-test", "rls-floor-guard", "rls-live-tests", "mwb-3-live-tests", "npm audit (high+critical, whole graph)",
       "CodeQL JS/TS (javascript-typescript)", "Banned cast tokens (R75 / R100.A2)", "build-sbom", "danger",
       "Schema parity (migrations match schema.prisma)", "community-live-tests"]
MAIN_ONLY = {"CodeQL JS/TS (javascript-typescript)", "Banned cast tokens (R75 / R100.A2)", "build-sbom", "danger"}

# probe -> (code piece, regression location -> piece where the test lands)
PROBES = [
    ("B-634-1 (Sol) stale approval confirms a moved request", 4, "integrity `S-SCHED-3 B-634-1` block", 8),
    ("B-634-2 (Sol) transient failure consumes a reminder", 5, "booking-reminder.job spec; integrity B-634-2 / S-SCHED-4 / S-SCHED-5 blocks; reminder-delivery spec", 5),
    ("B-634-3 (Sol) provisioning overwrites a newer link", 4, "integrity `S-SCHED-3 B-634-3` block", 8),
    ("B-634-4 (Sol) past-page boundary rows lost", 6, "integrity `B-634-4 / C-634-3` keyset block", 8),
    ("B-634-5 (Opus) archived former welcome type restore 409", 6, "integrity `S-SCHED-3 B-634-5` block", 8),
    ("B-634-6 (Sol) raw ORM text in recovery log", 5, "integrity `S-SCHED-5 ... safe diagnostics` block", 8),
    ("B-634-7 (Sol) parked state rejected by the CHECK", 1, "scheduling-delivery-status-contract spec; migration CHECK", 5),
    ("B-634-8 (Sol) ORM text through the booking emitter", 3, "booking-emitter spec logger canaries", 3),
    ("B-634-9 (Sol) client 404 copy first person", 6, "integrity `B-634-9` block", 9),
    ("B-634-10 (Sol) log sanitizer not a closed enum", 1, "log-diagnostic-closed-enum spec; emitter canaries (3/9); integrity `B-634-10` block (9/9)", 1),
    ("Sol 3d989702 probes: actual emitter unknown name/code, forged P-code, wrapped Prisma", 3, "booking-emitter spec + log-diagnostic-closed-enum spec", 3),
    ("C-634-1 (Opus) btree_gist rollback ownership in down.sql", 1, "migration down.sql (byte-identical to the approved file)", 1),
    ("C-634-2 (Opus) preflight counts end_at < start_at", 1, "migration preflight; Forward migrations / reversible checks", 1),
    ("C-634-3 (Opus) upcoming cursor and status filter", 6, "integrity `B-634-4 / C-634-3` keyset block", 8),
    ("C-634-5 (Opus) seeded non-welcome Quick initialization", 2, "seed-coach-session-types spec", 2),
    ("C-634-6 (Opus) catch-up keyed on the current start", 5, "integrity `C-634-6` block", 9),
    ("Opus e18e8055 merge probes: ci.yml live steps kept, NotificationKind keeps both sides", 1, "ci.yml diff vs main is +4 (9/9); notification-kind.ts", 9),
    ("Checklist (a): scheduling error logs carry no free-form text", 5, "integrity `checklist (a)` block", 9),
]


def gh(*a, inp=None):
    p = subprocess.run(["gh"] + list(a), capture_output=True, text=True, input=inp)
    if p.returncode != 0:
        raise SystemExit(f"gh failed: {a[:3]} {p.stderr[:300]}")
    return p.stdout


def checks(sha):
    runs = json.loads(gh("api", f"repos/{R}/commits/{sha}/check-runs?per_page=100", "--jq",
                         "[.check_runs[] | {n:.name, s:.status, c:.conclusion, t:.started_at, u:.details_url}]"))
    last = {}
    for r in sorted(runs, key=lambda x: x["t"] or ""):
        last[r["n"]] = r
    return last


def body(k, sha, last):
    n = stack[str(k)]
    lines = meta[str(k)]["lines"]
    base = meta[str(k)]["base"]
    rows = []
    for name in REQ:
        r = last.get(name)
        if r is None:
            st = "runs on base main only (stacked piece)" if name in MAIN_ONLY else "MISSING"
        else:
            st = f"{r['c']} ([run]({r['u']}))"
        rows.append(f"| {name} | {st} |")
    other = sorted(x for x in last if x not in REQ)
    L = [f"FIX ROUND 1 (OPENING, B-SPLIT-SCHED-120, agent 120) — growth-project-backend#{n} @ {sha}", ""]
    L.append("| Item | State |")
    L.append("|---|---|")
    L.append(f"| Piece | S-SCHED-2 split {k}/9 of #634 (owner order 09:45 PDT 10-05: under 1,500 lines per piece) |")
    L.append(f"| Base | `{base}` |")
    L.append(f"| Size | {lines} changed lines (GitHub additions + deletions equal the local `git diff --numstat`) |")
    L.append(f"| Content | byte-identical to the reference merge M `{M}` for every file it carries, except the intermediate lines listed in the PR body (replaced by a later piece) |")
    L.append(f"| Top tree | tree(9/9 #720) == tree(M) == `{TREE}` |")
    L.append("| Fixes | none (split only; FREEZE). No behaviour change beyond the main-merge resolution R1-R7 in M |")
    L.append("| R75 | `check-r75.js --mode=range` vs the base: no positive token change |")
    L.append("")
    L.append("Required checks at this head (latest run per check):")
    L.append("")
    L.append("| Check | Result |")
    L.append("|---|---|")
    L += rows
    if other:
        L.append(f"| other ({len(other)}) | " + ", ".join(f"{x}: {last[x]['c']}" for x in other) + " |")
    L.append("")
    L.append("Probe replay (both lenses, every prior finding and probe; code piece / where the regression test lands):")
    L.append("")
    L.append("| Probe | Code | Test | At this head |")
    L.append("|---|---|---|---|")
    for name, code, where, tp in PROBES:
        if tp <= k:
            res = "PASS (test in this stack; build-and-test green at this head)"
        elif code <= k:
            res = f"code present; test lands in {tp}/9 (PASS at 9/9: #720 build-and-test green)"
        else:
            res = f"n/a here (code lands in {code}/9)"
        L.append(f"| {name} | {code}/9 | {where} ({tp}/9) | {res} |")
    L.append("| C-634-4 (product) | - | operator disposition | unchanged |")
    L.append("| C-634-11 (Opus, optional) | 1/9 | not fixed (FREEZE) | open C, in the report's follow-ups |")
    L.append("")
    L.append("Money list self-check:")
    L.append("- webhook order and redelivery: no webhook handler changes in the stack; Google Calendar webhook specs pass unchanged.")
    L.append("- concurrency and lock order: per-coach advisory lock first, then fresh reads and the exclusion floor (4/9); reminder FOR SHARE fence (5/9); unchanged from the audited code; live proof in 9/9.")
    L.append("- terminal states: completed, cancelled, declined and no_show refuse transitions with 409 from 4/9; reminder sent, gave_up and retired rows are never resent.")
    L.append("- pagination and fail-closed completeness: (start_at, id) keyset pages (6/9); catch-up walks the whole interval (5/9); a failed read counts as failed, not skipped.")
    L.append("- currency and minor units: no money in this stack.")
    L.append("- copy truth: S-SCHED-2 wording unchanged; no first person, no exclamation marks; no clock time without a usable zone; in 3/9-4/9 reminders omit the call-link sentence because main's job does not pass link state (true to what it knows).")
    L.append("")
    L.append(f"Prior verdicts on #634: [Opus APPROVE @3d989702]({U}5971916062), [Sol APPROVE @3d989702]({U}5971921481), [Opus merge-only APPROVE @e18e8055]({U}5972118900). Evidence reuse is each lens's decision, for byte-identical code only.")
    L.append("")
    L.append("READY FOR AUDIT")
    return "\n".join(L) + "\n"


def main():
    dry = "--dry" in sys.argv
    ks = [int(a) for a in sys.argv[1:] if a.isdigit()] or list(range(1, 10))
    for k in ks:
        n = stack[str(k)]
        sha = gh("api", f"repos/{R}/pulls/{n}", "--jq", ".head.sha").strip()
        if sha != meta[str(k)]["sha"]:
            print(f"SKIP {k} #{n}: head moved {sha}")
            continue
        last = checks(sha)
        pend = [x for x, r in last.items() if r["s"] != "completed"]
        bad = [x for x, r in last.items() if r["s"] == "completed" and r["c"] not in ("success", "skipped", "neutral")]
        miss = [x for x in REQ if x not in last and not (k > 1 and x in MAIN_ONLY)]
        if pend or bad or miss:
            print(f"WAIT {k} #{n}: pending={pend} bad={bad} missing={miss}")
            continue
        b = body(k, sha, last)
        open(os.path.join(D, f"fr1_{k}.md"), "w").write(b)
        if dry:
            print(f"DRY {k} #{n} ok ({len(b)} chars)")
            continue
        out = gh("api", "-X", "POST", f"repos/{R}/issues/{n}/comments", "--input", "-", "--jq", ".html_url",
                 inp=json.dumps({"body": b}))
        print(f"POSTED {k} #{n} {out.strip()}")


main()
