import os,re,sys
d=os.path.join(sys.argv[1],'prisma/migrations')
dirs=sorted(x for x in os.listdir(d) if os.path.isdir(os.path.join(d,x)) and re.match(r'^\d{14}_',x))
sql=lambda x: open(os.path.join(d,x,'migration.sql')).read()
creates=lambda x: re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"',sql(x))
from collections import Counter
c=Counter(x[:14] for x in dirs); print('collisions',[k for k,v in c.items() if v>1])
mine=[x for x in dirs if x.endswith('_dunning_billing_actions')][0]
refs=set(re.findall(r'(?:REFERENCES|ALTER TABLE) "(\w+)"',sql(mine))); own=set(creates(mine))
bad=[]
for t in refs-own:
    by=[x for x in dirs if t in creates(x)]
    if not by or not all(x<mine for x in by): bad.append((t,by))
print('mine',mine,'own',sorted(own)); print('refs not earlier:',bad)
adds={'20270318000000_dunning_dispute_pause_effects'}
for x in dirs:
    if x>mine and x not in adds:
        for t in own:
            if f'"{t}"' in sql(x): print('LATER TOUCH',x,t)
print('after mine:',[x for x in dirs if x>mine])
