// Runs test/crisis-router-not-breathing.spec.ts against a router copy (main or worktree head) with a tiny jest shim.
const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs=require('fs');const load=require(__dirname+'/loader.js');
const which=process.argv[2]; const WT='/home/user/workspace/wt/B-CRISIS2-123-2/';
const base= which==='main'? __dirname+'/main/' : which==='r1'? __dirname+'/r1/' : WT+'src/';
const mods={'../src/ai/ai-crisis-router':{classifyAiGuideCrisis:load(base+'ai/ai-crisis-router.ts','classifyAiGuideCrisis')},
 '../src/roman/guardrails/safety-router':{classifySafety:load(base+'roman/guardrails/safety-router.ts','classifySafety')}};
const out=ts.transpileModule(fs.readFileSync(WT+'test/crisis-router-not-breathing.spec.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
let pass=0,fail=0;let cur='';
const expect=(v)=>({toBe:(w)=>{if(v!==w)throw new Error(`got ${v} want ${w}`)},toBeNull:()=>{if(v!==null)throw new Error(`got ${v} want null`)},
 not:{toContain:(x)=>{if(v.includes(x))throw new Error(`contains ${x}`)}}});
const describe=(n,f)=>{cur=n;f();};
const it={each:(rows)=>(name,fn)=>{for(const r of rows){const t=name.replace('%s',r);try{fn(r);pass++;console.log('PASS '+cur+' > '+t);}catch(e){fail++;console.log('FAIL '+cur+' > '+t+' :: '+e.message);}}}};
new Function('require','exports','describe','it','expect',out)((id)=>mods[id],{},describe,it,expect);
console.log(`${which}: ${pass} passed, ${fail} failed, ${pass+fail} total`);
