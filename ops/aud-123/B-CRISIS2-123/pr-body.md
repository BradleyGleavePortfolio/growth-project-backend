F9 (B-CRISIS2-123, agent 123). Safety, T4 (both lenses).

## What a client hit on main
- "my teammate passed out and is not breathing" got a normal Roman answer (medical_scope hint) and no AI guide crisis reply.
- "he's not breathing", "she's not breathing", "unconscious and not breathing", "she won't wake up", "my friend won't wake up": normal answer on both surfaces, no 911.
- "my friend ODed", "my brother OD'ed", "he O.D.", "my friend O.D.'d", "she O.D.ed": normal answer on both, no 911 ("OD'd" and "overdosed" already routed).
- The other way: "I can't breathe during burpees" and "I have odd soreness after leg day" (the old `od'?d` token matched "odd") got the 911 template.

## Change (one file: src/ai/ai-crisis-router.ts, the shared 911 list Roman uses since b#744)
1. A person who is not breathing: `not / isn't / stopped breathing`, unless a form word follows ("not breathing properly during squats", "between reps", "through my mouth").
2. A person who will not wake up: he / she / they / someone / a person named by role ("my friend", "my teammate", "the baby") + won't / is not / can't wake up, or "... and won't wake up". "I can't wake up early", "he won't wake up for morning cardio" and "my legs won't wake up" stay normal.
3. Overdose spellings: one `OD_VERB` token (overdosed, ODed, OD'd, OD'ed, O.D., O.D.'d, O.D.ed, ODing, OD'ing) after a person; the apostrophe and dotted forms also without a listed person (as `OD'd` was); bare "ODed" after someone named by role ("my teammate ODed", "a guy at my gym ODed"). "odd" no longer matches. "possible O.D." added to the noun rule. `on cardio` / `on creatine` guard unchanged.
4. "can't breathe during / while <training activity>" is a training remark; "I can't breathe" alone, "after my workout", with "please help" / "help me" / "help now", or with a chest symptom still route to 911 ("please help" and "help me" added to the help-now rule so "I can't breathe during my workout. Please help me." stays 911).

## Tests
- New test/crisis-router-not-breathing.spec.ts, both routers (AI guide `classifyAiGuideCrisis`, Roman `classifySafety` with `short_circuit`): 64 cases. 33 fail on main e9b82e13 (14 not-breathing / will-not-wake, 15 OD spellings, 4 gym phrases that were 911); 31 guards pass on main and here (overdosed / OD'd with a person, "I can't breathe", help-now and chest cases, bracing, out of breath, creatine overdose, suicide sprints, wake-up and ODed-on-cardio controls).
- Local, one spec at a time via heavy.sh: new spec 64/64, ai-crisis-router 50/50, crisis-router-gym-talk 122/122, ai.service 58/58, roman-guardrails 25/25, rb121 117/117, round2 36/36, c2-rmn3 28/28, launch-hardening 58/58, golden.eval 27/27, streaming 31/31, roman-round2 20/20, c2-pool 4/4, guardrails-wiring 11/11. Prettier and eslint clean.
- Corpus scan of every string literal in src/ and test/ plus the b#744 phrase files (53,558 strings): no existing literal changes class.

Size: 175 changed lines (49+/8- source, 118 test).
