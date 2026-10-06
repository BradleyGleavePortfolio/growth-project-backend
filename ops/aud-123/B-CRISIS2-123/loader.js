const ts = require('/usr/local/lib/node_modules/vercel/node_modules/typescript');
const fs = require('fs'); const path = require('path');
const cache = {};
function loadMod(f){ if(cache[f]) return cache[f].exports; const src=fs.readFileSync(f,'utf8');const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const m={exports:{}};cache[f]=m;
 const req=(id)=>id.startsWith('.')?loadMod(path.resolve(path.dirname(f),id)+'.ts'):require(id);
 new Function('module','exports','require',out)(m,m.exports,req);return m.exports;}
module.exports=(f,fn)=>loadMod(f)[fn];
