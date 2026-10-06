// Standalone runner of the copyVoice guard scanner (same logic, no jest). Usage: node scan.js <worktree>
const fs=require('fs'),path=require('path');
const wt=process.argv[2];
const ts=require('/home/user/workspace/deps/mobile/node_modules/typescript');
let src=fs.readFileSync(path.join(wt,'src/__tests__/copyVoice.guard.test.ts'),'utf8');
src=src.replace(/^import .*$/mg,'');
const cut=src.indexOf("describe('repo-wide voice guard");
src=src.slice(0,cut);
if(process.env.ISCAN) src=src.replace("['first_person', FIRST_PERSON],","['first_person', /(^|[^A-Za-z0-9_'’./@:-])(?:I|I['’](?:m|ve|ll|d))(?![A-Za-z0-9_'’-])/],");
let js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const fn=new Function('fs','path','ts','__dirname',js+'\nreturn {sourceFiles,scanSource,isAllowed,ALLOWED,SRC};');
const m=fn(fs,path,ts,path.join(wt,'src/__tests__'));
const files=m.sourceFiles(m.SRC);const all=[];
for(const f of files) all.push(...m.scanSource(path.relative(m.SRC,f).split(path.sep).join('/'),fs.readFileSync(f,'utf8')));
const off=all.filter(h=>m.isAllowed(h)<0);
for(const h of off) console.log(`${h.file}:${h.line} [${h.rule}] ${h.text}`);
const used=new Set(all.map(m.isAllowed).filter(i=>i>=0));
m.ALLOWED.forEach((a,i)=>{if(!used.has(i)) console.log('STALE '+a.file+': '+a.includes)});
console.log('files',files.length,'offending',off.length);
