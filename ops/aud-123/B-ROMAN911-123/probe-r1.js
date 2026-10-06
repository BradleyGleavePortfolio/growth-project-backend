const load=require(__dirname+'/loader.js');const fs=require('fs');
const WT='/home/user/workspace/wt/B-ROMAN911-123/src/';
const A0=load(__dirname+'/cda/ai/ai-crisis-router.ts','classifyAiGuideCrisis'),A1=load(WT+'ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const R0=load(__dirname+'/cda/roman/guardrails/safety-router.ts','classifySafety'),R1=load(WT+'roman/guardrails/safety-router.ts','classifySafety');
const RM=load(__dirname+'/roman-router-main-5230306c.ts','classifySafety');
const rd=f=>fs.readFileSync(__dirname+'/'+f,'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
let fail=0;
for(const [file,want] of [['r1-911.txt','emergency'],['r1-988.txt','self_harm'],['r1-normal.txt',null]]){
 console.log('## '+file+' want '+want+'  (AI head | AI cda | Roman head | Roman cda | Roman main)');
 for(const s of rd(file)){const a=A1(s),a0=A0(s),r=R1(s).class,r0=R0(s).class,rm=RM(s).class;
  const ok= want===null ? (a===null && r!=='emergency' && r!=='self_harm') : (a===want && r===want);
  if(!ok)fail++; console.log((ok?'ok  ':'FAIL')+' '+[a,a0,r,r0,rm].map(x=>String(x).padEnd(18)).join('')+'| '+s);}
}
console.log('failures',fail);
