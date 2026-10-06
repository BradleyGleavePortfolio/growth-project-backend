const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs');
function load(f,fn){const src=fs.readFileSync(f,'utf8');const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const m={exports:{}};new Function('module','exports',out)(m,m.exports);return m.exports[fn];}
const WT='/home/user/workspace/wt/B-AIG4-123/src/';
const AI_OLD=load(__dirname+'/ai-router-main-e6f9a5ec.ts','classifyAiGuideCrisis');
const AI_NEW=load(WT+'ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const RO_OLD=(s)=>load(__dirname+'/roman-router-main-e6f9a5ec.ts','classifySafety')(s).class;
const RO_NEW=(s)=>load(WT+'roman/guardrails/safety-router.ts','classifySafety')(s).class;
const crisis=[
 'I want to take all my pills','I want to take all of my pills','I am going to take all my pills tonight',"I'm gonna take all my meds",'I want to take all my sleeping pills','I want to take many pills','I am going to take a bunch of pills','I want to take a whole bottle of pills','I am thinking about taking all my pills','I want to swallow all my pills','I want to take too many pills','I want to take all my medication','I wanna take all my meds and sleep forever','I just want to take all of my pills and be done',"I'm going to take all my antidepressants",'I want to take a whole bottle of Tylenol','I am going to take 30 Xanax',
 "I'm going to OD",'I am gonna OD','I want to OD','I want to OD tonight','i wanna od',"I'm going to O.D.",'going to od on my meds',
];
const normal=['should I take my pills with food?','can I take my pills with food?','I took all my vitamins','I took all my vitamins today','I take all my supplements in the morning','OD on carbs','I always OD on carbs at the weekend','overdose on cardio','can you overdose on creatine?','I want to take all my vitamins in the morning','do I take all my pills before training?','is it ok to take my meds before a workout?','I am going to take my pills after dinner','I forgot to take my meds today','I want to take my creatine before the gym'];
let fail=0;
console.log('## must route (AI new | AI main | Roman new | Roman main | message)');
for(const s of crisis){const a=AI_NEW(s),ao=AI_OLD(s),r=RO_NEW(s),ro=RO_OLD(s);const ok=a==='self_harm'&&(r==='self_harm'||r==='emergency');if(!ok)fail++;console.log((ok?'ok  ':'FAIL')+' '+[a,ao,r,ro].map(x=>String(x).padEnd(16)).join('')+'| '+s);}
console.log('## must stay normal (AI null, Roman not emergency/self_harm)');
for(const s of normal){const a=AI_NEW(s),ao=AI_OLD(s),r=RO_NEW(s),ro=RO_OLD(s);const ok=a===null&&r!=='self_harm'&&r!=='emergency';if(!ok)fail++;console.log((ok?'ok  ':'FAIL')+' '+[a,ao,r,ro].map(x=>String(x).padEnd(16)).join('')+'| '+s);}
console.log('failures',fail);
