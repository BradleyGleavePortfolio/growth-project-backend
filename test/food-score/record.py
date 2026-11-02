#!/usr/bin/env python3
"""Record saved answers for test/food-score. One real call per URL, never a retry loop.
USDA: DEMO_KEY only, stop when x-ratelimit-remaining reaches 0. The key never reaches a saved file.
usage: python3 test/food-score/record.py usda|off <limit-of-new-calls> [min_seconds_between_calls]"""
import json, sys, os, hashlib, subprocess, time, datetime, urllib.parse
WT=os.path.dirname(os.path.abspath(__file__))
ANS=WT+'/answers'
rows=json.load(open(WT+'/foods.json'))['rows']
which=sys.argv[1]; budget=int(sys.argv[2]); gap=float(sys.argv[3]) if len(sys.argv)>3 else 4
UA='TheGrowthProject/1.0'
BR="const z=require('zlib'),fs=require('fs');const b=fs.readFileSync(process.argv[1]);const c=z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11,[z.constants.BROTLI_PARAM_LGWIN]:24,[z.constants.BROTLI_PARAM_SIZE_HINT]:b.length}});if(Buffer.compare(z.brotliDecompressSync(c),b))process.exit(3);fs.writeFileSync(process.argv[2],c);"
def url_for(q):
    e=urllib.parse.quote(q, safe="-_.!~*'()")  # same set encodeURIComponent leaves alone
    if which=='usda': return f'https://api.nal.usda.gov/fdc/v1/foods/search?query={e}&pageSize=20'
    return f'https://world.openfoodfacts.org/cgi/search.pl?search_terms={e}&search_simple=1&action=process&json=1&page_size=20'
idx_path=ANS+'/index.json'
idx=json.load(open(idx_path)) if os.path.exists(idx_path) else {}
done=0
for r in rows:
    u=url_for(r['typed'])
    if u in idx: continue
    if done>=budget: break
    real=u+('&api_key=DEMO_KEY' if which=='usda' else '')
    hdr='/tmp/food-score-h.txt'; body='/tmp/food-score-b.bin'
    p=subprocess.run(['curl','-s','-m','60','-D',hdr,'-o',body,'-H','User-Agent: '+UA,real],capture_output=True)
    done+=1
    h=open(hdr,encoding='latin-1').read().replace('\r','')
    blocks=[b for b in h.split('\n\n') if b.strip()]
    last=blocks[-1].splitlines() if blocks else ['HTTP/0 0']
    status=int(last[0].split()[1])
    H={l.split(':',1)[0].lower():l.split(':',1)[1].strip() for l in last[1:] if ':' in l}
    rem=H.get('x-ratelimit-remaining')
    print(r['typed'], status, os.path.getsize(body), 'remaining', rem, flush=True)
    if status==429:
        print('429: not saved; stopping'); break
    data=open(body,'rb').read()
    if which=='usda': assert b'api_key' not in data  # our key never echoed back
    sha=hashlib.sha256(data).hexdigest()
    os.makedirs(ANS+'/bodies',exist_ok=True)
    bf=f'bodies/{sha[:16]}.br'
    raw=f'/tmp/food-score-raw-{sha[:16]}'
    open(raw,'wb').write(data)
    # Stored brotli-compressed, byte for byte (the test decompresses and checks body_sha256).
    subprocess.run(['node','-e',BR,raw,ANS+'/'+bf],check=True)
    idx[u]=dict(method='GET', url=u, request_headers={'User-Agent':UA},
        key_note='USDA call made with api_key=DEMO_KEY; the key is stripped here' if which=='usda' else None,
        recorded_at=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        status=status, content_type=H.get('content-type'), body_file=bf, body_encoding='br', body_sha256=sha, body_bytes=len(data))
    if idx[u]['key_note'] is None: del idx[u]['key_note']
    json.dump(dict(sorted(idx.items())), open(idx_path,'w'), indent=1); open(idx_path,'a').write('\n')
    if rem is not None and int(rem)<=0: print('rate limit at 0; stopping'); break
    time.sleep(gap)
# A row is recorded once both of its requests have a saved answer.
doc=json.load(open(WT+'/foods.json'))
def enc(q): return urllib.parse.quote(q, safe="-_.!~*'()")
for r in doc['rows']:
    r['recorded']=(f"https://api.nal.usda.gov/fdc/v1/foods/search?query={enc(r['typed'])}&pageSize=20" in idx and
        f"https://world.openfoodfacts.org/cgi/search.pl?search_terms={enc(r['typed'])}&search_simple=1&action=process&json=1&page_size=20" in idx)
json.dump(doc, open(WT+'/foods.json','w'), indent=1); open(WT+'/foods.json','a').write('\n')
print('recorded rows', sum(r['recorded'] for r in doc['rows']), 'of', len(doc['rows']))
