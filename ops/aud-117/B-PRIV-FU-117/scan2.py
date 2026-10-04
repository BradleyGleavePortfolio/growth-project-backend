import os,re,sys
root=sys.argv[1]
call_re=re.compile(r'\b(?:this\.logger|logger|console|Logger|this\.log|log|this\.\w*[lL]ogger)\.(log|warn|error|debug|verbose|info|fatal)\s*\(')
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
            # strip template literal static text and string literals to look at code parts
            flags=[]
            if re.search(r'JSON\.stringify|safeStringify|inspect\(',arg): flags.append('STRINGIFY')
            if re.search(r'(?<![\w.])(email|to|recipient|address|body|payload|dto|input|user|profile|req|request|data)\s*[,)]?\s*$',arg.strip()) and not arg.strip().startswith('`') : flags.append('BAREARG')
            if re.search(r'\+\s*\w*(email|Email|name|Name)',arg): flags.append('CONCAT')
            # extra args after the message
            if re.search(r'`\s*,\s*\{',arg) or re.search(r"'\s*,\s*\{",arg): flags.append('OBJARG')
            if re.search(r'\bemail\b\s*[:,}]',arg): flags.append('EMAILKEY')
            if flags: print(f'{p[len(root)+1:]}:{line} {flags} :: {arg.strip()[:220]!r}')
