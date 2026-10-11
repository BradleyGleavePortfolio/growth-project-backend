# Launch flags: plan, apply, verify, roll back

Every launch flag and every GitHub-sourced secret on the production Fly app (`backend-spring-lake-3890`) is changed in one place: the desired-state manifest `.github/fly-env-desired-state.json`, applied by the operator workflow **Fly Env Sync (operator)** (`.github/workflows/fly-env-sync.yml`). No other workflow sets these names; `test/ci/fly-env-manifest.spec.ts` fails if one does.

Merging a manifest PR changes nothing in production. The change happens only when the operator runs the workflow in apply mode.

## The manifest

| Section    | Values                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flags`    | `"unset"` or one value from the name's closed set | `"unset"`: the name must not exist on Fly, so the code default applies. A value: Fly must hold exactly that string. The closed set is the `values` field of the name's rule in `src/common/env-validation.ts` (`ENV_RULES`), meaning the strings the code reads as distinct values. For example `BOOKING_REMINDERS_ENABLED` accepts only `on` / `off`, so `true` is rejected (it would quietly turn reminders off). |
| `secrets`  | `"github-secret"`, `"present"`, `"unset"`         | `github-secret`: Fly must hold the GitHub Actions secret of the same name, and that GitHub secret must be set and pass its shape check. `present`: must exist on Fly; another workflow owns the value and this one never writes it. `unset`: must not exist on Fly.                                                                                                                                                 |
| `gates`    | one line per managed name                         | Why the name has its current value and what must be true before it flips.                                                                                                                                                                                                                                                                                                                                           |
| `excluded` | one line per name                                 | Registered names this manifest deliberately does not manage, with the reason.                                                                                                                                                                                                                                                                                                                                       |

Each entry is on its own line, so every flip is a one-line diff. Duplicate keys, two entries on one line, unregistered names, values outside the closed set and missing gates all fail validation with a `Fix:` line.

Preconditions are checked on the manifest alone, so they fail the PR's tests and the plan before anything is written:

- `FEATURE_MWB_AUTOSAVE_UNDO=true` needs `MWB_AUTOSAVE_LOCK_TOKEN_SECRET` declared `github-secret` (64+ hex characters: `openssl rand -hex 32 | gh secret set MWB_AUTOSAVE_LOCK_TOKEN_SECRET`) or `present`.
- Every community surface flag (`FEATURE_COMMUNITY_POSTS`, `_MESSAGES`, `_PUSH`, `_REALTIME`, `_VOICE_NOTES`, `_DM` and the others) needs `FEATURE_COMMUNITY_API=true`.
- `FEATURE_COMMUNITY_API=true` needs `FEATURE_COMMUNITY_SCHEMA` to be `true` or `unset` (unset means on).
- `FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT=true` needs `FEATURE_COMMUNITY_VOICE_NOTES=true`.
- `FEATURE_MWB_AI_LIVE_CREATE=true` needs `AI_GATEWAY_ENABLED=true`, `AI_GATEWAY_PROVIDER=anthropic` and `AI_GATEWAY_CAPABILITIES` declared (its only settable value is `draft.create_workout_plan,draft.edit_workout_plan`; `*` is outside the closed set).
- A `github-secret` source must be set and non-blank. `GOOGLE_CLIENT_IDS` must be a comma list with no empty entry. `SUPABASE_SERVICE_ROLE_KEY` must be an `sb_secret_` key and `SUPABASE_ANON_KEY` an `sb_publishable_` key (letters, digits, `_` and `-` after the prefix; no spaces, no legacy `eyJ...` JWT).

## 1. Flip: one PR per flip

1. Change one line, for example `"FEATURE_AI_CONSENT_LEDGER_ENABLED": "true",`. If the flag has a precondition, change the line it depends on in the same PR.
2. Before merge, the PR's CI (`test/ci/fly-env-manifest.spec.ts`) validates the manifest.
3. Merge after review. Production is unchanged.

## 2. Plan (read-only)

```
gh workflow run "Fly Env Sync (operator)" -f app=backend-spring-lake-3890 -f mode=plan
```

The plan lists Fly's secrets with `flyctl secrets list --json` (names and status only; digests are dropped by jq before anything reads them). It then runs a value check inside a running machine over `flyctl ssh console`, and prints one row per managed name:

```
NAME | kind | declared | on Fly | in machine | action | why
```

- `declared` is the flag value, or `github-secret` / `present` / `unset` for a secret. Secret values, Fly digests and flyctl's own output are never printed.
- `on Fly` is `absent`, `Deployed`, `Staged`, `Partial` or `Unknown`.
- `in machine`: for declared values, `match`, `differs` or `absent`. For names declared unset or present, `present` or `absent`. The machine only ever compares salted hashes (sha256 of a random per-run salt, a zero byte and the value), and it returns only these words.
- `action` is `keep`, `set`, `unset` or `error`.

The first line prints the sha256 of the manifest file, which identifies exactly which desired state was planned. The same table goes to the job summary. The plan also names any secrets staged by other workflows, because `deploy_staged=true` would apply those too.

A value that is `Deployed` and `match` is kept and never set again. That means an apply with nothing to change writes nothing and restarts nothing. A `Staged`, `Partial` or `Unknown` value cannot be read back, so it is staged again (safe, no restart). If the in-machine check cannot run, the plan prints a warning with a fix, and declared values are staged again rather than assumed.

## 3. Apply: stage, then verify

```
gh workflow run "Fly Env Sync (operator)" -f app=backend-spring-lake-3890 -f mode=apply -f confirm=SET
```

Apply re-plans, then stages exactly the planned changes with `flyctl secrets set --stage` and `flyctl secrets unset --stage`. Staging does **not** restart machines. It then lists Fly again and proves that every managed name is present or absent exactly as declared. Any mismatch fails the run, names the mismatched names and gives a fix. Staged changes take effect at the next deploy (`fly-deploy.yml`) or right away with `deploy_staged=true`.

## 4. Apply now: one rolling restart, then proof from every started machine

```
gh workflow run "Fly Env Sync (operator)" -f app=backend-spring-lake-3890 -f mode=apply -f confirm=SET -f deploy_staged=true
```

Apply-now fails closed (B-637-1). It succeeds only when it has proven the running state. A warning is never treated as proof.

1. **Deploy decision.** `flyctl secrets deploy` (one rolling restart) runs when any of these is true:
   - this run staged a change;
   - a managed name staged earlier is not live yet;
   - the in-machine check before this step did not run, so the plan could not prove the running state. A name that is absent from the listing could be "never set" or "unset staged, still live".
     When none of these is true, the step first checks every started machine without a restart. Only if every machine proves the manifest is the deploy skipped. If any machine differs, it deploys.
2. **Fleet proof, with a bounded retry.** The step lists Fly (`secrets list --json`) and every machine (`machines list --json`). It then runs the in-machine check on **every started machine** (`flyctl ssh console --machine <id>`). The run passes only when all of these hold:
   - every managed name is present or absent exactly as declared;
   - every declared name is `Deployed`;
   - at least one machine is started and none is mid-transition;
   - every started machine holds every declared value (`match`) and none of the unset names.
     Until then it checks again: 6 attempts, 20 s apart. After the last attempt it fails with the exact reasons (names and machine ids only) and a fix. The change stays staged, so re-running apply with `deploy_staged=true` is safe.
3. **Stopped machines** cannot be checked. They are named in a warning, and the success line counts started machines only. Re-run plan after they start; every row must read `keep`.

## 5. Roll back and emergency kill

The emergency kill depends on the flag's default (`unsetIs` in its `ENV_RULES` rule). **Unsetting a defaults-on switch turns it back ON.** For those switches the kill is to set the explicit off value. Only defaults-off switches are killed by unsetting them.

Planned rollback (normal path):

1. Open a one-line PR with the manifest line from the table below. For a defaults-off flag that line is `"unset"`. For a defaults-on switch it is `"false"`.
2. After merge, run apply with `deploy_staged=true`. The workflow stages the change (`--stage`), runs one deploy, and proves the effective state in every started machine.

Emergency, when waiting for review is not possible:

1. Run the per-flag emergency kill from the table, from a trusted terminal. It restarts machines immediately.
2. At once, open the matching one-line manifest PR (the last column). Until it merges, the plan reports drift, and an apply would undo the kill. **Do not run apply before that PR merges.**
3. After it merges, run plan. The row must read `keep`, and the in-machine column must show the effective state (`match` for a set kill, `absent` for an unset kill).

The table below is generated by `node scripts/fly-env/fly-env-manifest.js kill-switches .github/fly-env-desired-state.json src/common/env-validation.ts`, and `test/ci/fly-env-manifest.spec.ts` fails if it drifts. Every plan also prints the defaults-on kills.

```text
NAME | unset means | emergency kill (Fly) | manifest line after the kill
FEATURE_AI_CONSENT_LEDGER_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_AI_CONSENT_LEDGER_ENABLED | "FEATURE_AI_CONSENT_LEDGER_ENABLED": "unset"
FEATURE_COMMUNITY_SCHEMA | on | fly secrets set -a backend-spring-lake-3890 FEATURE_COMMUNITY_SCHEMA=false (never unset: that turns it on) | "FEATURE_COMMUNITY_SCHEMA": "false"
FEATURE_COMMUNITY_API | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_API | "FEATURE_COMMUNITY_API": "unset"
FEATURE_COMMUNITY_POSTS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_POSTS | "FEATURE_COMMUNITY_POSTS": "unset"
FEATURE_COMMUNITY_MESSAGES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_MESSAGES | "FEATURE_COMMUNITY_MESSAGES": "unset"
FEATURE_COMMUNITY_PUSH | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_PUSH | "FEATURE_COMMUNITY_PUSH": "unset"
FEATURE_COMMUNITY_REALTIME | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_REALTIME | "FEATURE_COMMUNITY_REALTIME": "unset"
FEATURE_COMMUNITY_VOICE_NOTES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_VOICE_NOTES | "FEATURE_COMMUNITY_VOICE_NOTES": "unset"
FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT | "FEATURE_COMMUNITY_VOICE_NOTES_REQUIRE_ENTITLEMENT": "unset"
FEATURE_COMMUNITY_DM | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_DM | "FEATURE_COMMUNITY_DM": "unset"
FEATURE_COMMUNITY_ACKS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_ACKS | "FEATURE_COMMUNITY_ACKS": "unset"
FEATURE_COMMUNITY_PLAN_TAGS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_PLAN_TAGS | "FEATURE_COMMUNITY_PLAN_TAGS": "unset"
FEATURE_COMMUNITY_SEARCH | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_SEARCH | "FEATURE_COMMUNITY_SEARCH": "unset"
FEATURE_COMMUNITY_TELEMETRY | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_TELEMETRY | "FEATURE_COMMUNITY_TELEMETRY": "unset"
FEATURE_COMMUNITY_WEARABLE_PROMPTS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_WEARABLE_PROMPTS | "FEATURE_COMMUNITY_WEARABLE_PROMPTS": "unset"
FEATURE_COMMUNITY_AI_TRIAGE | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_AI_TRIAGE | "FEATURE_COMMUNITY_AI_TRIAGE": "unset"
FEATURE_COMMUNITY_CHALLENGES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_CHALLENGES | "FEATURE_COMMUNITY_CHALLENGES": "unset"
FEATURE_COMMUNITY_EVENTS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_EVENTS | "FEATURE_COMMUNITY_EVENTS": "unset"
FEATURE_COMMUNITY_CLASSROOM_POSTS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COMMUNITY_CLASSROOM_POSTS | "FEATURE_COMMUNITY_CLASSROOM_POSTS": "unset"
FEATURE_MESSAGING_CORE_V2 | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_MESSAGING_CORE_V2 | "FEATURE_MESSAGING_CORE_V2": "unset"
BILLING_ENFORCEMENT | off | fly secrets unset -a backend-spring-lake-3890 BILLING_ENFORCEMENT | "BILLING_ENFORCEMENT": "unset"
BOOKING_REMINDERS_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 BOOKING_REMINDERS_ENABLED | "BOOKING_REMINDERS_ENABLED": "unset"
SIGNUP_ROLE_CHOICE_ENABLED | on | fly secrets set -a backend-spring-lake-3890 SIGNUP_ROLE_CHOICE_ENABLED=false (never unset: that turns it on) | "SIGNUP_ROLE_CHOICE_ENABLED": "false"
FEATURE_COACHLESS_HOME | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COACHLESS_HOME | "FEATURE_COACHLESS_HOME": "unset"
COACH_WELCOME_SCHEDULER_ENABLED | on | fly secrets set -a backend-spring-lake-3890 COACH_WELCOME_SCHEDULER_ENABLED=false (never unset: that turns it on) | "COACH_WELCOME_SCHEDULER_ENABLED": "false"
WORKOUT_REMINDERS_ENABLED | on | fly secrets set -a backend-spring-lake-3890 WORKOUT_REMINDERS_ENABLED=false (never unset: that turns it on) | "WORKOUT_REMINDERS_ENABLED": "false"
FEATURE_WEARABLES_INGEST_POST | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_WEARABLES_INGEST_POST | "FEATURE_WEARABLES_INGEST_POST": "unset"
FEATURE_MWB_TEMPLATES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_MWB_TEMPLATES | "FEATURE_MWB_TEMPLATES": "unset"
FEATURE_MWB_AUTOSAVE_UNDO | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_MWB_AUTOSAVE_UNDO | "FEATURE_MWB_AUTOSAVE_UNDO": "unset"
FEATURE_MWB_AI_LIVE_CREATE | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_MWB_AI_LIVE_CREATE | "FEATURE_MWB_AI_LIVE_CREATE": "unset"
AI_GATEWAY_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 AI_GATEWAY_ENABLED | "AI_GATEWAY_ENABLED": "unset"
AI_GATEWAY_PROVIDER | off | fly secrets unset -a backend-spring-lake-3890 AI_GATEWAY_PROVIDER | "AI_GATEWAY_PROVIDER": "unset"
AI_GATEWAY_CAPABILITIES | off | fly secrets unset -a backend-spring-lake-3890 AI_GATEWAY_CAPABILITIES | "AI_GATEWAY_CAPABILITIES": "unset"
AI_GATEWAY_REQUIRE_APPROVAL | off | fly secrets unset -a backend-spring-lake-3890 AI_GATEWAY_REQUIRE_APPROVAL | "AI_GATEWAY_REQUIRE_APPROVAL": "unset"
FEATURE_NAMED_REGIMES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_NAMED_REGIMES | "FEATURE_NAMED_REGIMES": "unset"
FEATURE_DUNNING_V2 | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_DUNNING_V2 | "FEATURE_DUNNING_V2": "unset"
FEATURE_COACH_CODE_TOOLS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COACH_CODE_TOOLS | "FEATURE_COACH_CODE_TOOLS": "unset"
FEATURE_COACH_BROADCASTS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COACH_BROADCASTS | "FEATURE_COACH_BROADCASTS": "unset"
FEATURE_ROMAN_CHAT_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_ROMAN_CHAT_ENABLED | "FEATURE_ROMAN_CHAT_ENABLED": "unset"
FEATURE_ROMAN_ADJUST_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_ROMAN_ADJUST_ENABLED | "FEATURE_ROMAN_ADJUST_ENABLED": "unset"
FEATURE_ROMAN_MEMORY | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_ROMAN_MEMORY | "FEATURE_ROMAN_MEMORY": "unset"
FEATURE_ROMAN_PLAYBOOK | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_ROMAN_PLAYBOOK | "FEATURE_ROMAN_PLAYBOOK": "unset"
FEATURE_ROMAN_TOOLS | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_ROMAN_TOOLS | "FEATURE_ROMAN_TOOLS": "unset"
APPLE_AUDIENCES | off | fly secrets unset -a backend-spring-lake-3890 APPLE_AUDIENCES | "APPLE_AUDIENCES": "unset"
APPLE_NONCE_REQUIRED | off | fly secrets unset -a backend-spring-lake-3890 APPLE_NONCE_REQUIRED | "APPLE_NONCE_REQUIRED": "unset"
GDPR_SCRUB_DRY_RUN | off | fly secrets unset -a backend-spring-lake-3890 GDPR_SCRUB_DRY_RUN | "GDPR_SCRUB_DRY_RUN": "unset"
COACH_AI_PACK_SUCCESS_URL | off | fly secrets unset -a backend-spring-lake-3890 COACH_AI_PACK_SUCCESS_URL | "COACH_AI_PACK_SUCCESS_URL": "unset"
COACH_AI_PACK_CANCEL_URL | off | fly secrets unset -a backend-spring-lake-3890 COACH_AI_PACK_CANCEL_URL | "COACH_AI_PACK_CANCEL_URL": "unset"
FEATURE_GOOGLE_CALENDAR_SYNC | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_GOOGLE_CALENDAR_SYNC | "FEATURE_GOOGLE_CALENDAR_SYNC": "unset"
GOOGLE_CALENDAR_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 GOOGLE_CALENDAR_ENABLED | "GOOGLE_CALENDAR_ENABLED": "unset"
GOOGLE_MEET_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 GOOGLE_MEET_ENABLED | "GOOGLE_MEET_ENABLED": "unset"
FEATURE_SCOUT_INGEST | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_SCOUT_INGEST | "FEATURE_SCOUT_INGEST": "unset"
FEATURE_EXTENSION_PAIRING | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_EXTENSION_PAIRING | "FEATURE_EXTENSION_PAIRING": "unset"
```

## Deploy-window sequences

**FEATURE_AI_CONSENT_LEDGER_ENABLED, together with the backend #626 deploy (operator ruling OR-110-4).** #626 without the ledger blocks every client-data AI call, so the flag must go live in the same window:

1. Merge the one-line flip PR (`"FEATURE_AI_CONSENT_LEDGER_ENABLED": "true"`).
2. Run apply (without `deploy_staged`). The flag is now `Staged`.
3. Run the #626 deploy (`fly-deploy.yml`). The deploy picks up the staged flag.
4. Run plan. The ledger row must read `Deployed | match | keep`. If it does not (for example, the deploy ran from a runner that did not see the staged version), run apply with `deploy_staged=true`. That stages the value again and applies it with one rolling restart, then proves it in the machine.

**BOOKING_REMINDERS_ENABLED=on, together with #632 (OR-110-5).** Same sequence with `"BOOKING_REMINDERS_ENABLED": "on"`. Only the literal `on` turns reminders on after #632.

**FEATURE_WEARABLES_INGEST_POST=true (Wave B, on-device wearables).** Apply only after mobile #378 (refresh paced under the 60 per minute ingest limit; one sleep session per night) is approved and merged; the backend code is already deployed, so no deploy is needed:

1. Merge the one-line flip PR (`"FEATURE_WEARABLES_INGEST_POST": "true"`).
2. Run apply with `deploy_staged=true` (one rolling restart).
3. Run plan. The row must read `Deployed | match | keep`.
4. Owner device pass: connect Apple Health and Health Connect on a client account; both import without a 429 and the sleep for one night is counted once.

Roll back with `"FEATURE_WEARABLES_INGEST_POST": "unset"` (or the emergency kill in the table above). The ingest routes then return `503 wearables_ingest_disabled` and the app keeps its saved progress.

**Programs on at launch: FEATURE_MWB_TEMPLATES, FEATURE_MWB_AUTOSAVE_UNDO, FEATURE_NAMED_REGIMES=true and MWB_AUTOSAVE_LOCK_TOKEN_SECRET=github-secret (Wave B, coach Programs library).** The backend code (MWB-3, #733) is already deployed, so no deploy is needed. The autosave flag throws on every request without the lock-token secret, so the four lines flip in one PR and the secret must exist first:

1. The owner creates the GitHub Actions secret `MWB_AUTOSAVE_LOCK_TOKEN_SECRET` on this repository (64 or more hex characters, for example the output of `openssl rand -hex 32`) and confirms it exists. Nobody else creates it and it is never written to a file.
2. Merge the flip PR (`"FEATURE_MWB_TEMPLATES": "true"`, `"FEATURE_MWB_AUTOSAVE_UNDO": "true"`, `"FEATURE_NAMED_REGIMES": "true"`, `"MWB_AUTOSAVE_LOCK_TOKEN_SECRET": "github-secret"`).
3. Run plan. The secret row must pass its shape check; a missing or short secret fails the plan before anything is written.
4. Run apply with `deploy_staged=true` (one rolling restart).
5. Run plan. All four rows must read `Deployed | match | keep`.
6. Before the 10-07 build ships to coaches, the mobile `EXPO_PUBLIC_FF_MWB_PROGRAMS` and `EXPO_PUBLIC_FF_MWB_AUTOSAVE` flip PR is merged, so the Programs tab and autosave reach routes that are on.
7. Owner device pass on a coach account: create a program, edit a workout (autosave and undo), assign it to a client.

Roll back with `"unset"` on the three flags (the emergency kills in the table above). The program, autosave, undo and regime routes then return 404 and saved programs are kept. Leave the secret line as is.

**AI workout builder (AIB, plan handoffs/op-125/AI_MASTER_BUILDER_PLAN.md section 5).** All five names stay `"unset"` until AIB-1a, AIB-2 and AIB-4 are deployed, SAFE-AIB-127 says GO and the owner has tapped through it on a device. Before the flip the operator lists Fly secret names (names only) and records whether `AI_GATEWAY_CAPABILITIES` already exists. The FLIP PR changes four lines in one PR:

1. `"FEATURE_MWB_AI_LIVE_CREATE": "true"`, `"AI_GATEWAY_ENABLED": "true"`, `"AI_GATEWAY_PROVIDER": "anthropic"`, `"AI_GATEWAY_CAPABILITIES": "draft.create_workout_plan,draft.edit_workout_plan"` (exactly these two, never `*`: that would send every gateway capability to the provider). `AI_GATEWAY_REQUIRE_APPROVAL` stays `"unset"`; the gateway requires a coach decision for both workout capabilities whatever it says.
2. Run plan, then apply with `deploy_staged=true`, then plan again (every row `Deployed | match | keep`).
3. `GET /ai/gateway/workout-builder/status` as a coach returns `state: "on"`. Live smoke: one edit, one create, apply, undo; the coach pool is debited and a client without AI consent gets the consent state.

Emergency kill, in order: `FEATURE_MWB_AI_LIVE_CREATE` unset (only the builder stops; the app shows the paused state, no build needed); then `AI_GATEWAY_CAPABILITIES` unset; last resort `AI_GATEWAY_ENABLED` unset (stops every gateway capability).

**Community core (Wave A).** Flip `FEATURE_COMMUNITY_API` and the core set (`_POSTS`, `_MESSAGES`, `_PUSH`, `_REALTIME`, and `_VOICE_NOTES` once its audit and device pass are done) in one PR, after the community report/block lane (#610) is deployed. The preconditions reject surface flags without the API flag.

**Sign in with Apple (day 1): APPLE_AUDIENCES=com.growthproject.app and APPLE_NONCE_REQUIRED unset.** The native iOS sheet issues identity tokens whose audience is the bundle id `com.growthproject.app`, and the app sends no `raw_nonce`. Any other audience, or `APPLE_NONCE_REQUIRED=true`, fails every Apple sign-in (and the Apple re-auth for account deletion) with 401. Both values are public, so they live here, not in a secret.

1. Merge the PR that declares both lines.
2. Run apply with `deploy_staged=true` (one rolling restart).
3. Run plan. Both rows must read `keep` (`APPLE_AUDIENCES` deployed and matching, `APPLE_NONCE_REQUIRED` absent). Then run `fly-env-truth.yml`: the `APPLE_AUDIENCES` shape check must read `pass`.
4. Owner device pass on iOS: Sign in with Apple on a fresh account lands in the app.

The token-revocation keys (`APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY`) are never copied by this workflow; `fly-apple-signin-set.yml` owns them.

**FEATURE_ROMAN_MEMORY and FEATURE_ROMAN_PLAYBOOK (Roman v1.1).** `FEATURE_ROMAN_MEMORY` is declared `true` by the flip PR FLIP-MEM-128 (owner 14:25, decision 1) now that the notes writer, the memory block, the v5 consent and memory-off-keeps-notes are merged (b#832, b#834, b#835, b#845, policy text b#844; mobile m#461, m#463). Apply it only after the deploy that carries b#844 and b#845 (deploy 25) is live. Roman reads and writes notes only for clients with a live client-ai-v5 (`memory`) grant; v4 holders stay `base` until they turn memory on. The code default stays off, so unset is still the kill (row above): the v5 offer disappears, the notes writer stops and every turn drops the memory block, while kept notes stay. `FEATURE_ROMAN_PLAYBOOK` is declared `true` by the flip PR FLIP-PB-128 (owner 14:25, decision 1). The collector, builder, schedule and coach-method block are merged (b#833, b#837, b#836), and so are the coach-method policy text R11-L3 (b#850) and the rebuild limit PB-GAP-130 (b#867: at most one successful rebuild per coach every 6 hours, the boot run included); all of them are live since deploy 31. Builds are paid from the head coach's AI pool (owner 14:39, option A), and mobile m#513 tells the head coach that each refresh uses a few cents of their AI credit. Apply it with or after `FEATURE_ROMAN_MEMORY`: the coach-method block reaches only clients with the `memory` scope. The code default stays off, so unset is still the kill (row above): no builds run and no turn gets the coach-method block. Only the exact value `true` turns each on; with both unset every v1.1 path is inert and the Roman turn prompt is unchanged. Background work for both is bounded by `ROMAN_BACKGROUND_DAILY_COST_CAP_USD` (default 10 US dollars per UTC day, not managed by this manifest) and by each coach's monthly AI pool. `FEATURE_ROMAN_TOOLS` (v1.1 tool-using turns) is declared `true` by the flip PR FLIP-TOOLS-128 now that the tool loop, the read tools, their eval cases and the reply check are merged (b#838, b#840, b#842, b#843, b#846, policy text b#844). Apply it only after the deploy that carries them and R11-T3-FU b#849 (deploy 25) is live. Only client-surface student turns use tools, for the session caller only, metered against the daily spend cap and the coach's AI pool. The code default stays off, so unset is still the kill (row above): every turn is then the single streaming call with today's prompt.

**Supabase API keys: SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY = github-secret (key switch, owner 2026-10-10).** The new secret key (`sb_secret_...`) and publishable key (`sb_publishable_...`) replace the legacy JWT keys. Supabase accepts both key systems at the same time, so no code change is needed, and every step is in the GitHub and Supabase web UIs:

1. Save the keys from Supabase (Project Settings > API Keys) as the repository Actions secrets `SUPABASE_SERVICE_ROLE_KEY` (the `sb_secret_` key) and `SUPABASE_ANON_KEY` (the `sb_publishable_` key). The plan fails before anything is written while either is missing or fails its shape check.
2. Run plan. Both rows read `set` while Fly still holds the legacy values.
3. Run apply with `confirm=SET` and `deploy_staged=true` (one rolling restart). It proves every started machine holds both new values.
4. Run plan again (both rows `Deployed | match | keep`), then sign in with email and password once.
5. Only then, and only once every mobile build in use carries an `sb_publishable_` key in `EXPO_PUBLIC_SUPABASE_ANON_KEY` (the app calls Supabase with its own copy), deactivate the legacy keys in Supabase (reversible).

To rotate later, update the GitHub secret and repeat steps 2-4, then delete the old secret key in Supabase. Never set these two with `flyctl`: the next apply copies the GitHub secret back. Changing the secret key also changes two values derived from it: a confirmed email sign-up from before the change whose local account was never created is no longer adopted at password sign-in (Google or Apple sign-in still links it), and, while `VOICE_KEY_SIGNING_SECRET` is unset, a community voice upload minted before the change and not yet published is refused at publish (those keys expire after 24 hours anyway). Published voice notes and other stored data are unaffected.

## Notes and limits

- The plan's in-machine check samples one started machine (`flyctl ssh console` picks it), and a failure there is only a warning, because plan and stage-only never claim the running state. Apply-now checks every started machine and fails closed. `FLY_API_TOKEN` must be allowed to list machines and open ssh sessions; a deploy token is enough.
- `flyctl secrets deploy` applies every staged secret on the app, including ones staged by other workflows. The plan lists those names.
- Fly's listing digest is a server-side tag that no client can reproduce, so it is never used to decide "unchanged". The in-machine check makes that decision.
- To add a flag: give its rule a one-line `values: [...]` and a one-line `unsetIs: 'on' | 'off'` (what the code does when the name is absent) in `ENV_RULES`, add it to `flags` with a gate, then let `test/ci/fly-env-manifest.spec.ts` confirm the closed set and the manifest agree. A name with a closed set that is neither managed nor excluded fails the tests.
- To add a GitHub-sourced secret: register it in `ENV_RULES`, add it to `secrets` with a gate, and add `NAME: ${{ secrets.NAME }}` to the `BEGIN SOURCES` blocks of the plan and stage steps. The specs fail if those blocks and the manifest disagree.
