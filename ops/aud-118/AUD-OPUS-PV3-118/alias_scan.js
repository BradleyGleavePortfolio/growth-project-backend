const all=require('./guard_all_calls.json');
const fs=require('fs');const path=require('path');
const root=process.argv[2];
const byFile={};for(const c of all){(byFile[c.rel]??=[]).push(c);}
const caught=/^(message|msg|errMsg|errorMessage|errMessage)$/;
let hits=[];
for(const rel of Object.keys(byFile)){
  const src=fs.readFileSync(path.join(root,rel),'utf8');
  const aliases=new Set();
  const re=/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*([^;\n]*(?:\.message\b|\.stack\b|String\(\s*(?:err|error|e)\b|res\.text\(\)|\.text\(\)\.catch)[^;\n]*)/g;
  let m;while((m=re.exec(src))){ if(!caught.test(m[1])) aliases.add(m[1]); }
  if(!aliases.size) continue;
  for(const c of byFile[rel]){ if(c.v.includes('exception-text')) continue;
    for(const a of aliases){ const r=new RegExp('(?:^|[^\\w$.])'+a.replace(/\$/g,'\\$')+'(?![\\w$])(?!\\s*:)'); if(r.test(c.code)){ hits.push(`${rel}:${c.line} alias=${a} | ${c.code.slice(0,140)}`); break; } }
  }
}
console.log(hits.join('\n'));console.log('total',hits.length);
