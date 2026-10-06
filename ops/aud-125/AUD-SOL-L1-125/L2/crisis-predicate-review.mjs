// Read-only evaluation of the exact pure predicate at the reviewed Git heads.
// No dependency install, build, test runner, model call, network, or repository edit.
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
const repo = '/home/user/workspace/wt/RO-backend';
const head = 'f85de9b83441ff5dce910375c8aeb877df3ed978';
function predicate(ref) {
  let text = execFileSync('git', ['-C', repo, 'show', `${ref}:src/ai/ai-crisis-router.ts`], { encoding: 'utf8' });
  text = text.slice(0, text.indexOf('/**\n * Fixed replies'));
  text = text.replace(/export type AiGuideCrisisClass = 'emergency' \| 'self_harm';/, '');
  text = text.replace(/export /g, '').replace(/: readonly RegExp\[\]/g, '').replace(/: RegExp\[\]/g, '');
  text = text.replace(/condition: string/g, 'condition').replace(/message: string/g, 'message');
  text = text.replace(/\): RegExp/g, ')').replace(/\): string/g, ')');
  text = text.replace(/\): AiGuideCrisisClass \| null/g, ')');
  return vm.runInNewContext(`${text}\nclassifyAiGuideCrisis`, {});
}
const current = predicate(head);
const previous = predicate(`${head}^`);
const messages = [
  "I'm not breathing properly during squats",
  "I'm not breathing properly during squats, I need help now.",
  "I'm not breathing during my run, call an ambulance.",
  "I can't breathe after my workout",
  "I'm not breathing",
  "I felt like I was going to pass out in HIIT yesterday",
  "I'm about to pass out",
];
console.log(JSON.stringify({ head, path: 'src/ai/ai-crisis-router.ts', results: messages.map(message => ({ message, previous: previous(message), current: current(message) })) }, null, 2));
