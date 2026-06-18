# Error contract

Marketplace errors are normalized by the global
[`HttpExceptionFilter`](../../src/filters/http-exception.filter.ts) (`@Catch()`).
This document specifies the wire envelope, how the filter builds it, the code
discriminators in use today, and one honest inconsistency — the legacy `kind`
field that never reaches the client.

## The envelope

Every error response is JSON in this shape:

```json
{
  "statusCode": 404,
  "code": "job_listing_not_found",
  "message": "Job listing not found",
  "error": "Not Found",
  "timestamp": "2026-06-18T00:00:00.000Z",
  "path": "/api/talent-marketplace/public/listings/...",
  "request_id": "..."
}
```

| Field | Always present | Source |
|-------|----------------|--------|
| `statusCode` | yes | `HttpException.getStatus()`, else 500 |
| `message` | yes | exception body `message`, else the exception message |
| `error` | yes | exception body `error`, else the exception class name minus `Exception` |
| `code` | no | exception body `code` (string) — additive, machine-readable |
| `timestamp` | yes | `new Date().toISOString()` at catch time |
| `path` | yes | `request.url` |
| `request_id` | when present | injected by `RequestIdMiddleware` |

## How the filter builds it

From [`http-exception.filter.ts`](../../src/filters/http-exception.filter.ts):

- For an `HttpException` with a string response, the string becomes `message`
  and `error` is the class name minus `Exception`.
- For an `HttpException` with an object response, the filter reads `message`,
  `error`, and `code` off the body. `code` is included on the wire **only** when
  it is a string.
- A non-`HttpException` error is logged (with stack) and returned as a generic
  500 — internal details are never leaked to the client.
- 5xx responses are forwarded to Sentry with method/path/status tags; 4xx are
  not (they are caller mistakes and would be noise).

The filter is strictly additive: clients that read only `message` are
unaffected, and `code` is a stable handle clients may switch on.

## Code discriminators in use

Set by TM-3 public read
([`public-listing.service.ts`](../../src/talent-marketplace/public-listing.service.ts)):

| `code` | HTTP | When |
|--------|------|------|
| `job_listing_not_found` | 404 | detail id is missing, draft, or closed |

The merge-ready TM-5 apply funnel (PR #435, not on `main`) introduces further
`code` discriminators (e.g. an `apply_in_flight` replay/contention signal backed
by the idempotency ledger). Those are intentionally **not** enumerated here as a
stable contract until PR #435 merges.

## The `kind` gap (TM-2)

TM-2 hirer CRUD
([`job-listing.service.ts`](../../src/talent-marketplace/job-listing.service.ts))
and `HirerVerifiedGuard`
([`hirer-verified.guard.ts`](../../src/talent-marketplace/hirer-verified.guard.ts))
predate the `code` convention and throw exception bodies keyed on `kind`:

- `{ kind: 'job_listing_not_found' }` — 404
- `{ kind: 'job_listing_not_owned' }` — 403
- `{ kind: 'job_listing_closed' }` — 400
- `{ kind: 'invalid_compensation_terms', message }` — 400
- `{ kind: 'hirer_not_verified' }` — 403 (guard)

The `HttpExceptionFilter` does **not** read `kind`. It reads only `message`,
`error`, and `code`. So on these routes `kind` is **dropped** before the wire:
the client receives a correct `statusCode` and `message`, but **no `code`
field**. This is a known inconsistency — TM-3 (and the merge-ready TM-5) emit a
machine-readable `code`; TM-2 does not yet. It is documented here rather than
papered over. Aligning TM-2 onto `code` is a follow-up, not a shipped contract.

The anti-bot gate (TM-6,
[`anti-bot.guard.ts`](../../src/talent-marketplace/anti-bot/anti-bot.guard.ts))
carries its own `reason` field (e.g. `duplicate_device`) on its 403/428/429
bodies alongside `statusCode`/`error`/`message`. The body is uniform across
verdicts so a prober cannot infer which heuristic fired.
