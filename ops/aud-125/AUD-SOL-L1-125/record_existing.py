import json
import pathlib

root = pathlib.Path("/home/user/workspace/ops/aud-125/AUD-SOL-L1-125")
data = json.loads((root / "mobile-406.json").read_text())
assert data["same_lens_current_head"]
receipt = {
    "repo": "mobile", "number": 406, "head": data["head"],
    "verdict": "APPROVE (existing)", "B": 0,
    "url": data["same_lens_current_head"][0],
}
(root / "mobile-406-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
with pathlib.Path("/home/user/workspace/ops/lanes125/notify/AUD-SOL-L1-125.txt").open("a") as stream:
    stream.write(f"growth-project-mobile#406 @ {data['head'][:8]} APPROVE (existing; skipped) B=0\n")
print(json.dumps(receipt))
