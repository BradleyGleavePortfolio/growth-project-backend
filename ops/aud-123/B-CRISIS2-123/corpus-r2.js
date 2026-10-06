const fs = require('fs'); const cp=require('child_process');
const load=require(__dirname+'/loader.js');
const WT='/home/user/workspace/wt/B-CRISIS2-123-2/';
const A1=load(__dirname+'/main/ai/ai-crisis-router.ts','classifyAiGuideCrisis'),A2=load(WT+'src/ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const R1=load(__dirname+'/main/roman/guardrails/safety-router.ts','classifySafety'),R2=load(WT+'src/roman/guardrails/safety-router.ts','classifySafety');
const files=cp.execSync(`git -C ${WT} ls-files test src`).toString().split('\n').filter(f=>/\.(ts|js)$/.test(f));
const strs=new Set();
for(const f of files){if(!fs.existsSync(WT+f))continue;const t=fs.readFileSync(WT+f,'utf8');for(const m of t.matchAll(/'([^'\n\\]{6,300})'|"([^"\n\\]{6,300})"|`([^`\n\\$]{6,300})`/g))strs.add(m[1]||m[2]||m[3]);}
const P='/home/user/workspace/ops/aud-123/B-ROMAN911-123/';
for(const f of ['crisis-phrases.txt','gym-phrases.txt','r1-911.txt','r1-988.txt','r1-normal.txt'])for(const s of fs.readFileSync(P+f,'utf8').split('\n').map(x=>x.trim()).filter(Boolean))strs.add(s);
let n=0;for(const s of strs){const a1=A1(s),a2=A2(s),r1=R1(s).class,r2=R2(s).class;if(a1!==a2||r1!==r2){n++;console.log(`AI ${a1}->${a2} | Roman ${r1}->${r2} | ${s}`);}}
console.log('strings',strs.size,'changed',n);
