# Profile contract and the single macro calculator (C06)

## One calculator

`src/macros/macro-calculator.ts` is the only place that turns measurements
into daily targets. Callers:

| Caller                                                      | Behaviour when inputs are missing                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PUT /profile` (`ProfileService.computeAndSaveMacros`)      | Leaves the stored targets untouched; writes nothing.                                  |
| `POST /coach/macros/preset` (`MacrosService.computePreset`) | 400 (`Invalid preset input`), including an unknown `activity_level` (no silent 1.55). |
| `POST /me/onboarding/complete` (C05/C07)                    | 409 `consultation_incomplete`.                                                        |

Method: Mifflin-St Jeor (`method: "mifflin_st_jeor"`). `prefer_not_to_say` uses
the MALE equation with the 1,500 kcal floor (approved method). Activity factors
1.2 / 1.375 / 1.55 / 1.725 / 1.9. Goal: fat_loss -500, muscle_gain +300,
maintenance and performance 0.

Calorie floors (applied after the goal adjustment, reported as
`floor_applied`): male 1,500, female 1,200, prefer_not_to_say 1,500.

Split: protein 1 g per lb of goal weight (current weight when there is no goal
weight), capped at 35% of calories; fat 25% of calories; carbs fill the
remainder and never go negative. All values round to the nearest whole unit.

Worked example (unit-tested): female, 38, 167.64 cm, 172 lb, goal 150 lb,
moderate, fat loss -> BMR 1,477, TDEE 2,289, 1,789 kcal, protein 150 g, fat
50 g, carbs 185 g.

There are no fallback inputs (the old 180 lb / 175 cm / age 30 defaults are
gone). Plausibility bounds: weight 60-1000 lb, height 90-250 cm, age 13-110;
outside them the input counts as missing.

## Reading targets

`resolveDisplayedTargets` is the one read rule: a live coach `MacroTarget`
wins, then the profile's computed `macro_target_*`, otherwise nothing.

- `GET /me/macros/current` returns the `MacroTarget` row shape plus
  `source: "coach_target"`; with no row it returns the profile targets in the
  same field names (`calories_kcal`, `protein_g`, `carbs_g`, `fats_g`) with
  `id: null`, `coach_id: null`, `source: "profile"`; `null` only when neither
  exists.
- `GET /log/daily` uses the same resolver and adds `macro_targets_source`
  (`coach_target` | `profile` | `unset`). The legacy 2000/180/200/60 numbers
  are kept only for response-shape compatibility when `unset`.
- The AI context paths (`src/ai/**`) already prefer `MacroTarget` and are not
  changed by C06.

## PUT /profile: legacy mobile field names

Before C06 the mobile lean onboarding save sent field names that were not on
the DTO allow-list, and the global `ValidationPipe`
(`whitelist + forbidNonWhitelisted`) rejected the whole request with a 400.
They are now accepted. `null` for any field means "not answered" and never
overwrites a stored value. A canonical name in the same body wins over its
legacy alias.

| Mobile sends                                                             | Stored as              | Mapping                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dob`                                                                    | `date_of_birth`        | ISO date                                                                                                                                                                                |
| `current_weight`                                                         | `current_weight_lbs`   | unit rule below                                                                                                                                                                         |
| `target_weight`                                                          | `target_weight_lbs`    | unit rule below                                                                                                                                                                         |
| `primary_goal`                                                           | `goal_type`            | `lose_fast`, `lose_moderate`, `lose_weight` -> `fat_loss`; `maintain`, `mobility` -> `maintenance`; `gain`, `gain_fast`, `build_muscle` -> `muscle_gain`; canonical values pass through |
| `fitness_level`                                                          | `workout_experience`   | `new` -> `beginner`, `some` -> `intermediate`, `experienced` -> `advanced`; canonical values pass through                                                                               |
| `diet_type`                                                              | `dietary_pattern`      | `omnivore` -> `none`, `mediterranean` -> `other`, others pass through                                                                                                                   |
| `diet_restrictions`                                                      | `dietary_restrictions` | as is                                                                                                                                                                                   |
| `gym_membership`                                                         | `has_gym_membership`   | `yes_regular`, `yes_occasional` -> true; `home_gym`, `no_gym` -> false. Never overwrites `equipment_access`.                                                                            |
| `onboarding_completed`                                                   | `onboardingCompleted`  | boolean                                                                                                                                                                                 |
| `lean_intent`                                                            | (ignored)              | no column                                                                                                                                                                               |
| `tdee`, `calorie_target`, `protein_target`, `carbs_target`, `fat_target` | (ignored)              | the server computes targets                                                                                                                                                             |

Weight unit rule for `current_weight` / `target_weight`:

1. `weight_unit` (`kg` or `lbs`) in the same body wins.
2. Otherwise a body that carries a lean-only key (`fitness_level` or
   `lean_intent`) is read as kg, because the lean writer stores kg.
3. Otherwise lbs (the legacy results screen and EditProfile send lbs).

Mobile should send `weight_unit` explicitly with every weight; rule 2 exists
only so builds already in the field stop losing data.

Also newly allow-listed (columns already existed): `injuries` (string[]),
`preferred_training_time` (`morning` | `midday` | `evening` | `varies`),
`food_preferences` (string[]).

Regression tests: `test/profile-lean-onboarding-contract.spec.ts`,
`test/macro-calculator.spec.ts`, `test/macros-current-self.spec.ts`.
