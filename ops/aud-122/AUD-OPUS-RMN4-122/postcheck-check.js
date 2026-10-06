const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs'); const path=require('path');
require.extensions['.ts'] = (m, f) => { m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:1,target:9,esModuleInterop:true}}).outputText, f); };
const CONTEXT = { targets:{source:'coach_set',calories:2000,protein_g:120,carbs_g:200,fat_g:60},
 today:{kcal:780,protein_g:60,carbs_g:70,fat_g:25,meals_logged:2,remaining_kcal:1220,remaining_protein_g:60,remaining_carbs_g:130,remaining_fat_g:35,pct_kcal:39,pct_protein:50},
 last_7_days:{days_logged:0,avg_kcal_on_logged_days:null,avg_protein_g_on_logged_days:null,days_within_10pct_kcal:null},
 macro_method:{floor_kcal:1200}, coach:{has_coach:true,coach_first_name:'Alex'}, kcal_facts:{intake_entries_today:[330,450]} };
const texts = [
 'You have logged 450 kcal today across two meals.','Your total intake today is 450 kcal from your meals.',
 'You have logged 780 kcal today across two meals.','Your total intake today is 780 kcal from your meals.','You logged 450 kcal at lunch today.','You have logged 780 kcal today.','Breakfast was 330 kcal.',
 // extra normal phrasings
 'Lunch today was 450 kcal, which brings you to 780 kcal so far.','Your lunch today came in at 450 kcal.','So far today you are at 780 kcal.','You are at 450 kcal today.','Your breakfast today was 330 kcal and lunch was 450 kcal.','Today you logged a 450 kcal lunch and a 330 kcal breakfast, 780 kcal in total.',
];
for (const s of ['fefe73c6','ef71cb9c']) {
  const pc = require(path.join(__dirname,'tree-'+s,'src/roman/guardrails/roman-post-check.ts'));
  console.log('== '+s);
  for (const t of texts) { const r = pc.postCheckRomanReply(t,{routerClass:'normal',context:CONTEXT}); console.log(String(r.rewritten).padEnd(6), JSON.stringify(r.guardrails_applied).padEnd(24), JSON.stringify(t)); }
}
