#!/usr/bin/env python3
"""Inventory every open PR in backend + mobile: head, base, size, CI at head, latest verdict per lens and at head, last builder event."""
import json, subprocess, re, sys, concurrent.futures as cf
O="BradleyGleavePortfolio"
def api(path):
    for _ in range(4):
        r=subprocess.run(["gh","api","--paginate",path],capture_output=True,text=True)
        if r.returncode==0:
            t=r.stdout.strip()
            # paginate concatenates arrays: ][
            t=t.replace("]\n[",",").replace("][",",")
            return json.loads(t) if t else []
    raise SystemExit(f"api fail {path}: {r.stderr[:200]}")
VER=re.compile(r"AUDIT\s+(GPT-6\.1 Sol|Claude Opus 5\.5|[^—-]+?)\s+[—-]+\s+growth-project-(\w+)#(\d+)\s+@\s+([0-9a-f]{7,40})\s+[—-]+\s+VERDICT:\s*([A-Z ]+)")
EVT=re.compile(r"^(FIX ROUND[^—]*|RESTACK[^—]*|MAIN REFRESH[^—]*|OPENING[^—]*|READY[^—]*|MERGE-ONLY TREE CHECK[^—]*|NO-PII BASELINE[^—]*|SIZE ASSESSMENT[^—]*)\s*[—-]")
def one(k,pr):
    n=pr["number"]; R=f"{O}/growth-project-{k}"; head=pr["head"]["sha"]
    full=api(f"repos/{R}/pulls/{n}")
    cs=api(f"repos/{R}/issues/{n}/comments?per_page=100")
    lens={}; atHead={}; last_evt=None
    for c in cs:
        first=c["body"].split("\n",1)[0]
        m=VER.search(first)
        if m:
            model="Opus" if "Opus" in m.group(1) else ("Sol" if "Sol" in m.group(1) else m.group(1).strip())
            v=m.group(5).strip().replace("REQUEST CHANGES","RC")
            lens[model]=(m.group(4)[:8],v,c["created_at"][:16],c["id"])
            if head.startswith(m.group(4)) or m.group(4).startswith(head[:m.group(4).__len__()]):
                atHead[model]=(v,c["id"])
            continue
        e=EVT.search(first)
        if e: last_evt=(first[:110],c["created_at"][:16])
    ck=api(f"repos/{R}/commits/{head}/check-runs?per_page=100")
    runs=ck["check_runs"] if isinstance(ck,dict) else [x for d in ck for x in d.get("check_runs",[])] if isinstance(ck,list) else []
    latest={}
    for r in runs:
        if r["name"] not in latest or (r.get("started_at") or "")>(latest[r["name"]].get("started_at") or ""): latest[r["name"]]=r
    st={}
    for r in latest.values():
        s=r.get("conclusion") or r.get("status"); st[s]=st.get(s,0)+1
    fails=[r["name"] for r in latest.values() if r.get("conclusion") in ("failure","cancelled","timed_out")]
    return dict(repo=k,n=n,title=pr["title"][:70],head=head[:8],headfull=head,base=pr["base"]["ref"],updated=pr["updated_at"][:16],
                size=full["additions"]+full["deletions"],mstate=full.get("mergeable_state"),draft=pr.get("draft"),
                lens=lens,atHead=atHead,last_evt=last_evt,ci=st,fails=fails,created=pr["created_at"][:16])
out=[]
for k in ("backend","mobile"):
    prs=api(f"repos/{O}/growth-project-{k}/pulls?state=open&per_page=100")
    with cf.ThreadPoolExecutor(8) as ex:
        for r in ex.map(lambda p: one(k,p), prs): out.append(r)
json.dump(out,open("/home/user/workspace/ops/op120/inv/inventory.json","w"),indent=1)
print(len(out),"PRs")
