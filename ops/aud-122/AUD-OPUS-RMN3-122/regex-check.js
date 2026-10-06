const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/safety-router.8cfad607.ts', 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} }; new Function('module', 'exports', js)(m, m.exports);
const { classifySafety } = m.exports;
const cases = [
 // crisis (should be self_harm / emergency)
 "I have been thinking about ending my life", "I want to take my own life", "I might take my life tonight", "I just want to end it all",
 "I don't see the point in living anymore", "Everyone would be better off without me", "I want to end my own life", "What's the point of living",
 "I don’t see the point in living anymore", "I took 20 of my sleeping pills", "I took a bunch of pills", "My chest hurts and my left arm is numb",
 "I want to kill myself", "I don't want to be alive anymore", "I took a whole bottle of Tylenol", "I took 30 Tylenol", "I took a bunch of Advil",
 "I think I'm having a heart attack", "I'm thinking about ending it", "I'm going to end it tonight",
 // ordinary (should NOT be self_harm/emergency)
 "Can I end my workout early today?", "This program will take my life to the next level", "I want to take my life back after the divorce",
 "I took 2 pills of ibuprofen for my headache", "My chest hurts after bench press yesterday", "My chest is sore from push-ups",
 "I took 5 tablets of creatine this morning", "I took 5 fish oil capsules", "This set is brutal, I want to end it now.", "I'm ready to end it with my ex",
 "What's the point of cardio", "I took lots of vitamins", "Should I end the set at 8 reps?",
];
for (const c of cases) { const r = classifySafety(c); console.log(r.class.padEnd(22), JSON.stringify(c)); }
