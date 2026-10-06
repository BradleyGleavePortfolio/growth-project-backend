const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs'); const cp=require('child_process');
function load(f,fn){const src=fs.readFileSync(f,'utf8');const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const m={exports:{}};new Function('module','exports',out)(m,m.exports);return m.exports[fn];}
const WT='/home/user/workspace/wt/B-AIG4-123/';
const A1=load(__dirname+'/ai-router-main-e6f9a5ec.ts','classifyAiGuideCrisis'),A2=load(WT+'src/ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const R1=load(__dirname+'/roman-router-main-e6f9a5ec.ts','classifySafety'),R2=load(WT+'src/roman/guardrails/safety-router.ts','classifySafety');
const files=cp.execSync(`git -C ${WT} ls-files test src`).toString().split('\n').filter(f=>/\.(ts|js)$/.test(f));
const strs=new Set();
for(const f of files){const t=fs.readFileSync(WT+f,'utf8');for(const m of t.matchAll(/'([^'\n\\]{6,300})'|"([^"\n\\]{6,300})"|`([^`\n\\$]{6,300})`/g))strs.add(m[1]||m[2]||m[3]);}
let n=0;for(const s of strs){const a1=A1(s),a2=A2(s),r1=R1(s).class,r2=R2(s).class;if(a1!==a2||r1!==r2){n++;console.log(`AI ${a1}->${a2} | Roman ${r1}->${r2} | ${s}`);}}
console.log('strings',strs.size,'changed',n);
