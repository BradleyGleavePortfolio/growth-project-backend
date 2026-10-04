import json, subprocess, sys, re
from concurrent.futures import ThreadPoolExecutor
O="BradleyGleavePortfolio"
pieces = {
 "backend": [681,682,683,684,685,686,671,672,673,674,676,677,675,687,688,689,690,691],
 "mobile": [359,360,361,362,363,364,355,356,357,358,352,353,354,345,346,347,348,349,350,351,342,343,344],
}
def gh(args):
    return subprocess.run(["gh"]+args, capture_output=True, text=True).stdout
def cls(path):
    if re.search(r'(package-lock\.json|yarn\.lock|\.snap)$', path): return "excluded"
    if "prisma/migrations/" in path: return "migrations"
    if re.search(r'(^|/)(test|tests|__tests__)/|\.(spec|test)\.[jt]sx?$', path): return "tests"
    if path.endswith(".md") or path.startswith("docs/"): return "docs"
    return "source"
def one(kn):
    k,n = kn; R=f"{O}/growth-project-{k}"
    pr = json.loads(gh(["api", f"repos/{R}/pulls/{n}", "--jq", "{head:.head.sha, base:.base.ref, add:.additions, dele:.deletions, draft:.draft, state:.state}"]))
    files = json.loads(gh(["api", "--paginate", f"repos/{R}/pulls/{n}/files?per_page=100", "--jq", "[.[] | {f:.filename, c:(.additions+.deletions)}]"]).replace("]\n[", ","))
    agg = {"source":0,"tests":0,"migrations":0,"docs":0,"excluded":0}; dirs={}
    for x in files:
        c=cls(x["f"]); agg[c]+=x["c"]
        d="/".join(x["f"].split("/")[:3]) if x["f"].startswith(("src/","test/")) else "/".join(x["f"].split("/")[:2])
        dirs[d]=dirs.get(d,0)+x["c"]
    roll = json.loads(gh(["api", f"repos/{R}/commits/{pr['head']}/check-runs?per_page=100", "--jq", "[.check_runs[] | {n:.name, s:.status, c:.conclusion}]"]) or "[]")
    fail=[r["n"] for r in roll if r["c"] in ("failure","timed_out","cancelled","action_required")]
    pend=[r["n"] for r in roll if r["s"]!="completed"]
    return {"k":k,"n":n,**pr,"agg":agg,"files":len(files),"dirs":sorted(dirs.items(), key=lambda t:-t[1])[:6],"fail":fail,"pend":pend,"nchecks":len(roll)}
jobs=[(k,n) for k in pieces for n in pieces[k]]
with ThreadPoolExecutor(12) as ex: res=list(ex.map(one, jobs))
json.dump(res, open("/home/user/workspace/ops/op116/pieces.json","w"), indent=1)
for r in res:
    a=r["agg"]; print(r["k"][0], r["n"], r["head"][:8], r["base"][:40], r["add"]+r["dele"], "src",a["source"],"tst",a["tests"],"mig",a["migrations"],"doc",a["docs"],"exc",a["excluded"], "fail",r["fail"], "pend",len(r["pend"]), "n",r["nchecks"])
