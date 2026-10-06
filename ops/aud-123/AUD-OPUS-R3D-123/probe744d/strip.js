const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs'); const path = require('path');
for (const ref of ['main','pr']) for (const f of ['ai/ai-crisis-router.ts','roman/guardrails/safety-router.ts']) {
  const p = path.join(__dirname, ref, f); const out = ts.transpileModule(fs.readFileSync(p,'utf8'), {compilerOptions:{module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
  fs.writeFileSync(p.replace(/\.ts$/,'.js'), out);
}
