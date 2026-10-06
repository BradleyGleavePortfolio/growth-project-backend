"""Five-minute read-only queue watch; stop on work or the operator's stop marker."""
import datetime
import json
import os
import pathlib
import subprocess
import time
import zoneinfo

root = pathlib.Path("/home/user/workspace/ops/aud-125/AUD-SOL-L1-125")
stop = root / "MOBILE_WATCH_STOP"
zone = zoneinfo.ZoneInfo("America/Los_Angeles")
deadline = datetime.datetime(2026, 10, 6, 16, 30, tzinfo=zone)
env = {**os.environ, "AUDIT_QUEUE_REPOS": "mobile"}
while not stop.exists():
    remaining = (deadline - datetime.datetime.now(zone)).total_seconds()
    if remaining <= 0:
        print("DEADLINE 16:30 PDT reached", flush=True)
        break
    time.sleep(min(300, remaining))
    if stop.exists():
        print("OPERATOR STOP marker present", flush=True)
        break
    subprocess.run(["bash", "-lc", "TZ=America/Los_Angeles date"], check=True)
    subprocess.run(["python", str(root / "poll_l2.py")], env=env, check=True)
    queue = json.loads((root / "L2/queue-latest.json").read_text())
    pending = [r for r in queue["rows"] if not r["own_current"]]
    if pending:
        print("NEW OR UNREVIEWED MOBILE WORK", json.dumps(pending), flush=True)
        break
