import re,os,sys,glob
be='/home/user/workspace/wt/RO-backend/src'; mo='/home/user/workspace/wt/RO-mobile/src'
routes=set()
for f in glob.glob(be+'/**/*.controller.ts',recursive=True):
    s=open(f).read()
    # split by @Controller occurrences
    parts=re.split(r'(@Controller\([^)]*\))',s)
    prefix=''
    for p in parts:
        m=re.match(r"@Controller\(\s*(?:\{[^}]*path:\s*)?['\"]([^'\"]*)['\"]",p)
        if p.startswith('@Controller'):
            prefix=m.group(1) if m else ''
            continue
        for mm in re.finditer(r"@(Get|Post|Put|Patch|Delete|All)\(\s*(?:['\"]([^'\"]*)['\"])?",p):
            meth=mm.group(1).upper(); sub=mm.group(2) or ''
            path='/'+'/'.join(x for x in (prefix.strip('/'),sub.strip('/')) if x)
            routes.add((meth,path))
def norm(p):
    segs=[s for s in p.split('/') if s]
    return ['*' if (s.startswith(':') or '${' in s) else s for s in segs]
be_norm=[(m,norm(p)) for m,p in routes]
def match(meth,segs):
    for m,b in be_norm:
        if m not in (meth,'ALL'): continue
        if len(b)!=len(segs): continue
        if all(x=='*' or y=='*' or x==y for x,y in zip(b,segs)): return True
    return False
miss=[]
for f in glob.glob(mo+'/**/*.ts*',recursive=True):
    if '__tests__' in f or '.test.' in f or '__fixtures__' in f: continue
    s=open(f).read()
    for mm in re.finditer(r"\bapi\.(get|post|put|patch|delete)(?:<[^>(]*>)?\(\s*([`'\"])(/[^`'\"]*)\2",s):
        meth=mm.group(1).upper(); p=mm.group(3).split('?')[0]
        p=re.sub(r'\$\{[^}]*\}\s*$','',p) if p.endswith('}') and p.count('${')==1 and p.rstrip('}').endswith('') and False else p
        if p.startswith('/v1/') and not match(meth,norm(p)):
            # backend may use v1 prefix in controller; try strip
            pass
        if not match(meth,norm(p)):
            line=s[:mm.start()].count('\n')+1
            miss.append((f.replace(mo,'src'),line,meth,p))
print(len(routes),'backend routes')
for x in sorted(miss): print(*x)
