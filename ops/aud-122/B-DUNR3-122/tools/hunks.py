import re,sys
def parse(path):
    lines=open(path).read().split('\n')
    out=[];hunks=[];i=0
    while i<len(lines):
        l=lines[i]
        if l.startswith('<<<<<<< '):
            o=[];b=[];t=[];st='o';i+=1
            while not lines[i].startswith('>>>>>>> '):
                x=lines[i]
                if x.startswith('||||||| '): st='b'
                elif x=='=======' : st='t'
                else: {'o':o,'b':b,'t':t}[st].append(x)
                i+=1
            hunks.append((o,b,t)); out.append(len(hunks)-1)
        else: out.append(l)
        i+=1
    return out,hunks
def write(path,out,hunks,res):
    r=[]
    for x in out:
        if isinstance(x,int):
            v=res[x+1]
            o,b,t=hunks[x]
            if v=='ours': r+=o
            elif v=='theirs': r+=t
            elif v=='ot': r+=o+t
            elif v=='to': r+=t+o
            else: r+=v.split('\n') if v!='' else []
        else: r.append(x)
    open(path,'w').write('\n'.join(r))
