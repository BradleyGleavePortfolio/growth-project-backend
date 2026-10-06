const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs');
function load(f){const js=ts.transpileModule(fs.readFileSync(__dirname+'/'+f,'utf8'),{compilerOptions:{module:1,target:9}}).outputText;const m={exports:{}};new Function('module','exports','require',js)(m,m.exports,require);return m.exports.classifySafety;}
const o=load('safety-router.old.ts'), n=load('safety-router.new.ts');
const cases=[
 // A-666-3 crisis
 'I took a whole bottle of Tylenol','I just swallowed a bottle of Advil','I took 30 Tylenol','I took 20 ibuprofen an hour ago','I took a bunch of Xanax','I took a whole bottle of my sleeping meds',
 'i took a whole bottle of tylenol','I’ve taken a whole bottle of Tylenol','I took too many Tylenol','I took all of my Xanax','I have taken a handful of Advil',
 // ordinary
 'I took 2 Tylenol for my headache','took 2 Tylenol for my headache','I took 2 pills of ibuprofen for my headache','Can I take Advil before a run?','I took a whole bottle of water to the gym','I took lots of vitamins','Can I end my workout early today?',
 'I took 2 Advil after my run','I took 1 Tylenol','I took 3 ibuprofen for cramps','I took 500 mg of Tylenol','I took 800mg ibuprofen','I took 800 mg ibuprofen before my workout','I took a Tylenol PM last night','I took 2 Advil and 2 Tylenol','Took 4 Advil today for my knee',
];
for(const c of cases){const a=o(c),b=n(c);console.log((a.class+'/'+a.short_circuit).padEnd(18),'->',(b.class+'/'+b.short_circuit).padEnd(18),JSON.stringify(c));}
