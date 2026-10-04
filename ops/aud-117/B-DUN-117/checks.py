import json, subprocess, sys
REQ = ["build-and-test","rls-floor-guard","rls-live-tests","mwb-3-live-tests","community-live-tests",
       "npm audit (high+critical, whole graph)","Schema parity (migrations match schema.prisma)",
       "CodeQL JS/TS","Banned cast tokens","build-sbom","danger"]
def latest(sha):
    out = subprocess.run(["gh","api","--paginate",f"repos/BradleyGleavePortfolio/growth-project-backend/commits/{sha}/check-runs?per_page=100",
                          "--jq",".check_runs[]"],capture_output=True,text=True,check=True).stdout
    runs=[json.loads(l) for l in out.splitlines() if l.strip()]
    best={}
    for r in runs:
        n=r["name"]
        if n not in best or (r["started_at"] or "") > (best[n]["started_at"] or ""): best[n]=r
    return best
sha=sys.argv[1]
b=latest(sha)
for n in REQ:
    for k,r in b.items():
        if k==n or k.startswith(n):
            print(f"{k}\t{r['status']}/{r['conclusion']}\t{r['html_url']}")
            break
    else:
        print(f"{n}\tABSENT")
