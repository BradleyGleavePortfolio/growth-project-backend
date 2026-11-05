#!/usr/bin/env python3
"""Record saved answers for test/food-score.
usda: each row's USDA search answer is taken from our own USDA catalog file, prisma/data/usda-foods.jsonl.gz (b#1212,
  built from USDA's public SR Legacy and Foundation downloads), not from USDA's service: the catalog foods the app's
  catalog search (FoodService.searchCatalog) finds for the typed words, in its order, first 20 (the pageSize search
  asks for), written in FoodData Central's search answer shape (what searchUSDA reads). No network call, no key.
off: Open Food Facts, one real call per URL, never a retry loop.
usage: python3 test/food-score/record.py usda | off <limit-of-new-calls> [min_seconds_between_calls]"""
import json, sys, os, re, gzip, hashlib, subprocess, time, datetime, urllib.parse
WT=os.path.dirname(os.path.abspath(__file__))
ANS=WT+'/answers'
CATALOG=os.path.join(WT,'..','..','prisma','data','usda-foods.jsonl.gz')
rows=json.load(open(WT+'/foods.json'))['rows']
which=sys.argv[1]; budget=int(sys.argv[2]) if len(sys.argv)>2 else len(rows); gap=float(sys.argv[3]) if len(sys.argv)>3 else 4
UA='TheGrowthProject/1.0'
BR="const z=require('zlib'),fs=require('fs');const b=fs.readFileSync(process.argv[1]);const c=z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11,[z.constants.BROTLI_PARAM_LGWIN]:24,[z.constants.BROTLI_PARAM_SIZE_HINT]:b.length}});if(Buffer.compare(z.brotliDecompressSync(c),b))process.exit(3);fs.writeFileSync(process.argv[2],c);"
def url_for(q):
    e=urllib.parse.quote(q, safe="-_.!~*'()")  # same set encodeURIComponent leaves alone
    if which=='usda': return f'https://api.nal.usda.gov/fdc/v1/foods/search?query={e}&pageSize=20'
    return f'https://world.openfoodfacts.org/cgi/search.pl?search_terms={e}&search_simple=1&action=process&json=1&page_size=20'
def fold(w):  # food.service.ts words(): a plain plural folded ("eggs" -> "egg")
    if len(w)<=3: return w
    if w.endswith('ies'): return w[:-3]+'y'
    if w.endswith('oes'): return w[:-2]
    return w[:-1] if w.endswith('s') and not w.endswith('ss') else w
def wl(t): return [fold(w) for w in re.findall(r'[^\W_]+', t.lower())]
def catalog_answer(q, foods):
    """searchCatalog's match and ORDER BY over the catalog file: every typed word a whole word of the name (0), the
    last one the start of a word (1), or the name contains the typed text (2); then the name's first comma part holding
    the first word; then shorter names, A-Z. Postgres's English stemmer is read as the app's plural fold here."""
    qw=wl(q)[:8]; hits=[]
    for f in foods:
        nw=wl(f['name'])
        if qw and all(w in nw for w in qw): m=0
        elif qw and all(w in nw for w in qw[:-1]) and any(n.startswith(qw[-1]) for n in nw): m=1
        elif q.lower() in f['name'].lower(): m=2
        else: continue
        lead=0 if qw and any(n.startswith(qw[0]) for n in wl(f['name'].split(',')[0])) else 1
        hits.append(((m, lead, len(f['name']), f['name'], f['fdc_id']), f))
    hits.sort(key=lambda h: h[0])
    def nut(name, unit, v): return [] if v is None else [dict(nutrientName=name, unitName=unit, value=v)]
    out=[dict(fdcId=f['fdc_id'], description=f['name'], dataType=f['data_type'], foodCategory=f['usda_category'],
        foodNutrients=nut('Energy','KCAL',f['calories'])+nut('Protein','G',f['protein_g'])+
            nut('Carbohydrate, by difference','G',f['carbs_g'])+nut('Total lipid (fat)','G',f['fat_g'])+
            nut('Fiber, total dietary','G',f['fiber_g'])+nut('Sugars, total including NLEA','G',f['sugar_g'])+
            nut('Sodium, Na','MG',f['sodium_mg'])) for _, f in hits[:20]]
    return json.dumps(dict(totalHits=len(hits), foods=out), separators=(',',':')).encode()
idx_path=ANS+'/index.json'
idx=json.load(open(idx_path)) if os.path.exists(idx_path) else {}
done=0
if which=='usda':
    gz=open(CATALOG,'rb').read()
    foods=[json.loads(l) for l in gzip.decompress(gz).decode().split('\n')[1:] if l]
for r in rows:
    u=url_for(r['typed'])
    if u in idx: continue
    if done>=budget: break
    hdr='/tmp/food-score-h.txt'; body='/tmp/food-score-b.bin'; done+=1
    if which=='usda':
        open(body,'wb').write(catalog_answer(r['typed'], foods)); status=200; H={'content-type':'application/json'}
        print(r['typed'], 'catalog', os.path.getsize(body), flush=True)
    else:
        p=subprocess.run(['curl','-s','-m','60','-D',hdr,'-o',body,'-H','User-Agent: '+UA,u],capture_output=True)
        h=open(hdr,encoding='latin-1').read().replace('\r','')
        blocks=[b for b in h.split('\n\n') if b.strip()]
        last=blocks[-1].splitlines() if blocks else ['HTTP/0 0']
        status=int(last[0].split()[1])
        H={l.split(':',1)[0].lower():l.split(':',1)[1].strip() for l in last[1:] if ':' in l}
        print(r['typed'], status, os.path.getsize(body), flush=True)
        if status==429:
            print('429: not saved; stopping'); break
    data=open(body,'rb').read()
    sha=hashlib.sha256(data).hexdigest()
    os.makedirs(ANS+'/bodies',exist_ok=True)
    bf=f'bodies/{sha[:16]}.br'
    raw=f'/tmp/food-score-raw-{sha[:16]}'
    open(raw,'wb').write(data)
    # Stored brotli-compressed, byte for byte (the test decompresses and checks body_sha256).
    if not os.path.exists(ANS+'/'+bf): subprocess.run(['node','-e',BR,raw,ANS+'/'+bf],check=True)
    idx[u]=dict(method='GET', url=u, request_headers={'User-Agent':UA},
        recorded_at=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        status=status, content_type=H.get('content-type'), body_file=bf, body_encoding='br', body_sha256=sha, body_bytes=len(data))
    if which=='usda':
        del idx[u]['request_headers']
        idx[u]['from_catalog']='prisma/data/usda-foods.jsonl.gz sha256 '+hashlib.sha256(gz).hexdigest()+'; no call to USDA'
    json.dump(dict(sorted(idx.items())), open(idx_path,'w'), indent=1); open(idx_path,'a').write('\n')
    if which=='off': time.sleep(gap)
# A row is recorded once both of its requests have a saved answer.
doc=json.load(open(WT+'/foods.json'))
def enc(q): return urllib.parse.quote(q, safe="-_.!~*'()")
for r in doc['rows']:
    r['recorded']=(f"https://api.nal.usda.gov/fdc/v1/foods/search?query={enc(r['typed'])}&pageSize=20" in idx and
        f"https://world.openfoodfacts.org/cgi/search.pl?search_terms={enc(r['typed'])}&search_simple=1&action=process&json=1&page_size=20" in idx)
json.dump(doc, open(WT+'/foods.json','w'), indent=1); open(WT+'/foods.json','a').write('\n')
print('recorded rows', sum(r['recorded'] for r in doc['rows']), 'of', len(doc['rows']))
