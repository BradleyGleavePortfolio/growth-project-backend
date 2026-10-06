const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs');
function load(f,fn){const src=fs.readFileSync(f,'utf8');const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const m={exports:{}};new Function('module','exports',out)(m,m.exports);return m.exports[fn];}
const WT='/home/user/workspace/wt/B-AIG4-123/src/';
const A=load(WT+'ai/ai-crisis-router.ts','classifyAiGuideCrisis');
const R=load(WT+'roman/guardrails/safety-router.ts','classifySafety');
for(const s of ["I'm going to take 400 mg ibuprofen before my run",'I want to take 5 mg melatonin tonight','I want to take 10mg of my meds','how many pills should I take','I want to take many supplements','I want to take all my supplements at once','I am going to take all my vitamins with breakfast',"I'm going to take all my pills with breakfast",'I might take 2 Advil','should I take all of my pre-workout','I want to take all my creatine','I need to take all my meds today','I want to take a few pills for my headache','I am going to take my medication before training'])
 console.log(String(A(s)).padEnd(10), R(s).class.padEnd(16), '|', s);
