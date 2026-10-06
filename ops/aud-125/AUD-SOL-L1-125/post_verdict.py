import argparse
import json
import os
import pathlib
import re
import subprocess

ROOT = pathlib.Path(os.environ.get("AUDIT_OUTPUT", "/home/user/workspace/ops/aud-125/AUD-SOL-L1-125"))
NOTIFY = pathlib.Path("/home/user/workspace/ops/lanes125/notify/AUD-SOL-L1-125.txt")


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True).strip()


parser = argparse.ArgumentParser()
parser.add_argument("repo", choices=["backend", "mobile"])
parser.add_argument("number", type=int)
args = parser.parse_args()
slug = f"BradleyGleavePortfolio/growth-project-{args.repo}"
file = ROOT / f"{args.repo}-{args.number}.md"
body = file.read_text()
match = re.match(
    rf"AUDIT GPT-6.1 Sol — growth-project-{args.repo}#{args.number} @ ([0-9a-f]{{40}}) — VERDICT: (APPROVE|REQUEST CHANGES)",
    body,
)
if not match:
    raise SystemExit("INVALID VERDICT FIRST LINE")
head, verdict = match.groups()
live = gh("api", f"repos/{slug}/pulls/{args.number}", "--jq", ".head.sha")
if live != head:
    raise SystemExit(f"HEAD MOVED: {head} -> {live}; STOP WITHOUT POST")
pages = json.loads(gh("api", f"repos/{slug}/issues/{args.number}/comments", "--paginate", "--slurp"))
existing = [
    c["html_url"] for page in pages for c in page
    if "AUDIT GPT-6.1 Sol" in c["body"] and head in c["body"]
]
if existing:
    raise SystemExit(f"SAME LENS ALREADY POSTED: {existing}")
comment = json.loads(gh("api", f"repos/{slug}/issues/{args.number}/comments", "-F", f"body=@{file}"))
receipt = {
    "repo": args.repo, "number": args.number, "head": head, "verdict": verdict,
    "B": int(re.search(r"\bB=(\d+)", body).group(1)),
    "url": comment["html_url"],
}
(ROOT / f"{args.repo}-{args.number}-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
NOTIFY.parent.mkdir(parents=True, exist_ok=True)
with NOTIFY.open("a") as stream:
    stream.write(f"growth-project-{args.repo}#{args.number} @ {head[:8]} {verdict} B={receipt['B']}\n")
print(json.dumps(receipt))
