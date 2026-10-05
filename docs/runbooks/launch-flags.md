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
- A `github-secret` source must be set and non-blank. `GOOGLE_CLIENT_IDS` must be a comma list with no empty entry.

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
BOOKING_REMINDERS_ENABLED | off | fly secrets unset -a backend-spring-lake-3890 BOOKING_REMINDERS_ENABLED | "BOOKING_REMINDERS_ENABLED": "unset"
SIGNUP_ROLE_CHOICE_ENABLED | on | fly secrets set -a backend-spring-lake-3890 SIGNUP_ROLE_CHOICE_ENABLED=false (never unset: that turns it on) | "SIGNUP_ROLE_CHOICE_ENABLED": "false"
FEATURE_COACHLESS_HOME | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_COACHLESS_HOME | "FEATURE_COACHLESS_HOME": "unset"
COACH_WELCOME_SCHEDULER_ENABLED | on | fly secrets set -a backend-spring-lake-3890 COACH_WELCOME_SCHEDULER_ENABLED=false (never unset: that turns it on) | "COACH_WELCOME_SCHEDULER_ENABLED": "false"
WORKOUT_REMINDERS_ENABLED | on | fly secrets set -a backend-spring-lake-3890 WORKOUT_REMINDERS_ENABLED=false (never unset: that turns it on) | "WORKOUT_REMINDERS_ENABLED": "false"
FEATURE_WEARABLES_INGEST_POST | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_WEARABLES_INGEST_POST | "FEATURE_WEARABLES_INGEST_POST": "unset"
FEATURE_MWB_TEMPLATES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_MWB_TEMPLATES | "FEATURE_MWB_TEMPLATES": "unset"
FEATURE_MWB_AUTOSAVE_UNDO | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_MWB_AUTOSAVE_UNDO | "FEATURE_MWB_AUTOSAVE_UNDO": "unset"
FEATURE_NAMED_REGIMES | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_NAMED_REGIMES | "FEATURE_NAMED_REGIMES": "unset"
FEATURE_DUNNING_V2 | off | fly secrets unset -a backend-spring-lake-3890 FEATURE_DUNNING_V2 | "FEATURE_DUNNING_V2": "unset"
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

**Community core (Wave A).** Flip `FEATURE_COMMUNITY_API` and the core set (`_POSTS`, `_MESSAGES`, `_PUSH`, `_REALTIME`, and `_VOICE_NOTES` once its audit and device pass are done) in one PR, after the community report/block lane (#610) is deployed. The preconditions reject surface flags without the API flag.

## Notes and limits

- The plan's in-machine check samples one started machine (`flyctl ssh console` picks it), and a failure there is only a warning, because plan and stage-only never claim the running state. Apply-now checks every started machine and fails closed. `FLY_API_TOKEN` must be allowed to list machines and open ssh sessions; a deploy token is enough.
- `flyctl secrets deploy` applies every staged secret on the app, including ones staged by other workflows. The plan lists those names.
- Fly's listing digest is a server-side tag that no client can reproduce, so it is never used to decide "unchanged". The in-machine check makes that decision.
- To add a flag: give its rule a one-line `values: [...]` and a one-line `unsetIs: 'on' | 'off'` (what the code does when the name is absent) in `ENV_RULES`, add it to `flags` with a gate, then let `test/ci/fly-env-manifest.spec.ts` confirm the closed set and the manifest agree. A name with a closed set that is neither managed nor excluded fails the tests.
- To add a GitHub-sourced secret: register it in `ENV_RULES`, add it to `secrets` with a gate, and add `NAME: ${{ secrets.NAME }}` to the `BEGIN SOURCES` blocks of the plan and stage steps. The specs fail if those blocks and the manifest disagree.
