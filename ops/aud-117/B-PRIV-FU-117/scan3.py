import os,re,sys
root=sys.argv[1]
call_re=re.compile(r'(?:\b(?:this\.)?\w*[lL]ogger|\bconsole|\bLogger)\s*\.\s*(log|warn|error|debug|verbose|info|fatal)\s*\(')
def code_parts(arg):
    # remove static parts of string literals, keep ${} expressions
    out=[];i=0;n=len(arg)
    while i<n:
        c=arg[i]
        if c in '\'"':
            q=c;i+=1
            while i<n and arg[i]!=q:
                if arg[i]=='\\': i+=1
                i+=1
            i+=1; out.append(' STR ')
        elif c=='`':
            i+=1
            while i<n and arg[i]!='`':
                if arg[i]=='\\': i+=2; continue
                if arg[i]=='$' and i+1<n and arg[i+1]=='{':
                    d=1;j=i+2
                    while j<n and d>0:
                        if arg[j]=='{': d+=1
                        elif arg[j]=='}': d-=1
                        j+=1
                    out.append(' '+arg[i+2:j-1]+' '); i=j; continue
                i+=1
            i+=1
        else:
            out.append(c); i+=1
    return ''.join(out)
pat=re.compile(r'(?i)(email|recipient|\bto\b|address|subject|\bbody\b|content\b|\btext\b|phone|first_?name|last_?name|full_?name|display_?name|username|user_?name|\bname\b|title|\bnotes?\b|comment|prompt|reply|question|answer|description|\bbio\b|caption|payload|\bdto\b|\binput\b|message\b)')
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
            cp=code_parts(arg)
            cp2=re.sub(r'\b(err|error|e|cause|releaseErr|ex|signInError|linkError|otpError|outcome)\b\s*(as\s+\w+\)?)?\s*\)?\s*\??\.\s*(message|name|code|constructor\.name|reason)','ERRFIELD',cp)
            cp2=re.sub(r'instanceof\s+Error\s*\?\s*\w+\.(message|name)','ERRFIELD',cp2)
            hits=set(h.lower() for h in pat.findall(cp2))
            if hits:
                print(f'{p[len(root)+1:]}:{line} {sorted(hits)} :: {" ".join(cp2.split())[:160]}')
