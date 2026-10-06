import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path("/home/user/workspace/ops/aud-125/AUD-SOL-L1-125")
receipts = []
latest = {}
for path in ROOT.rglob("*-receipt.json"):
    row = json.loads(path.read_text())
    if path.parent != ROOT or (row["repo"] == "mobile" and row["number"] >= 416):
        row["evidence_path"] = str(path)
        receipts.append(row)
        key = (row["repo"], row["number"])
        if key not in latest or path.stat().st_mtime > latest[key][0]:
            latest[key] = (path.stat().st_mtime, row)
receipts.sort(key=lambda r: (r["repo"], r["number"], r["head"]))
observed = subprocess.check_output(
    ["bash", "-lc", "TZ=America/Los_Angeles date '+%Y-%m-%d %H:%M:%S %Z'"], text=True
).strip()
data = {"observed_at": observed, "receipts": receipts}
(ROOT / "AUD-SOL-L2-125-results.json").write_text(json.dumps(data, indent=2) + "\n")
lines = [
    "# AUD-SOL-L1-125 — live L2 follow-on",
    "",
    f"Report updated: {observed}.",
    "",
    "## Scope traced",
    "Exact-head independent Sol review of READY auditor PRs; clinic is the launch build profile for both iOS and Android. Following the operator split, this lens now owns MOBILE only; backend and FIX-Q1 deltas belong to L3.",
    "No code push, merge, deployment, local build/test or production/provider action.",
    "",
    "## Verdicts",
    "| PR | Exact head | Verdict | B | Posted verdict |",
    "|---|---|---|---:|---|",
]
for r in receipts:
    lines.append(f"| {'m' if r['repo']=='mobile' else 'b'}#{r['number']} | `{r['head']}` | {r['verdict']} | {r['B']} | [Exact-head Sol review]({r['url']}) |")
lines += ["", "## B / CI blockers", ""]
for _, r in latest.values():
    if r["verdict"] == "REQUEST CHANGES":
        lines.append(f"- Latest posted {r['repo']}#{r['number']} verdict is REQUEST CHANGES at `{r['head']}`, B={r['B']}; a newer unreviewed head is not cleared by an older review. [Sol verdict]({r['url']})")
lines += [
    "",
    "## Nonblocking U / C",
    "- m#426: explicit server `has_gym_membership:false` remains unanswered after sign-in; a small no-gym mapping follow-up is recommended. [Sol review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/426#issuecomment-6025673575)",
    "",
    "## Integration / covered by open PRs",
    "- Preserve m#416 Home-label wrapping while landing m#429 badge work; both change HomeHeaderActions. [polish review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/416#issuecomment-6025698369), [messaging review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/429#issuecomment-6025671998)",
    "- The builder records AI edit-body compatibility as covered by b#793 and declares the mobile overlap with m#427. [m#425 builder scope](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/425#issuecomment-6025671927)",
    "- Preserve both the corrected draft id from m#427 and the truthful library-save copy from m#425 when resolving their shared approval hunk; b#793 must deploy for Save edits to work. [m#427 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/427#issuecomment-6025736405), [m#425 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/425#issuecomment-6025736890), [b#793 review](https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/793#issuecomment-6025942348)",
    "- Paid-file opening in m#434 requires the b#798 buyer-route deploy; before it, the mobile screen returns a specific unavailable message rather than claiming a file is saved. [m#434 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/434#issuecomment-6026130509)",
    "- Coach-approved Roman set counts in m#435 require the additive b#800 response field; current production falls back to its existing plan rows safely. [m#435 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/435#issuecomment-6026267926)",
    "- Server-driven tracker rows and the provider callback in m#436 require b#799 and real provider activation; today's older backend keeps cloud rows hidden safely. [m#436 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/436#issuecomment-6026334826)",
    "- m#427 conflict resolution preserves both the corrected action draft id and the truthful approval copy; its delta is cleared at a1f1459c. [delta review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/427#issuecomment-6026557565)",
    "- m#438 exposes the opt-in roster leaderboard inside Community; launch posture follows the operator's 15:24 confirmation of the owner's 15:06 override. [m#438 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/438#issuecomment-6026557189)",
    "- m#416 conflict resolution retains label wrapping beside the landed unread-message badge and preserves the other merged navigation fixes. [delta review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/416#issuecomment-6026570202)",
    "- m#437 enables clinic deliverables and ready-only media upload/selection; paid buyer opening needs b#798 deployed and successful uploads still depend on configured storage/Mux. No live provider operation was performed by this lens. [m#437 review](https://github.com/BradleyGleavePortfolio/growth-project-mobile/pull/437#issuecomment-6026576921)",
    "",
    "## PRs opened",
    "None.",
    "",
    "## HANDOFF",
    "Per-head evidence, verdict payloads and posting receipts are in ops/aud-125/AUD-SOL-L1-125/ and its L2/ and delta/ subdirectories.",
    "Notifications continue in ops/lanes125/notify/AUD-SOL-L1-125.txt. Poll MOBILE every five minutes until operator WRAP UP or 16:30 PDT.",
    "Backend handoff is L2/backend-handoff-to-L3.md; b#795 repair and b#785 FIX-Q1 delta need L3 verdicts, not duplicate reviews here.",
    "Safety predicate reproduction for the first b#795 head is saved as L2/backend-795-predicate-evidence.json, with a read-only evaluator in L2/crisis-predicate-review.mjs. It evaluates source predicates only, not a local build or test runner.",
]
path = pathlib.Path("/home/user/workspace/ops/reports/AUD-SOL-L2-125.md")
path.write_text("\n".join(lines) + "\n")
print(f"Saved {path}; {len(receipts)} L2/delta verdicts.")
