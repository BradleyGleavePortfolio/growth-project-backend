import json, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
O="BradleyGleavePortfolio"
data={ (r["k"],r["n"]):r for r in json.load(open("/home/user/workspace/ops/op116/pieces.json")) }
stacks=[
 ("backend","fees",627,[681,682,683,684,685,686],"F",{682:"build-and-test",683:"build-and-test"},
  "Land as one (MERGE_DEPENDENCY_GUIDE rule 11): after dual APPROVE on every piece, merge F6 into F5 ... F2 into F1, confirm F1's tree equals the audited F6 head, merge F1 into main with all required checks green, deploy together with mobile #321. F1 must not land alone.",
  "F2 swaps the transfer orchestrator under main's purchase-split handler; main's purchase-split, webhook fee-split and checkout specs stay red until F4 (#684) carries their updated versions"),
 ("backend","trials",656,[671,672,673],"T",{}, "Land as one (rule 11); inert until T3; deploy after T3, then mobile #338. #672 and #675 both change packages.service/controller: the second to land refreshes.",""),
 ("backend","coach money",641,[674,676,677],"M",{}, "M1 #674 -> M3 #676 -> M4 #677 land as one (rule 11); M2 #675 lands on its own; deploy after both, then the mobile coach stacks.",""),
 ("backend","coach money",641,[675],"M2 ",{}, "Lands on its own (base main); #672 and #675 both change packages.service/controller: the second to land refreshes.",""),
 ("backend","dunning",628,[687,688,689,690,691],"D",{}, "Land as one (rule 11); D4 #690 is the first live change; deploy after D5, then mobile #352-#354.",""),
 ("mobile","Health Connect",317,[359,360,361,362,363,364],"W",{}, "Land as one (rule 11); ships in the clinic binary on day 1 (owner 10-03 18:42) with the backend flag flip FEATURE_WEARABLES_INGEST_POST.",""),
 ("mobile","programs",328,[355,356,357,358],"G",{}, "Land as one (rule 11); backend programs are live.",""),
 ("mobile","lockout",322,[352,353,354],"L",{}, "Land as one (rule 11) after backend dunning #687-#691 is deployed.",""),
 ("mobile","coach setup",329,[345,346,347],"S",{}, "Land as one (rule 11) after backend coach money #674-#677 + #675 is deployed; then #348-#351.",""),
 ("mobile","coach money",332,[348,349,350,351],"N",{349:"Typecheck, lint, test",350:"Typecheck, lint, test"}, "Land as one (rule 11) after #345-#347; N2 and N3 must not land without N4.",
  "main's source-scanning suites paymentsConnectPackages and coachSaasBlockers expect the Earnings routes that N2 removes; N4 (#351) deletes the files and carries both updated suites"),
 ("mobile","payment sheet",334,[342,343,344],"P",{}, "Land as one (rule 11) after backend recurring #678-#680 is deployed (OR-112-13 pair with #654).",""),
]
def gh(args, inp=None):
    p=subprocess.run(["gh"]+args, capture_output=True, text=True, input=inp); return p
def latest_checks(R, sha):
    out=gh(["api", f"repos/{R}/commits/{sha}/check-runs?per_page=100", "--jq", "[.check_runs[] | {n:.name, s:.status, c:.conclusion, t:.started_at}]"]).stdout
    runs=json.loads(out or "[]"); last={}
    for r in sorted(runs, key=lambda x: x["t"] or ""): last[r["n"]]=r
    fail=sorted(n for n,r in last.items() if r["c"] in ("failure","timed_out","cancelled","action_required"))
    pend=sorted(n for n,r in last.items() if r["s"]!="completed")
    return fail,pend,len(last)
def body_for(k,name,orig,pieces,pre,red,land,redwhy,n,i):
    r=data[(k,n)]; R=f"{O}/growth-project-{k}"
    head=gh(["api", f"repos/{R}/pulls/{n}", "--jq", ".head.sha"]).stdout.strip()
    if head!=r["head"]: return None, f"head moved {n}"
    fail,pend,nc=latest_checks(R, head)
    a=r["agg"]; tot=r["add"]+r["dele"]; lab=f"{pre}{i+1}" if pre!="M2 " else "M2"
    if pend: return None, f"pending {n} {pend}"
    if fail and set(fail)-{red.get(n,"__")}: return None, f"unexpected fail {n} {fail}"
    lines=[f"READY FOR AUDIT (operator 116) — growth-project-{k}#{n} @ {head}", ""]
    lines.append(f"Piece {lab} of the {name} split of #{orig} ({len(pieces)} pieces: " + " -> ".join(f"#{p}" for p in pieces) + f"). Base `{r['base']}`. T4 (max-tier rule).")
    if n in red:
        lines.append(f"Checks at this head (latest run per check, {nc} checks): all green except **{red[n]}**, which is red by design: {redwhy}. Lenses verify the red check fails only for that reason.")
    else:
        lines.append(f"Checks at this head (latest run per check, {nc} checks): all green." + ("" if r['base']=='main' else " CodeQL, danger, banned casts and build-sbom run only when the stack lands on main."))
    lines.append(f"Land rule: {land}")
    if tot>1500:
        dirs=", ".join(f"`{d}` {c}" for d,c in r["dirs"])
        kind = "tests-only piece" if a["source"]==0 and a["migrations"]==0 else "code piece with its own tests"
        lines += ["", f"SIZE ASSESSMENT (operator 116, MODEL_ROUTING 8.2) — growth-project-{k}#{n} @ {head}",
          f"- Lines: {tot} changed (source {a['source']} / tests {a['tests']} / migrations {a['migrations']} / docs {a['docs']}; excluded {a['excluded']}); {r['files']} files. Under the 3,000 hard limit.",
          f"- Seams (largest areas): {dirs}.",
          f"- Coupling: {kind}; the piece boundaries, dependency direction (no piece imports a later piece) and per-piece tests are stated in the PR body.",
          f"- Decision: KEEP. This is already one logical piece of the owner-ordered split of #{orig}. Cutting it further would separate code from the tests that prove it" + (" or a migration from the code that uses it" if a['migrations'] else "") + f", and would add a restack round to every later piece without making any line easier to audit. Fix rounds must keep it under 3,000."]
    return "\n".join(lines), None
jobs=[]
for k,name,orig,pieces,pre,red,land,redwhy in stacks:
    for i,n in enumerate(pieces): jobs.append((k,name,orig,pieces,pre,red,land,redwhy,n,i))
def post(j):
    k=j[0]; n=j[8]
    b,err=body_for(*j)
    if err: return f"SKIP {k}#{n}: {err}"
    if "--dry" in sys.argv: return f"DRY {k}#{n}\n{b}\n"
    p=gh(["api", f"repos/{O}/growth-project-{k}/issues/{n}/comments", "-F", "body=@-", "--jq", ".html_url"], inp=b)
    return f"POSTED {k}#{n} {p.stdout.strip()} {p.stderr.strip()[:200]}"
sel=[j for j in jobs if ("--only" not in sys.argv or str(j[8]) in sys.argv[sys.argv.index('--only')+1].split(','))]
with ThreadPoolExecutor(8) as ex:
    for line in ex.map(post, sel): print(line)
