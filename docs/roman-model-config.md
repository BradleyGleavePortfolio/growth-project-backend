# Roman model configuration, boot probe and `/health/roman` (R1)

Source: `src/roman/model/*`. Tests: `test/roman/roman-model-config.spec.ts`.

## Env

| Var | Default | Notes |
|---|---|---|
| `ROMAN_MODEL_PRIMARY` | `claude-sonnet-5-5` | must be on the allow-list below |
| `ROMAN_MODEL_FALLBACK` | `claude-sonnet-4-6` | must be on the allow-list below |
| `ROMAN_MODEL_EFFORT` | `low` | `low` / `medium` / `high`, sent as `output_config.effort` on 5.5-family models |
| `ROMAN_GLOBAL_DAILY_USD_CAP` | `25` | `0` disables; resting reply, no model call once reached |

A retired or unknown id, including inherited object names such as
`constructor`, `toString` or `__proto__`, fails boot with a
`RomanModelConfigError`. The allow-list is a frozen null-prototype object and
the lookup is an own-property check (`lookupRomanModel`).

## Allow-list and per-model request contract

| Model | Family | Request profile | Turn `max_tokens` | Probe `max_tokens` |
|---|---|---|---|---|
| `claude-sonnet-5-5` | `sonnet_5_5` | `thinking: {type:'between_tools'}` + `output_config.effort` | 2048 (text only) | 4 |
| `claude-opus-5-5` | `opus_5_5` | `thinking: {type:'adaptive'}` + `output_config.effort` | 4096 (thinking-inclusive) | 256 |
| `claude-sonnet-4-6` | `legacy_plain` | none | 2048 | 4 |

Opus 5.5 thinking is always adaptive; `between_tools` is a Sonnet-only setting
and returns 400 on Opus, so Opus has its own family and budgets. `temperature`,
`top_p`, `top_k` and `thinking.disabled` are never sent for the 5.x families.

`turnRequestFor(profile, effort)` and `probeRequestFor(profile, effort)` are the
single source of the per-model body for the turn path (`RomanService`) and the
boot probe (`RomanModelHealthService`), so the two cannot disagree. The spec
pins the probe and turn payload of every allowed model.

## Health

`GET /health/roman` (public) returns `{status, enabled, primary_model,
fallback_model, primary_ok, fallback_ok, probed_at}`; 503 only when
`down`/`unconfigured` and `FEATURE_ROMAN_CHAT_ENABLED=true`. States:
`ready`, `degraded` (fallback only), `down`, `unconfigured`, `unprobed`.
Re-probe every 15 minutes and after 3 consecutive upstream not-found errors.
Logs carry error class, HTTP status and Anthropic error type only.
