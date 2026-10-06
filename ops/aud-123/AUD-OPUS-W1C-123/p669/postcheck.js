const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs'); const path=require('path');
require.extensions['.ts'] = (m, f) => { m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:1,target:9,esModuleInterop:true}}).outputText, f); };
const CONTEXT = { targets:{source:'coach_set',calories:2000,protein_g:120,carbs_g:200,fat_g:60},
 today:{kcal:780,protein_g:60,carbs_g:70,fat_g:25,meals_logged:2,remaining_kcal:1220,remaining_protein_g:60,remaining_carbs_g:130,remaining_fat_g:35,pct_kcal:39,pct_protein:50},
 last_7_days:{days_logged:0,avg_kcal_on_logged_days:null,avg_protein_g_on_logged_days:null,days_within_10pct_kcal:null},
 macro_method:{floor_kcal:1200}, coach:{has_coach:true,coach_first_name:'Alex'}, kcal_facts:{intake_entries_today:[330,450]} };
const texts = [
 '## prior RMN4 set (13)',
 'You have logged 450 kcal today across two meals.','Your total intake today is 450 kcal from your meals.',
 'You have logged 780 kcal today across two meals.','Your total intake today is 780 kcal from your meals.','You logged 450 kcal at lunch today.','You have logged 780 kcal today.','Breakfast was 330 kcal.',
 'Lunch today was 450 kcal, which brings you to 780 kcal so far.','Your lunch today came in at 450 kcal.','So far today you are at 780 kcal.','You are at 450 kcal today.','Your breakfast today was 330 kcal and lunch was 450 kcal.','Today you logged a 450 kcal lunch and a 330 kcal breakfast, 780 kcal in total.',
 '## B-669-1 (should be rejected at new head)',
 'Your meals add up to 450 kcal.','You have logged 450 kcal across two meals.','You logged 450 kcal across breakfast and lunch.','Your two meals come to 450 kcal.',
 '## correct replies, no "today", aggregate word present (should pass)',
 'Your meals add up to 780 kcal.','You have logged 780 kcal across two meals.','You logged 780 kcal across breakfast and lunch.',
 'You logged 450 kcal at lunch, the biggest of your two meals.','Of your meals, lunch was the largest at 450 kcal.',
 'You logged 330 kcal at breakfast and 450 kcal at lunch, 780 kcal combined.','You logged 330 kcal at breakfast and 450 kcal at lunch, for 780 kcal altogether.',
 'Across your two meals, lunch was 450 kcal and breakfast was 330 kcal.','You logged a 450 kcal lunch and a 330 kcal breakfast.','Your lunch was 450 kcal.','You logged 450 kcal at lunch.','Lunch was 450 kcal, so you have 1,220 kcal left today.',
 'Of all your meals so far, lunch was 450 kcal.','You logged 450 kcal at lunch and no snacks.','Your snacks were light, and lunch was 450 kcal.',
];
const res={};
for (const s of ['ef71cb9c','31573c83']) {
  const pc = require(path.join(__dirname,'tree-'+s,'src/roman/guardrails/roman-post-check.ts'));
  res[s]=texts.map(t=>t.startsWith('##')?null:pc.postCheckRomanReply(t,{routerClass:'normal',context:CONTEXT}));
}
texts.forEach((t,i)=>{ if(t.startsWith('##')){console.log(t);return;} const a=res.ef71cb9c[i],b=res['31573c83'][i]; const f=r=>(r.rewritten?'REJECT':'pass')+(r.guardrails_applied.length?':'+r.guardrails_applied.join(','):''); console.log(('old='+f(a)).padEnd(30)+('new='+f(b)).padEnd(30)+(f(a)!==f(b)?'CHANGED ':'        ')+JSON.stringify(t)); });
