import argparse
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(os.environ.get("AUDIT_OUTPUT", "/home/user/workspace/ops/aud-125/AUD-SOL-L1-125"))
ROOT.mkdir(parents=True, exist_ok=True)


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True)


parser = argparse.ArgumentParser()
parser.add_argument("repo", choices=["backend", "mobile"])
parser.add_argument("number", type=int)
args = parser.parse_args()
slug = f"BradleyGleavePortfolio/growth-project-{args.repo}"
pr = json.loads(gh("api", f"repos/{slug}/pulls/{args.number}"))
head = pr["head"]["sha"]
comments = json.loads(gh("api", f"repos/{slug}/issues/{args.number}/comments", "--paginate", "--slurp"))
comments = [c for page in comments for c in page]
filtered = []
same_lens = []
for comment in comments:
    body = comment["body"]
    if "AUDIT Claude Opus" in body:
        continue
    filtered.append({"url": comment["html_url"], "body": body})
    if ("AUDIT GPT-6.1 Sol" in body or "AUDIT GPT Sol" in body) and head in body:
        same_lens.append(comment["html_url"])
if os.environ.get("AUDIT_LOCAL_DIFF") == "1":
    checkout = f"/home/user/workspace/wt/RO-{args.repo}"
    names = subprocess.check_output(
        ["git", "-C", checkout, "diff", "--name-only", f"{pr['base']['sha']}...{head}"],
        text=True,
    ).splitlines()
    files = []
    for name in names:
        patch = subprocess.check_output(
            ["git", "-C", checkout, "diff", f"{pr['base']['sha']}...{head}", "--", name],
            text=True,
        )
        files.append({
            "filename": name, "patch": patch, "additions": 0, "deletions": 0,
            "blob_url": f"https://github.com/{slug}/blob/{head}/{name}",
        })
else:
    files = json.loads(gh("api", f"repos/{slug}/pulls/{args.number}/files", "--paginate", "--slurp"))
    files = [f for page in files for f in page]
checks = json.loads(gh("api", f"repos/{slug}/commits/{head}/check-runs", "-f", "per_page=100", "-X", "GET"))
summary = {
    "repo": args.repo, "number": args.number, "head": head,
    "base": pr["base"]["sha"], "title": pr["title"], "body": pr["body"],
    "state": pr["state"], "draft": pr["draft"],
    "additions": pr["additions"], "deletions": pr["deletions"],
    "url": pr["html_url"], "comments": filtered, "same_lens_current_head": same_lens,
    "checks": [
        {k: c.get(k) for k in ("name", "status", "conclusion", "details_url", "id", "output")}
        for c in checks["check_runs"]
    ], "files": files,
}
target = ROOT / f"{args.repo}-{args.number}.json"
target.write_text(json.dumps(summary, indent=2) + "\n")
display = {k: summary[k] for k in (
    "repo", "number", "head", "base", "state", "additions", "deletions",
    "same_lens_current_head",
)}
display["checks"] = [
    {k: c[k] for k in ("name", "status", "conclusion", "details_url")}
    for c in summary["checks"]
]
display["comments"] = [
    c for c in filtered
    if any(word in c["body"] for word in ("FIX ROUND", "READY", "AUDIT", "STATUS", "B-"))
]
print(json.dumps(display, indent=2))
print("\n=== DIFF ===")
for f in files:
    print(f"\n--- {f['filename']} (+{f['additions']} -{f['deletions']}) ---\n{f.get('patch', 'NO PATCH')}")
print(f"\nSAVED {target}")
