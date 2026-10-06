const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs');
const load=require(__dirname+'/loader.js');
const WT='/home/user/workspace/wt/B-ROMAN911-123/src/';
const AI_OLD=load(__dirname+'/ai-router-main-5230306c.ts','classifyAiGuideCrisis');
const AI_NEW=load(WT+'ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const RO_OLD_F=load(__dirname+'/roman-router-main-5230306c.ts','classifySafety');const RO_OLD=(s)=>RO_OLD_F(s).class;
const RO_NEW_F=load(WT+'roman/guardrails/safety-router.ts','classifySafety');const RO_NEW=(s)=>RO_NEW_F(s).class;
const gym=fs.readFileSync(__dirname+'/gym-phrases.txt','utf8').split('\n').map(s=>s.trim()).filter(Boolean);
const crisis=fs.readFileSync(__dirname+'/crisis-phrases.txt','utf8').split('\n').map(s=>s.trim()).filter(Boolean);
const SC=new Set(['emergency','self_harm']);
let fail=0;
console.log('## gym talk must not route (AI new | AI main | Roman new | Roman main | message)');
for(const s of gym){const a=AI_NEW(s),ao=AI_OLD(s),r=RO_NEW(s),ro=RO_OLD(s);const ok=a===null&&!SC.has(r);if(!ok)fail++;console.log((ok?'ok  ':'FAIL')+' '+[a,ao,r,ro].map(x=>String(x).padEnd(21)).join('')+'| '+s);}
console.log('## crisis must route on both');
for(const s of crisis){const a=AI_NEW(s),ao=AI_OLD(s),r=RO_NEW(s),ro=RO_OLD(s);const ok=a!==null&&SC.has(r);if(!ok)fail++;console.log((ok?'ok  ':'FAIL')+' '+[a,ao,r,ro].map(x=>String(x).padEnd(21)).join('')+'| '+s);}
console.log('failures',fail);
