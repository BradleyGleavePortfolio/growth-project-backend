import re,sys,os,glob
migs=[l.strip() for l in open('/tmp/rls_diff.txt').read().split('\n') if l.strip()]
migs=[m.split()[1] for m in migs]
rows=[]
allsql={}
for m in sorted(migs):
    if not os.path.exists(m): continue
    s=open(m).read()
    # strip line comments
    s2=re.sub(r'--[^\n]*','',s)
    allsql[m]=s2
    for t in re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?(?:"?public"?\.)?"([A-Za-z_0-9]+)"',s2):
        rows.append((os.path.basename(os.path.dirname(m)),t))
big='\n'.join(allsql.values())
for mig,t in rows:
    q=re.escape(t)
    tp=r'(?:"?public"?\.)?"?'+q+r'"?'
    en=bool(re.search(r'ALTER TABLE (?:ONLY )?(?:IF EXISTS )?'+tp+r'\s+ENABLE ROW LEVEL SECURITY',big,re.I))
    fo=bool(re.search(r'ALTER TABLE (?:ONLY )?(?:IF EXISTS )?'+tp+r'\s+FORCE ROW LEVEL SECURITY',big,re.I))
    rv=bool(re.search(r'REVOKE[^;]*ON (?:TABLE )?[^;]*'+tp+r'[^;]*FROM[^;]*anon',big,re.I))
    pols=re.findall(r'CREATE POLICY\s+"?([^"\s]+)"?\s+ON\s+'+tp+r'\b([^;]*);',big,re.I)
    pl=[]
    for name,body in pols:
        b=' '.join(body.split())
        pl.append(name+': '+b[:160])
    dyn = t in big and re.search(r"format\(|EXECUTE",big) is not None
    print(f"{mig} | {t} | enable={en} force={fo} revoke_anon={rv} policies={len(pl)}")
    for p in pl: print('    ',p)
