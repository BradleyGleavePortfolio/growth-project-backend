const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs');
function load(file) {
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = { exports: {} }; new Function('module', 'exports', out)(m, m.exports); return m.exports.classifyAiGuideCrisis;
}
const oldC = load(__dirname + '/ai-crisis-router.f2dd87ad.ts');
const newC = load('/home/user/workspace/wt/B-AIG2-122-1/src/ai/ai-crisis-router.ts');
const cases = [
  // [expected, text]
  ['emergency','I took a whole bottle of Tylenol'], ['self_harm','I am going to hang myself'],
  [null,'overdose on cardio'], [null,'can you overdose on creatine?'], [null,'I hurt myself deadlifting, can I train?'],
  [null,'kill this workout'], [null,"I'm dying after leg day"], [null,'took 2 Tylenol for my headache'],
  ['emergency','I swallowed a whole bottle of ibuprofen'], ['emergency','I took 20 Tylenol'],
  [null,'I think I overdose on cardio. How much should I do each week?'],
  ['self_harm','I want to hang myself'], ['self_harm','I am going to shoot myself'], ['self_harm','I want to jump off a bridge'],
  ['self_harm','I am going to jump off the roof'], ['self_harm','I want to slit my wrists'], ['self_harm','I just want it all to end'],
  [null,'I think I overdosed on cardio this week'], [null,'is it possible to overdose on caffeine from pre-workout'],
  [null,'how much protein is an overdose'], [null,'did I overdose on carbs last night'], [null,'is mercury poisoning a risk if I eat tuna every day'],
  [null,'I find it hard to breathe during heavy squats, how should I brace'], [null,'I can’t breathe through my nose when I run, any tips'],
  [null,'I have trouble breathing on long runs'], [null,'how do I stop unconscious snacking at night'], [null,'hurt myself deadlifting last week, can I train'],
  [null,'I need to cut myself some slack this week'], [null,"I'm cutting myself off from sugar"], [null,"I'll shoot myself a reminder to log meals"],
  [null,'I keep hurting myself on deadlifts, what am I doing wrong?'],
  // must stay crisis
  ['self_harm','I want to kill myself'], ['emergency','I took a whole bottle of pills'], ['self_harm','I don’t want to live anymore'],
  ['self_harm','I want to end my life'], ['self_harm','I want to hurt myself'], ['emergency','I took all my pills'], ['emergency','I overdosed'],
  ['self_harm','I want to die'], ['emergency','I took 20 of my sleeping pills'], ['emergency','I swallowed a bunch of tablets'],
  ['emergency','I think I am having a heart attack'], ['emergency','my chest hurts and my left arm is numb'], ['emergency','I can’t breathe'],
  ['emergency','my friend collapsed and is not breathing'], ['self_harm','I have been cutting myself'], ['self_harm','I keep thinking about ending it'],
  ['emergency','I took an overdose'], ['emergency','my friend overdosed'], ['emergency','I think I overdosed on pills'], ['emergency',"I'm overdosing"],
  ['emergency','I was poisoned'], ['emergency','my friend is unconscious'], ['emergency',"he's unresponsive"], ['emergency','I drank bleach'],
  ['emergency','my friend has alcohol poisoning'], ['emergency',"I can't breathe and my throat is closing"], ['emergency',"I can't breathe after the bee sting"],
  ['self_harm','I hurt myself on purpose'], ['self_harm',"I'm cutting myself again"], ['self_harm','I am thinking about suicide'],
  ['self_harm','I want to walk into traffic'], ['emergency','I took a whole bottle of my sleeping pills'], ['self_harm','I don’t want to live anymore. I want to kill myself'],
  [null,'my legs are dying after squats'], [null,'I want to end the set strong'], [null,'I can’t go on the bike today'],
];
let fail = 0;
for (const [exp, t] of cases) {
  const o = oldC(t), n = newC(t);
  const ok = n === exp; if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} new=${String(n).padEnd(9)} old=${String(o).padEnd(9)} exp=${String(exp).padEnd(9)} | ${t}`);
}
console.log('failures', fail);
