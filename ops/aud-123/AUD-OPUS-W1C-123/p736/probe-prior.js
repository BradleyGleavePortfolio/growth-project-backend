const ts = require('/home/user/workspace/deps/backend/node_modules/typescript');
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ai-crisis-router.ts', 'utf8');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const m = { exports: {} }; new Function('module', 'exports', out)(m, m.exports);
const { classifyAiGuideCrisis } = m.exports;
const groups = {
  'MUST be crisis (story + common phrasing)': [
    'I want to kill myself', 'I took a whole bottle of pills', 'I don’t want to live anymore', 'I want to end my life',
    'I am thinking about suicide', 'I want to hurt myself', 'I took all my pills', 'I overdosed', 'I want to die',
    'I am going to hang myself', 'I want to hang myself', 'I am going to shoot myself', 'I want to jump off a bridge',
    'I am going to jump off the roof', 'I want to slit my wrists', 'I am going to take my own life', 'I wish I was dead',
    'I just want it all to end', 'I want to end it', 'everyone would be better off without me', 'I am done with life',
    'I took 20 of my sleeping pills', 'I swallowed a bunch of tablets', 'I think I am having a heart attack',
    'my chest hurts and my left arm is numb', 'I can’t breathe', 'my friend collapsed and is not breathing',
    'I have been cutting myself', 'I want to disappear forever', 'I keep thinking about ending it', 'kms',
  ],
  'MUST stay normal (ordinary fitness phrasing)': [
    'kill this workout', 'I\'m dying after leg day', 'my legs are dying after squats', 'overdose on cardio',
    'I think I overdosed on cardio this week', 'can you overdose on creatine?', 'is it possible to overdose on caffeine from pre-workout',
    'how much protein is an overdose', 'did I overdose on carbs last night', 'is mercury poisoning a risk if I eat tuna every day',
    'leg day makes me want to die', 'this program is killing me', 'I could die for a pizza right now', 'I am going to crush this workout',
    'I get chest tightness when I bench, is my form off', 'I find it hard to breathe during heavy squats, how should I brace',
    'I can’t breathe through my nose when I run, any tips', 'I have trouble breathing on long runs',
    'I feel like I\'m going to pass out after burpees', 'I just passed out on the couch after training lol',
    'how do I stop unconscious snacking at night', 'I am going to collapse after this workout', 'I kill it at the gym',
    'killing myself at the gym today', 'hurt myself deadlifting last week, can I train', 'I cut myself shaving',
    'I want to end the set strong', 'I can’t go on the bike today', 'muscle failure', 'I could not go on any longer in that set',
  ],
};
for (const [g, list] of Object.entries(groups)) {
  console.log('## ' + g);
  for (const s of list) console.log((classifyAiGuideCrisis(s) ?? 'null').padEnd(10) + ' | ' + s);
}
