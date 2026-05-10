# Diagnostic engine — operator runbook

Phase 3. The 40-point diagnostic is a public lead-capture funnel. A
visitor answers 40 Likert questions, the system computes scores + an
overall bucket, and an async AI roadmap lands on the submission. This
runbook covers the schema, the scoring formula, the prompt, and the
GDPR posture so an operator can reason about it without reading the code.

## At a glance

| Surface                          | Auth        | Rate limit                   | Notes                             |
| -------------------------------- | ----------- | ---------------------------- | --------------------------------- |
| `GET /api/diagnostic/questions`  | public      | default (60/min/IP)          | Catalog only; no PII.             |
| `POST /api/diagnostic/submit`    | public      | `diagnostic-submit` 5/h/IP   | Persists, kicks off AI.            |
| `GET /api/diagnostic/:id`        | public      | default                      | Poll for roadmap.                  |

The endpoints are mounted under the global `/api` prefix
(`src/main.ts setGlobalPrefix('api')`). Public-page renders (HTML)
already use the no-prefix path; this module is JSON-only and lives
inside the API namespace.

## Schema

```
DiagnosticSubmission
  id            uuid pk
  email         text NOT NULL              -- always captured
  name          text
  age           int
  source        text                       -- UTM-style: 'web' | 'mobile_signup' | 'invite_link' | 'lead_magnet' | …
  answers       jsonb NOT NULL             -- [{ question_id, answer }] verbatim
  scores        jsonb NOT NULL             -- { income, body, lifestyle, *_raw, overall_raw }
  bucket        jsonb NOT NULL             -- { income, body, lifestyle, overall, overall_headline }
  submitted_at  timestamptz NOT NULL DEFAULT now()
  user_id       text                        -- nullable; back-filled when the lead signs up
  ip            text
  user_agent    text

AiRoadmap (1:1 with submission)
  id              uuid pk
  submission_id   text UNIQUE → DiagnosticSubmission(id) ON DELETE CASCADE
  generated_at    timestamptz NOT NULL DEFAULT now()
  prompt_version  text NOT NULL DEFAULT 'v1'
  status          text NOT NULL DEFAULT 'ready'  -- 'ready' | 'failed'
  payload         jsonb                          -- { summary, top_strength, biggest_gap, ninety_day_focus, raw_text }
  tokens_used     int
  model           text NOT NULL DEFAULT 'sonar-pro'
  error_message   text
```

Both tables are append-only by convention. Re-submitting writes a new
`DiagnosticSubmission` (and a new `AiRoadmap` when the retry succeeds);
we never UPDATE answers in place.

## The 40 questions

Source of truth: `prisma/seed-diagnostic.json`. Loaded at module init
and cached. Editing the file is a marketing change, not a technical
one — every question is positioning copy. The doctrine spec
(`test/diagnostic-prompt-doctrine.spec.ts`) does not pin the question
texts, but `test/diagnostic.controller.spec.ts` spot-checks Q1 verbatim.

Sections:

* **Income Architecture** — questions 1–15 (15 questions, raw 15–75)
* **Body Protocol** — questions 16–27 (12 questions, raw 12–60)
* **Calendar & Lifestyle Architecture** — questions 28–40 (13 questions, raw 13–65)

Likert: `1=Strongly disagree, 5=Strongly agree`.

## Scoring formula

```
section_pct = (section_raw - n_questions)
            / (n_questions * 5 - n_questions)   -- aka n_questions * 4
            * 100
```

This anchors all-1s to 0 % and all-5s to 100 %. The brief's section
bands are bucketed by **rounded** percentage:

```
0–30  → stuck
31–60 → moving
61–100 → compounding
```

The overall band uses the **raw** sum (range 40–200), because the
brief's cutoffs are written in raw points:

```
0–70   → stuck        — "You have the raw material. The system is missing."
71–130 → moving       — "You're in motion. The question is: motion toward what?"
131–200 → compounding  — "You're building. The gap is acceleration."
```

The overall headline is stored on the submission (in `bucket.overall_headline`)
so a future re-bucketing migration does not silently change the message
the user already saw.

## AI prompt

`ROADMAP_SYSTEM_PROMPT` in `src/diagnostic/ai-roadmap.service.ts`.
Voice rules:

* No emoji, exclamation marks, or em-dashes.
* No corporate wellness vocabulary, no motivational hype.
* Numbers over adjectives; cite the section scores.
* Direct address ("you"), present tense, second person.
* 300–400 words total (do not exceed 400).
* Four paragraphs, in order, separated by blank lines:
  1. Overall assessment
  2. Top strength
  3. Biggest gap (with one concrete recommendation)
  4. The next 90 days (with weekly cadence)
* Plain text only. No Markdown headings. No numbered output.

The user-prompt builder appends:

* The three section scores (% + raw + bucket)
* Overall raw score + bucket + headline
* Three lowest-scoring questions per section (id + text + answer)

The model is `sonar-pro` via the OpenAI-compatible Perplexity endpoint
(same shim as `AiService`). `temperature=0.4`, `max_tokens=700`.

Failures are caught and persisted as `AiRoadmap{status='failed'}`. The
submit endpoint already returned 200; failures never bubble to the user.

## Rate-limit posture

`POST /api/diagnostic/submit` is unauthenticated. The named throttler
`diagnostic-submit` defaults to **5 requests / hour / IP**. Tracker:
client IP (UserThrottlerGuard falls back to IP when there is no JWT).

`DIAGNOSTIC_RATE_LIMIT_PER_HOUR` overrides the limit at boot. Clamped to
`[1, 1000]`. The TTL is fixed at one hour.

If REDIS_URL is set, the throttler is shared across Fly machines; if
not, in-memory tracking — limits do NOT cross machines. For the
diagnostic surface this is acceptable in single-machine staging, but
prod must run REDIS_URL for the limit to mean anything.

## GDPR / lead lifecycle

The diagnostic captures `email` for every submission, including signed-up
users. The flow:

1. Anonymous submit → `DiagnosticSubmission{user_id=null, email}`.
2. The lead later signs up. The auth flow (or a CRM webhook) calls
   `DiagnosticService.attachUser(email, userId)` which back-fills
   `user_id` on every prior null-user-id submission with the same email.
3. From that point onward the submissions are joined to the user
   identity. The existing GDPR scrub (`src/users/gdpr-scrub.service`)
   sees them via the `user_id` FK, so an account deletion sweeps the
   diagnostic rows along with everything else.
4. Anonymous leads with `user_id=null` are out of scope for the
   user-driven scrub. The marketing/CRM team owns lead retention there;
   a separate batch job (out of scope for Phase 3) can reap by
   `submitted_at` if/when a retention policy is set.

The endpoint is unauthenticated, so the IP and user-agent are stored on
the row for fraud / abuse review. Both columns are nullable; nothing
else relies on them.

## Operator playbook

* **Catalog edit** — update `prisma/seed-diagnostic.json`, bump
  `version` to `v2`, ship. The doctrine specs are not catalog-bound, but
  the controller spec spot-checks Q1's text — update it if you renumber.
* **Bucket edit** — update `prisma/seed-diagnostic.json` `buckets` block
  AND the `sectionBucket` / `overallBucket` helpers. Stored historical
  rows keep the bucket they were written with, because the bucket is
  computed at submit-time and persisted, not recomputed on read.
* **Prompt edit** — edit `ROADMAP_SYSTEM_PROMPT`, bump
  `ROADMAP_PROMPT_VERSION` (e.g. `v2`), update
  `test/diagnostic-prompt-doctrine.spec.ts` in the same PR.
* **AI provider outage** — set `DIAGNOSTIC_AI_ENABLED=false` to stop
  burning Perplexity tokens; submissions still land, with a placeholder
  roadmap. Re-enable when the provider recovers.
