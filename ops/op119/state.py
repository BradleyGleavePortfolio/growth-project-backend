import json,subprocess,re,sys
R={'backend':'BradleyGleavePortfolio/growth-project-backend','mobile':'BradleyGleavePortfolio/growth-project-mobile'}
def gh(args):
    return subprocess.run(['gh']+args,capture_output=True,text=True).stdout
def row(k,n):
    pr=json.loads(gh(['pr','view',str(n),'-R',R[k],'--json','number,headRefOid,baseRefName,mergeStateStatus,additions,deletions,statusCheckRollup,state']))
    cm=json.loads(gh(['api',f'repos/{R[k]}/issues/{n}/comments?per_page=100','--paginate']) or '[]') if True else []
    head=pr['headRefOid']
    verd={}
    last_fix=None; ready_at=None
    for c in cm:
        b=c['body']; first=b.split('\n')[0]
        m=re.match(r'AUDIT (Claude Opus 5\.5|GPT-6\.1 Sol).*?@ ([0-9a-f]{40}).*?VERDICT: ([A-Z ]+)',first)
        if m:
            model='Opus' if 'Opus' in m.group(1) else 'Sol'
            v=m.group(3).strip()
            mm=re.search(r'A/B/C\s*=\s*(\d+/\d+/\d+)',b)
            # corrections
            if 'withdrawn' in b.lower()[:600] or 'Correction' in b[:300]:
                pass
            verd[model]=(m.group(2)[:8],('APPROVE' if v.startswith('APPROVE') else 'RC' if v.startswith('REQUEST') else v),mm.group(1) if mm else '?',c['created_at'][11:16])
        if re.match(r'(FIX ROUND|RESTACK|OPENING|MERGE-ONLY TREE CHECK)',first):
            m2=re.search(r'@ ([0-9a-f]{40})',first)
            last_fix=(first.split('(')[0].strip()[:20], m2.group(1)[:8] if m2 else '?', c['created_at'][5:16])
        if 'READY FOR AUDIT' in b:
            m2=re.search(r'@ ([0-9a-f]{40})',first)
            if m2: ready_at=m2.group(1)[:8]
    import json as J
    ch=J.loads(gh(['pr','checks',str(n),'-R',R[k],'--json','name,state']) or '[]')
    roll=[{'name':c['name'],'conclusion':c['state']} for c in ch]
    def st(x): return (x.get('conclusion') or x.get('state') or x.get('status') or '').upper()
    fails=[x.get('name') or x.get('context') for x in roll if st(x) in ('FAILURE','ERROR','CANCELLED','TIMED_OUT','ACTION_REQUIRED')]
    pend=[x.get('name') or x.get('context') for x in roll if st(x) in ('IN_PROGRESS','QUEUED','PENDING','EXPECTED','WAITING')]
    ok=sum(1 for x in roll if st(x)=='SUCCESS')
    ci=f"{ok} ok" + (f", FAIL {','.join(fails)}" if fails else '') + (f", pend {len(pend)}" if pend else '')
    vs=' '.join(f"{m}:{v[1]} {v[2]}@{v[0]}{'' if v[0]==head[:8] else '(OLD)'}" for m,v in sorted(verd.items()))
    lf=f"{last_fix[0]}@{last_fix[1]} {last_fix[2]}" if last_fix else '-'
    print(f"{k[0]}#{n}|{head[:8]}|{pr['baseRefName'][:38]}|{pr['mergeStateStatus']}|{pr['additions']+pr['deletions']}|{ci}|{vs or 'none'}|last:{lf}|READY@{ready_at}")
k=sys.argv[1]
for n in sys.argv[2:]: row(k,int(n))
