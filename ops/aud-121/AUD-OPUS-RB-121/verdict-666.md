AUDIT Claude Opus 5.5 — growth-project-backend#666 @ 0ec835ca1cc9697bde71e6c67ed627ea3a000691 — VERDICT: REQUEST CHANGES

AUD-OPUS-RB-121, agent 121. First full T4 review of this piece (crisis routing, health safety copy, audit read path). **A/B/C = 1/3/4.**

Scope read line by line: `51722c19` (carry), `b0caf978` (tests only), `0ec835ca` (fix): `src/roman/guardrails/{safety-router,roman-post-check,roman-guardrail.contract,index}.ts`, `src/audit/audit.service.ts`, `docs/roman-safety-copy.md`, `test/roman/roman-guardrails{,-round2}.spec.ts`. History read: my lens's #651 verdict (5964857917) and Sol's (5964898255).

### What holds
- **Piece boundary.** Inert: nothing in this diff calls the router or the post-check; #668 is the first caller. Nothing imports a later piece. No migration, env or route change.
- **OR-115-1.**
  - `AuditAction.ROMAN_SAFETY_ROUTE = 'roman.safety_route'` is neutral, and `ROMAN_SAFETY_ROUTE_REASON` is closed (`call_911` / `call_988`).
  - `AuditService.list` nulls metadata for `RESTRICTED_METADATA_ACTIONS`.
  - The other AuditLog readers never select metadata (`soc2-evidence.service.ts:179`, `reports.service.ts:260`), and `/admin/audit` is owner-only.
  - The turn path still writes the old class-named actions at #668; #669 owns that fix (see the #668 verdict).
- **OR-115-2.** The crisis templates are deterministic and consent-free, and no provider is called. The copy has no exclamation marks, no we/us and no emoji.
- **Prior findings, fixed for their stated forms (round2 spec):**
  - B-651-2: rowing and swim stroke, and past fainting.
  - B-651-3: treat, dose and negated starving.
  - B-651-6: "Eat/Aim for … per day", including full-width digits.
  - B-651-7: family-scoped facts.
  - B-651-8: the final composed reply keeps the medical/injury step and the physician line.
  - B-651-9: zero marks for the listed code points.
- **CI.** All checks are green at this head.

### A-666-1: acute anaphylaxis and overdose phrasing never reach the emergency route
- **Cause 1: the anaphylaxis branch is dead code.** `safety-router.ts:40` is `/\b(anaphyla|throat …|epi ?pen|…)\b/i`. The trailing `\b` cannot match inside "anaphyla|xis" or "anaphyla|ctic", so no form of the word fires.
- **Cause 2: the fix removed the old safety net.** The fix commit took `allergic reaction` out of this regex (#651 had it), so nothing catches "I am having anaphylaxis" any more.
- **Cause 3: overdose is matched only by the word itself.** `:42` matches only "overdose/overdosed/overdosing", so "I took a whole bottle of pills" is a normal turn.
- **Probe** (`test/roman/audit-opus-rb121.probe.spec.ts` › B-666-4). Each message below is classified `normal` with `matched=null`:
  - "I think I am going into anaphylactic shock"
  - "I am having anaphylaxis after eating shrimp"
  - "I took a whole bottle of pills"
  - "I took too many of my sleeping pills"
- **Impact** (the same class as the earlier A-R4-1 emergency-routing bypass):
  - A missed emergency falls through to the paid, consent-gated path.
  - Probe › "B-666-4 at #668": a client without box 2 who writes "I think I am going into anaphylactic shock" gets `AiConsentRequiredException` "You haven't allowed AI help yet. You can turn it on in Settings > Privacy." instead of the 911 template, with zero provider calls.
  - The same client would also be stopped by the turn limit or the spend cap, because the controller skips those only for `isSafetyShortCircuit`.
- **Fix rule:**
  - Make the anaphylaxis term match whole words: `anaphyla\w*`, or drop the trailing `\b` for that alternative.
  - Route acute forms (having / going into / think I am having + anaphylaxis / anaphylactic shock / an allergic reaction) to emergency.
  - Add overdose phrasing: `took (too many|a (whole )?bottle of|all (of )?my|a handful of) (pills|tablets|meds|medication|sleeping pills|painkillers)`.
  - Add "can'?t go on( anymore)?" to self-harm.
  - Add the 4 sentences as golden positives, plus one end-to-end test: a no-consent client gets the 911 template.

### B-666-1: everyday nutrition, sleep and coaching words still become refusal templates (B-651-3 class)
- **Evidence (`roman-post-check.ts`):**
  - `:178` `you (can|could|should…) treat`
  - `:180` bare `cure(s|d)`
  - `:181` bare `prescri(be|bed|ption)`
  - `:187` `growth hormone|hgh`
  - `:192` bare `diuretics?|laxatives?`
  - `:147` `raise … insulin` (MEDICATION_DIRECTIVE)
  - `:193` `insulin … fat`

  These run on every reply in every class.
- **Probe** (routerClass `normal`, grounded persona). Each reply below is replaced by the banned template ("I cannot help with that…"), the injury template ("I should not name what might be causing that…") or the medical_scope template:
  - "Coffee still counts toward your water for the day; it is only a mild diuretic." → `banned_substance`
  - "Deep sleep is when your body releases most of its growth hormone, so protect your bedtime." → `banned_substance`
  - "Cured meats like bacon are high in sodium, so keep them to the occasional breakfast." → `diagnosis_language`
  - "Your coach prescribed four sets of eight on squats today, so start there." → `diagnosis_language`. The module's own `FAMILY_WORDS` (`:127`) treats "prescribed" as a target word.
  - "You can treat today as a lighter day and go for a walk instead." → `diagnosis_language`
  - "Oats and prunes have a mild laxative effect thanks to their fiber." → `banned_substance`
  - "Carbs raise insulin, but that alone does not make you gain fat." → `medication_directive`

  Controls still rewrite: "Take 400 mg ibuprofen twice daily.", "Try a water fast for 3 days." and "A diuretic before your weigh-in will drop the water weight."
- **Fix rule** (same shape as the B-651-3 fix):
  - Diuretics, laxatives, water pills, insulin, growth hormone and hgh count only with an intake directive (take/use/try/start/get/buy/inject + substance) or a weight, fat-loss or cutting purpose. "raise/lower" counts with insulin only when it governs a dose ("raise your insulin (dose)").
  - Drop bare `cure(s|d)`; keep "cure(s) your/this/the <condition>".
  - `prescri*` counts only with a medical object (prescription medication/drug/meds, or prescribe + drug/medication/rehab).
  - `can treat` counts only when followed by a medical object.
  - Add the 7 sentences as golden negatives next to the 3 controls.

### B-666-2: non-acute mentions still short-circuit to "call 911 now" (B-651-2 class)
- **Evidence (`safety-router.ts`):**
  - `:43` bare `heart attack|cardiac arrest`
  - `:42` `poison(ed|ing)`
  - `:40` `epi ?pen` with no acute framing
- **Probe.** Each message below is classified `emergency` with `short_circuit: true`. That means the fixed 911 template, a crisis audit row, and no answer to the question.
  - "Does cardio lower my risk of a heart attack?"
  - "My dad had a heart attack last year, so I want to get fit." (a very common motivation line)
  - "I had food poisoning last week, when can I train again?"
  - "I carry an EpiPen for my peanut allergy, what snacks work for me?"
  - On the coach surface: "My client had a heart attack two years ago; how should I adjust her program?"

  Acute controls stay emergency:
  - "I think I am having a heart attack"
  - "My throat is closing after eating peanuts"
  - "I just used my EpiPen and my lips are swelling"
  - "I have crushing pain in my chest"
- **Fix rule:** apply the stroke rule from the B-651-2 fix.
  - "heart attack" / "cardiac arrest" count only with present or acute framing (having / think I am having / is this / signs of / symptoms of), or through the chest-pain patterns. History, risk, family and third-person-past mentions go to `medical_scope`.
  - "food poisoning" goes to `medical_scope` unless it comes with acute signs.
  - EpiPen counts only with acute framing (used / just used / need / give me + EpiPen). Throat, lips and tongue swelling stay covered.
  - Add the 5 sentences as golden negatives and keep the acute positives.

### B-666-3: a below-floor daily intake still ships (residual of B-651-6; the fix row claims "every positive daily value below the floor is replaced")
- **Evidence (`roman-post-check.ts`):**
  - `:105`: the `DIRECTIVE` allow-list has no bare "Try <n>" and no "keep/set/lower/cut your calories … <n>".
  - `:131`: `KCAL_NUMBER` needs the unit after the number, so "calories at 900 a day" is never judged.
  - `:372`: `role.size === 0 → continue` passes an unframed daily number on a grounded turn.
- **Probe** (persona floor 1,200, target 1,450, grounded). Each reply below ships unchanged, with `guardrails_applied=[]`:
  - "Try 900 calories a day."
  - "Keep your calories at 900 a day."
  - "Cut your calories to 900 per day."
  - "900 calories a day is plenty for you."

  Controls: "Eat 900 kcal per day." is still `calorie_floor`, and the 300 kcal snack line is unchanged.
- **Fix rule:** default-deny instead of a verb allow-list.
  - Any positive number below the floor that sits in a clause with a DAILY marker, or within about 3 tokens of a calorie word on either side, is `calorie_floor`.
  - The exceptions are fact-family statements (logged / remaining / average / burned) and deltas.
  - Parse unit-before-number forms (`(kcal|calories)\s*(at|to|of|around|about|:)?\s*<n>`).
  - Add the 4 sentences plus the controls.

### C (follow-ups, not blocking)
- **C-666-4:** the voice scrub misses U+FE15 (vertical-form "!") and U+00A1 ("¡") at `roman-post-check.ts:585/587`. "Nice work︕ Keep…" ships unchanged. Fix: scrub the NFKC form, or add both code points.
- **C-666-5:** `docs/roman-safety-copy.md:4` says `roman-client-v2`, but the code is `roman-client-v3` (`roman-guardrail.contract.ts:17`).
- **C-666-6:** coachless clients (day-1 community, b#657). When `coach.has_coach` is false, the templates and `restateTargets` (`roman-post-check.ts:424-456`) still say "Message your coach" or "Your coach can set them". Fix: when there is no coach, use no coach sentence and point to the right place.
- **C-666-7:** some routing is conservative. These all route to 911:
  - bare `unconscious|unresponsive` (`safety-router.ts:32`): "I sleep like I am unconscious";
  - "I can't breathe through my nose when I run";
  - "I am struggling to breathe on the last interval";
  - "I overdosed on sugar at the party lol".

  "I cannot go on anymore" is `normal`. Tune these with golden items in C3 (#670).

### Evidence
- **Probe spec** (audit only, never pushed to a PR branch): branch `audit/AUD-OPUS-RB-121/668-p2`, cut from #668 `fabc2268` with the spec only. `src/roman/guardrails/*`, `src/audit/*` and `docs/roman-safety-copy.md` are byte-identical to this head (`git diff --quiet 0ec835ca fabc2268 -- …`).
- **CI lane:** run [37369679248](https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/37369679248) (still queued at posting, 13:28 PDT; GitHub runner incident). The first lane, 37366931338, was queued for 20 minutes and then cancelled after a type fix to the spec.
- **Local run, per the operator's 20-minute rule:** `ops/heavy.sh env CI=false npx jest --runInBand --forceExit --runTestsByPath test/roman/audit-opus-rb121.probe.spec.ts` gives **26 failed / 12 passed**. Every CONTROL and INFO test passes. Every failure is one of the findings above, or one of the #668 findings in that verdict.
- **How to verify the fix:** the A-666-1, B-666-1, B-666-2 and B-666-3 tests in that spec go green, and the CONTROL tests stay green.

No push to this branch, merge, dispatch or production action by this lens. Head re-read before posting: unchanged.
