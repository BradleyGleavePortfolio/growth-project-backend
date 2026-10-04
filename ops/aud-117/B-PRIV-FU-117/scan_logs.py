import os,re,sys,json
root=sys.argv[1]
call_re=re.compile(r'\b(?:this\.logger|logger|console|Logger|this\.log|log)\.(log|warn|error|debug|verbose|info|fatal)\s*\(')
out=[]
for dp,dn,fn in os.walk(os.path.join(root,'src')):
    for f in fn:
        if not f.endswith('.ts') or f.endswith('.spec.ts'): continue
        p=os.path.join(dp,f); s=open(p).read()
        for m in call_re.finditer(s):
            i=m.end(); depth=1; j=i
            while j<len(s) and depth>0:
                c=s[j]
                if c=='(': depth+=1
                elif c==')': depth-=1
                j+=1
            arg=s[i:j-1]
            line=s.count('\n',0,m.start())+1
            exprs=re.findall(r'\$\{([^}]*)\}',arg)
            # also bare identifiers passed as extra args
            out.append((p[len(root)+1:],line,m.group(1),exprs,arg.strip()[:240].replace('\n',' ')))
pat=re.compile(r'(?i)email|\bto\b|address|subject|body|content|text|phone|first_?name|last_?name|full_?name|display_?name|username|\bname\b|title|note|comment|prompt|reply|question|answer|description|bio|caption')
for p,line,lvl,exprs,arg in out:
    hits=[e for e in exprs if pat.search(e) and not re.search(r'(err|e|error|releaseErr|cause)\s*(instanceof|\.)\s*.*name|constructor\.name|\.name\s*:\s*.unknown',e)]
    if hits:
        print(f'{p}:{line} [{lvl}] {hits} :: {arg[:200]}')
print('TOTAL calls',len(out),file=sys.stderr)
