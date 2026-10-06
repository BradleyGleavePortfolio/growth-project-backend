const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs');
const js = ts.transpileModule(fs.readFileSync(__dirname + '/safety-router.8cfad607.ts','utf8'), { compilerOptions: { module: 1, target: 9 } }).outputText;
const m = { exports: {} }; new Function('module','exports',js)(m,m.exports);
const c = m.exports.classifySafety;
for (const s of ['I took 5 creatine tablets','I took 5 salt tablets during my run']) console.log(c(s).class.padEnd(14), c(s).short_circuit, JSON.stringify(s));
