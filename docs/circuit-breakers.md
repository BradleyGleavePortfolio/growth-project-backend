# Per-client circuit breakers

Every outbound call to an external PII-touching client (Stripe, Mux, SendGrid,
Anthropic, OpenAI, ...) flows through an Opossum circuit breaker. When an
upstream is failing or slow, the breaker trips open and fails fast with a 503
instead of letting requests pile up against a dead dependency. This is the
household-fuse metaphor: each fuse is rated for the circuit it protects.

Opossum is the maintained Node descendant of Netflix Hystrix. Hystrix
popularised the circuit-breaker pattern for distributed systems; Opossum brings
the same rolling-window, open/half-open/closed state machine to Node, and is
the library this codebase standardises on (D-H6-2).

## Per-client thresholds (D-H6-2 LOCKED)

The thresholds are deliberately NOT uniform:

> "Circuit breakers are tuned per-client because SendGrid, Stripe, and Mux have
> nothing in common operationally" (D-H6-2, LOCKED 2026-06-26)

The single source of truth is `src/circuit-breakers/circuit-breaker.constants.ts`:

| Client       | `timeout` | `errorThresholdPercentage` | `resetTimeout` | Rationale                                                                                                |
| ------------ | --------- | -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| **Stripe**   | 15 s      | 50%                        | 30 s           | Payment-grade tolerance; Stripe p99 latency is high and a tripped payment path is worse than a slow one. |
| **Mux**      | 10 s      | 50%                        | 30 s           | Video upload latency expectations.                                                                       |
| **SendGrid** | 5 s       | 30%                        | 30 s           | Transactional email; fail fast, low tolerance.                                                           |
| **default**  | 8 s       | 50%                        | 30 s           | All other PII clients (Anthropic, OpenAI, Twilio, ...).                                                  |

- `timeout` — ms before a call is considered failed/slow.
- `errorThresholdPercentage` — % of failures in the rolling window that trips
  the breaker open.
- `resetTimeout` — ms the breaker stays open before probing half-open.

`resolveBreakerConfig(clientName)` resolves the config case-insensitively and
falls back to `default` for any client without a bespoke entry.

## How a call is wrapped

`createBreaker(clientName, fn, opts?)` wraps an async function in a per-client
breaker and returns a callable with the same signature. Wrap only the call
boundary; do not refactor client logic:

```ts
private guardedFetch = createBreaker(
  'stripe',
  (url: string, init: RequestInit) => this.fetchImpl(url, init),
  { key: `stripe:${StripeApiService.instanceSeq++}` },
);
```

Breakers are cached by `key` (default = `clientName`) so the rolling error
window is shared across calls to the same logical client. There is no Opossum
fallback configured: a fallback would mask the outage. The breaker's job is to
fail fast and loud, not to fake success (NO FAKE SUCCESS doctrine).

## How to read a CircuitOpenError

When the breaker is open, the wrapped callable rejects with `CircuitOpenError`
(carrying the `clientName`). The global `CircuitOpenFilter`
(`src/circuit-breakers/circuit-open.filter.ts`, registered in `main.ts`) maps
it to a clean HTTP 503 Service Unavailable with a `Retry-After: 30` header and a
structured body:

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "Upstream service temporarily unavailable (stripe). Please retry shortly.",
  "code": "circuit_open",
  "client": "stripe",
  "timestamp": "2026-06-26T20:00:00.000Z",
  "path": "/v1/payments"
}
```

`Retry-After: 30` is an honest hint: every client's `resetTimeout` is 30 s, so
that is when the breaker next probes half-open. A 503 with `code: circuit_open`
means the upstream is being shed, not that the request itself was malformed.
Clients (including the mobile app) should back off and retry rather than treat
it as a permanent failure.

## How to tune

1. Edit the per-client entry in
   `src/circuit-breakers/circuit-breaker.constants.ts` — it is the only place
   timeouts and thresholds are defined. Nothing else hard-codes them.
2. Add a new bespoke entry for a client only when its operational profile
   genuinely differs from `default`; otherwise let it fall through to
   `default`.
3. Lower `errorThresholdPercentage` or `timeout` to trip faster (fail fast on a
   flaky dependency); raise them to tolerate more transient errors before
   shedding load.
4. `resetTimeout` controls how long the breaker stays open before testing
   recovery. If you change it away from 30 s for a client, update the
   `Retry-After` hint logic in the filter so the advertised retry window stays
   honest.

## Sources

- Operator decision D-H6-2 — `OPERATOR_DECISIONS_LOG.md`, 2026-06-26.
- Opossum (Node circuit breaker): https://github.com/nodeshift/opossum
- Netflix Hystrix (circuit-breaker lineage): https://github.com/Netflix/Hystrix/wiki
