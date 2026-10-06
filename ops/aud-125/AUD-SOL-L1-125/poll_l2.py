import datetime
import json
import os
import pathlib
import re
import subprocess
import zoneinfo

ROOT = pathlib.Path("/home/user/workspace/ops/aud-125/AUD-SOL-L1-125/L2")
ROOT.mkdir(parents=True, exist_ok=True)


def gh(*args):
    return json.loads(subprocess.check_output(["gh", *args], text=True))


observed = datetime.datetime.now(zoneinfo.ZoneInfo("America/Los_Angeles")).isoformat()
rows = []
for repo in os.environ.get("AUDIT_QUEUE_REPOS", "mobile,backend").split(","):
    slug = f"BradleyGleavePortfolio/growth-project-{repo}"
    prs = gh("pr", "list", "--repo", slug, "--state", "open", "--limit", "100",
             "--json", "number,headRefName,headRefOid,title")
    for pr in prs:
        if not pr["headRefName"].startswith("agent125/") and not (
            repo == "backend" and pr["number"] in [776, 778, 785]
        ):
            continue
        number = pr["number"]
        head = pr["headRefOid"]
        pages = gh("api", f"repos/{slug}/issues/{number}/comments", "--paginate", "--slurp")
        comments = [
            {"url": c["html_url"], "body": c["body"]}
            for page in pages for c in page
            if "AUDIT Claude Opus" not in c["body"]
        ]
        ready = [
            c for c in comments
            if head in c["body"]
            and ("READY FOR AUDIT" in c["body"] or "READY FOR DELTA AUDIT" in c["body"])
            and re.search(r"(AUDIT-\d+-125|FIX-Q1-125|B-[A-Z0-9-]+-125)", c["body"])
        ]
        own = [c["url"] for c in comments if "AUDIT GPT-6.1 Sol" in c["body"] and head in c["body"]]
        rows.append({
            "repo": repo, "number": number, "head": head, "title": pr["title"],
            "ready": ready, "own_current": own,
        })
data = {"observed_at": observed, "rows": rows}
stamp = observed[:19].replace(":", "").replace("-", "")
(ROOT / f"queue-{stamp}.json").write_text(json.dumps(data, indent=2) + "\n")
(ROOT / "queue-latest.json").write_text(json.dumps(data, indent=2) + "\n")
print(observed)
for row in rows:
    status = "DONE" if row["own_current"] else ("READY" if row["ready"] else "WAIT")
    print(f"{status} {row['repo']}#{row['number']} {row['head']} {row['title']}")
