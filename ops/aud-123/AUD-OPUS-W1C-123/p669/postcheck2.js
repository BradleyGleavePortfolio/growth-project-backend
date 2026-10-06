const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs'); const path=require('path');
require.extensions['.ts'] = (m, f) => { m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:1,target:9,esModuleInterop:true}}).outputText, f); };
const CONTEXT = { targets:{source:'coach_set',calories:2000,protein_g:120,carbs_g:200,fat_g:60},
 today:{kcal:780,protein_g:60,carbs_g:70,fat_g:25,meals_logged:2,remaining_kcal:1220,remaining_protein_g:60,remaining_carbs_g:130,remaining_fat_g:35,pct_kcal:39,pct_protein:50},
 last_7_days:{days_logged:5,avg_kcal_on_logged_days:1850,avg_protein_g_on_logged_days:100,days_within_10pct_kcal:3},
 macro_method:{floor_kcal:1200}, coach:{has_coach:true,coach_first_name:'Alex'}, kcal_facts:{intake_entries_today:[330,450], intake_past_days:[1900], meal_plan:[500,700,600]} };
const texts = ['Your planned meals add up to 1,800 kcal.','The meals in your plan add up to 1,800 kcal.','Your meal plan has three meals that add up to 1,800 kcal.','Aim for meals that add up to 2,000 kcal a day.','Three meals of 600 kcal add up to 1,800 kcal.','Yesterday your meals added up to 1,900 kcal.','Your meals averaged 1,850 kcal over the last 7 days.','Your remaining meals should add up to 1,220 kcal.','Your remaining meals can add up to about 1,220 kcal.','The rest of your meals today should come to 1,220 kcal.','Your meals add up to 780 kcal, so 1,220 kcal remain.'];
const res={};
for (const s of ['ef71cb9c','31573c83']) { const pc = require(path.join(__dirname,'tree-'+s,'src/roman/guardrails/roman-post-check.ts')); res[s]=texts.map(t=>pc.postCheckRomanReply(t,{routerClass:'normal',context:CONTEXT})); }
const f=r=>(r.rewritten?'REJECT':'pass')+(r.guardrails_applied.length?':'+r.guardrails_applied.join(','):'');
texts.forEach((t,i)=>{const a=f(res.ef71cb9c[i]),b=f(res['31573c83'][i]); console.log(('old='+a).padEnd(30)+('new='+b).padEnd(30)+(a!==b?'CHANGED ':'        ')+JSON.stringify(t));});
