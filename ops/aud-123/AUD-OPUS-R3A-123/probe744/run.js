const M = require('./main/roman/guardrails/safety-router.js'), P = require('./pr/roman/guardrails/safety-router.js');
const MA = require('./main/ai/ai-crisis-router.js'), PA = require('./pr/ai/ai-crisis-router.js');
const cases = process.argv.slice(2).length ? process.argv.slice(2) : require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean);
for (const c of cases) {
  const a = M.classifySafety(c).class, b = P.classifySafety(c).class, ga = MA.classifyAiGuideCrisis(c), gb = PA.classifyAiGuideCrisis(c);
  console.log(`${a===b?'  ':'**'} roman ${a} -> ${b} | guide ${ga} -> ${gb} | ${c}`);
}
