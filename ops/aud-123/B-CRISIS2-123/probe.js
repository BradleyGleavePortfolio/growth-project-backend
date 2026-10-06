const load=require(__dirname+'/loader.js');const fs=require('fs');
const WT='/home/user/workspace/wt/B-CRISIS2-123-1/src/';
const A0=load(__dirname+'/main/ai/ai-crisis-router.ts','classifyAiGuideCrisis'),A1=load(WT+'ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const R0=load(__dirname+'/main/roman/guardrails/safety-router.ts','classifySafety'),R1=load(WT+'roman/guardrails/safety-router.ts','classifySafety');
const rd=f=>fs.readFileSync(__dirname+'/'+f,'utf8').split('\n').map(s=>s.trim()).filter(Boolean);
let fail=0;
for(const [file,want] of [['crisis.txt','emergency'],['gym.txt',null]]){
 console.log('## '+file+' want '+want+'  (AI head | AI main | Roman head | Roman main)');
 for(const s of rd(file)){const a=A1(s),a0=A0(s),r=R1(s).class,r0=R0(s).class;
  const ok= want===null ? (a===null && r!=='emergency' && r!=='self_harm') : (a===want && r===want);
  if(!ok)fail++; console.log((ok?'ok  ':'FAIL')+' '+[a,a0,r,r0].map(x=>String(x).padEnd(16)).join('')+'| '+s);}
}
console.log('failures',fail);
