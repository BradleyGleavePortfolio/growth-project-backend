#!/usr/bin/env python3
# Usage: deps.py <worktree> <base-ref> <plan.json>   plan = {"path": piece_int, ...} for src files (tests auto-assigned if absent)
# Prints: src dependency violations, auto piece for each test, and piece sizes.
import json, os, re, subprocess, sys
wt, base, planf = sys.argv[1:4]
head = sys.argv[4] if len(sys.argv)>4 else 'HEAD'
plan = json.load(open(planf))
num = subprocess.run(['git','-C',wt,'diff','--numstat',base,head],capture_output=True,text=True).stdout.split('\n')
size = {}
for l in num:
    if not l.strip(): continue
    a,d,p = l.split('\t'); size[p] = (0 if a=='-' else int(a)) + (0 if d=='-' else int(d))
changed = set(size)
def imports(p):
    if not (p.endswith('.ts') or p.endswith('.tsx')): return []
    src = subprocess.run(['git','-C',wt,'show',f'{head}:{p}'],capture_output=True,text=True)
    if src.returncode: return []
    out=[]
    for m in re.finditer(r"from\s+['\"](\.[^'\"]+)['\"]", src.stdout):
        tgt = os.path.normpath(os.path.join(os.path.dirname(p), m.group(1)))
        for cand in (tgt+'.ts', tgt+'.tsx', tgt+'/index.ts', tgt+'/index.tsx'):
            if cand in changed: out.append(cand)
    return out
piece = dict(plan)
# iterate to fixpoint: unassigned files get max(piece of imports) (min 1)
for _ in range(10):
    for p in sorted(changed):
        if p in plan: continue
        deps = [piece.get(i) for i in imports(p)]
        deps = [x for x in deps if x]
        piece[p] = max(deps) if deps else piece.get(p, 1)
viol=[]
for p in changed:
    for i in imports(p):
        if piece.get(i,0) > piece.get(p,0): viol.append(f"{p} (piece {piece.get(p)}) imports {i} (piece {piece.get(i)})")
print("VIOLATIONS:" , len(viol)); [print("  "+v) for v in viol]
tot={}
for p in changed: tot[piece.get(p,1)] = tot.get(piece.get(p,1),0)+size[p]
print("SIZES:", dict(sorted(tot.items())))
for k in sorted(set(piece.values())):
    print(f"--- piece {k}"); [print(f"  {size[p]:5d} {p}") for p in sorted(changed, key=lambda x:-size[x]) if piece.get(p)==k]
json.dump({p:piece[p] for p in changed}, open(planf.replace('.json','.resolved.json'),'w'), indent=1)
