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

## 4. Apply now: one rolling restart, then verify in the machine

```
gh workflow run "Fly Env Sync (operator)" -f app=backend-spring-lake-3890 -f mode=apply -f confirm=SET -f deploy_staged=true
```

After staging and verifying, the workflow runs `flyctl secrets deploy` (one rolling restart). It does this only if something changed in this run, or if a managed name was staged earlier and is not live yet. When there is nothing to apply, the deploy step is skipped and no machine restarts. After the deploy, it lists Fly again and re-runs the in-machine check. The run fails unless the machine holds every declared value (`match`) and none of the names declared unset.

## 5. Roll back

A rollback is just another flip:

1. Open a one-line PR that sets the flag back to `"unset"` (or to `"false"` / `"off"` where the code default is on and you need it off: `SIGNUP_ROLE_CHOICE_ENABLED` and `FEATURE_COMMUNITY_SCHEMA` default on).
2. After merge, run apply with `deploy_staged=true`. The workflow runs `flyctl secrets unset --stage`, then one deploy, then proves the name is gone from Fly and from the running machine.

In an emergency where waiting for review is not possible, the kill switch is still `fly secrets unset -a backend-spring-lake-3890 <NAME>` from a trusted terminal, which restarts machines immediately. Follow it at once with the matching one-line manifest PR. Until that PR merges, the plan reports the drift (`set` for the name the manifest still declares), and an apply would turn the flag back on, so do not run apply before the revert PR merges.

## Deploy-window sequences

**FEATURE_AI_CONSENT_LEDGER_ENABLED, together with the backend #626 deploy (operator ruling OR-110-4).** #626 without the ledger blocks every client-data AI call, so the flag must go live in the same window:

1. Merge the one-line flip PR (`"FEATURE_AI_CONSENT_LEDGER_ENABLED": "true"`).
2. Run apply (without `deploy_staged`). The flag is now `Staged`.
3. Run the #626 deploy (`fly-deploy.yml`). The deploy picks up the staged flag.
4. Run plan. The ledger row must read `Deployed | match | keep`. If it does not (for example, the deploy ran from a runner that did not see the staged version), run apply with `deploy_staged=true`. That stages the value again and applies it with one rolling restart, then proves it in the machine.

**BOOKING_REMINDERS_ENABLED=on, together with #632 (OR-110-5).** Same sequence with `"BOOKING_REMINDERS_ENABLED": "on"`. Only the literal `on` turns reminders on after #632.

**Community core (Wave A).** Flip `FEATURE_COMMUNITY_API` and the core set (`_POSTS`, `_MESSAGES`, `_PUSH`, `_REALTIME`, and `_VOICE_NOTES` once its audit and device pass are done) in one PR, after the community report/block lane (#610) is deployed. The preconditions reject surface flags without the API flag.

## Notes and limits

- The in-machine check runs in one started machine (`flyctl ssh console` picks it). After `flyctl secrets deploy` completes, every machine has been restarted with the same secrets. `FLY_API_TOKEN` must be allowed to open ssh sessions; a deploy token is enough.
- `flyctl secrets deploy` applies every staged secret on the app, including ones staged by other workflows. The plan lists those names.
- Fly's listing digest is a server-side tag that no client can reproduce, so it is never used to decide "unchanged". The in-machine check makes that decision.
- To add a flag: give its rule a one-line `values: [...]` in `ENV_RULES`, add it to `flags` with a gate, then let `test/ci/fly-env-manifest.spec.ts` confirm the closed set and the manifest agree. A name with a closed set that is neither managed nor excluded fails the tests.
- To add a GitHub-sourced secret: register it in `ENV_RULES`, add it to `secrets` with a gate, and add `NAME: ${{ secrets.NAME }}` to the `BEGIN SOURCES` blocks of the plan and stage steps. The specs fail if those blocks and the manifest disagree.
