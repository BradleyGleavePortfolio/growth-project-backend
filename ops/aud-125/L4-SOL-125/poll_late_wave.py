"""Read-only late-wave monitor; all GitHub calls run through credentialed bash."""
import datetime
import json
from pathlib import Path
import subprocess
import time
from zoneinfo import ZoneInfo

ROOT = Path("/home/user/workspace/ops/aud-125/L4-SOL-125")
REPO = "BradleyGleavePortfolio/growth-project-backend"
PREFIXES = ("agent125/b-aib1", "agent125/b-aiassign")
KNOWN_FILE = ROOT / "reviewed_heads.json"
LA = ZoneInfo("America/Los_Angeles")
STOP_HOUR, STOP_MINUTE = 16, 55
WINDOW_START = time.monotonic()


def gh_json(*args):
    result = subprocess.run(["gh", *args], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout)


while True:
    now = subprocess.check_output(
        ["date", "+%Y-%m-%d %H:%M:%S %Z"],
        env={**__import__("os").environ, "TZ": "America/Los_Angeles"},
        text=True,
    ).strip()
    current = datetime.datetime.strptime(
        now.rsplit(" ", 1)[0], "%Y-%m-%d %H:%M:%S"
    ).replace(tzinfo=LA)
    notice_file = Path("/home/user/workspace/ops/lanes125/notify/L4-SOL-125.txt")
    if notice_file.exists() and "WRAP UP" in notice_file.read_text().upper():
        print(f"{now}: STOP WRAP UP", flush=True)
        break
    if (current.hour, current.minute) >= (STOP_HOUR, STOP_MINUTE):
        print(f"{now}: STOP 16:55", flush=True)
        break
    if time.monotonic() - WINDOW_START >= 510:
        print(f"{now}: MONITOR WINDOW COMPLETE; resume for remaining time", flush=True)
        break
    rows = gh_json(
        "pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
        "--json", "number,title,headRefName,headRefOid,url",
    )
    matched = [row for row in rows if row["headRefName"].startswith(PREFIXES)]
    matched.sort(key=lambda row: {806: 0, 805: 1, 807: 2}.get(row["number"], 3))
    for row in matched:
        comments = gh_json(
            "api", f"repos/{REPO}/issues/{row['number']}/comments",
            "--jq",
            '[.[] | select(.body | test("^(FIX ROUND|RESTACK|Sol verdict|AUDIT GPT-6.1 Sol|STATUS)")) | {id,html_url,body}]',
        )
        row["own_lens_and_builder_comments"] = comments
        row["ready"] = any(
            "READY FOR" in comment["body"]
            and row["headRefOid"] in comment["body"]
            for comment in comments
        )
    (ROOT / "latest_poll.json").write_text(
        json.dumps({"date": now, "pulls": matched}, indent=2) + "\n"
    )
    known = json.loads(KNOWN_FILE.read_text()) if KNOWN_FILE.exists() else {}
    pending = [row for row in matched
               if row["ready"] and known.get(str(row["number"])) != row["headRefOid"]]
    print(f"{now}: matching={len(matched)} READY pending={len(pending)}", flush=True)
    if pending:
        print(json.dumps(pending, indent=2), flush=True)
        break
    deadline = current.replace(hour=STOP_HOUR, minute=STOP_MINUTE, second=0, microsecond=0)
    time.sleep(max(0, min(180, (deadline - current).total_seconds())))
