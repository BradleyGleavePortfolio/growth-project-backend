# `src/diagnostic` — 40-point Diagnostic + AI roadmap

Phase 3. Public lead-capture funnel. An anonymous visitor answers 40 Likert
questions across three sections (Income / Body / Lifestyle), the service
computes per-section scores + an overall bucket, and an async AI call
generates a 300–400-word personalized roadmap. Roadmap lands on the same
submission via `GET /diagnostic/:id` (poll until `roadmap_status` is
`ready` or `failed`).

## Public endpoints

| Method | Path                       | Auth     | Throttler                | Purpose                              |
| ------ | -------------------------- | -------- | ------------------------ | ------------------------------------ |
| GET    | `/diagnostic/questions`    | `@Public()` | `default` (60/min)    | Returns the question catalog.         |
| POST   | `/diagnostic/submit`       | `@Public()` | `diagnostic-submit` (5/h/IP) | Persists submission, kicks off AI. |
| GET    | `/diagnostic/:submissionId` | `@Public()` | `default`             | Submission + roadmap (poll-friendly). |

## The three sections

| Section                          | Questions | Raw range | Bucket cutoffs (% of max)     |
| -------------------------------- | --------- | --------- | ----------------------------- |
| Income Architecture              | 15        | 15–75     | 0–30 stuck / 31–60 moving / 61–100 compounding |
| Body Protocol                    | 12        | 12–60     | same                          |
| Calendar & Lifestyle Architecture | 13       | 13–65     | same                          |
| Overall                          | 40        | 40–200    | 0–70 stuck / 71–130 moving / 131–200 compounding |

The 40 questions are stored verbatim from the brief in
`prisma/seed-diagnostic.json`. **Do not paraphrase** — they are positioning
copy, not technical content. Editing them requires a marketing review.

## Scoring

* `section_pct = (raw - n_questions) / (n_questions * 5 - n_questions) * 100`
  — i.e. all-1s maps to 0 %, all-5s to 100 %. Floor-subtraction is what
  makes the brief's "0–30 % = STUCK" band align with "all 1s lands in
  STUCK".
* `overall_raw = sum of all 40 answers` (range 40–200) — matches the
  brief's overall band cutoffs verbatim.
* Section bucket uses the rounded percentage, so 60.4 % stays in `moving`
  rather than tipping into `compounding`.

## AI roadmap

The prompt template lives in
`src/diagnostic/ai-roadmap.service.ts` as `ROADMAP_SYSTEM_PROMPT`. Voice
rules pinned in `test/diagnostic-prompt-doctrine.spec.ts`:

* No emoji, exclamation marks, or em-dashes
* Numbers over adjectives; cite the section scores
* 300–400 word total cap (do not exceed)
* Four paragraphs: **Overall assessment** → **Top strength** → **Biggest
  gap (with one concrete recommendation)** → **The next 90 days (with
  weekly cadence)**
* Plain text — no Markdown headings, no numbered list

Editing the prompt requires updating the doctrine spec in lockstep. The
spec asserts the canonical opening line plus all six voice rules, so a
silent edit fails CI.

`DIAGNOSTIC_AI_ENABLED=false` short-circuits the Perplexity call and
stores a placeholder roadmap. Use this in CI / preview deploys without a
Perplexity key. Failures (provider 5xx, network timeout, missing API key)
land as `AiRoadmap{status='failed', error_message: ...}`; the GET handler
serves them as `roadmap_status='failed'` and the client renders a retry
button. The submit endpoint never returns 5xx for AI provider issues —
it returned `submission_id` immediately, before the AI call ran.

## Rate limiting

POST `/diagnostic/submit` uses the `diagnostic-submit` named throttler.
Default: 5 requests / hour / IP. Tracker is IP because the endpoint is
unauthenticated by definition. Override at boot with
`DIAGNOSTIC_RATE_LIMIT_PER_HOUR` (clamped to `[1, 1000]`).

The other two routes hit the `default` throttler (60/min/IP), which is
plenty for the catalog GET and the polling GET.

## Data model

Two tables, both append-only by convention:

* `DiagnosticSubmission` — one row per completed submission. `email` is
  always captured (signed-up users included); `user_id` is null until the
  lead claims their submission via signup. JSON columns: `answers`,
  `scores`, `bucket`. No FK cascade on `user_id` — deleting a User keeps
  the lead row intact for funnel attribution.
* `AiRoadmap` — 1:1 with submission. Generated async; `status` is
  `ready` or `failed`. Re-running the AI call upserts the row.

See `docs/diagnostic.md` for the operator runbook (GDPR posture, scoring
formula, prompt template, schema).

## What this module does NOT do

* No PII flows back through `GET /diagnostic/questions`. The catalog is
  the same for every caller.
* The endpoint does not authenticate the caller of `GET
  /diagnostic/:submissionId`. **Do not** add private fields to the
  response — it is callable by anyone with the submission id (which is a
  uuid). The submission id is the access token.
* AI generation is fire-and-forget: the controller returns
  `submission_id` immediately and the client polls. There is no
  websocket / push channel.
