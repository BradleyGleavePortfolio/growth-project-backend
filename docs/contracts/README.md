# Importer public contract (R80 freeze)

`importer-openapi.json` is the **frozen public contract** for the tgp-importer
Chrome extension and the mobile pairing surface. It is an OpenAPI 3.1 slice
covering exactly these routes:

| Method + path                         | Purpose                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /api/auth/extension/refresh`    | Rotate the extension's Supabase session                                          |
| `POST /api/extension/pair/init`       | Mint a 6-digit pairing code (mobile)                                             |
| `POST /api/extension/pair/status`     | Poll a pairing code's status (mobile)                                            |
| `POST /api/extension/pair/redeem`     | Exchange a code for a token pair (extension)                                     |
| `POST /api/scout/ingest`              | Ingest a batch of crawled entities                                               |
| `POST /api/scout/progress`            | Mirror a crawl progress snapshot                                                 |
| `POST /api/scout/ingest/complete`     | Settle an import to its terminal state                                           |
| `GET /api/scout/import/status`        | Read a crawl import's settlement status                                          |
| `GET /api/scout/reconstruct`          | Read reconstruction progress for an intent                                       |
| `GET /api/scout/reconstruct/entities` | Read a settled intent's reconstructed non-person canonical entities (IMPORTER-I) |
| `GET /api/scout/reconstruct/roster`   | Read a settled intent's reconstructed invite-pending client roster (IMPORTER-G)  |

### Scope — what is intentionally NOT in the contract

`POST /api/auth/extension/login` is extension-facing but deliberately **excluded**.
It is a thin variant of the general `POST /api/auth/login` (it proxies Supabase
`signInWithPassword` and returns the raw Supabase session verbatim, only tagging
`source=extension` in the audit log). It shares `/auth/login`'s general auth
semantics and Supabase-owned session shape, not the importer's bespoke pairing
lifecycle. The contract governs the **pairing bootstrap** the extension depends
on — `pair/redeem` (code → token pair) and `auth/extension/refresh` (rotate that
pair) — whose shapes are unique to this surface. Pulling `extension/login` in
would couple the frozen importer artifact to the general Supabase login response,
which evolves on its own cadence, for no client-visible pairing benefit.

## Source of truth

The artifact is **generated**, never hand-edited. It is sliced out of the
backend's authoritative `@nestjs/swagger` document, so the DTOs, response types,
enums, and status codes in the JSON are exactly what the running server accepts
and emits. The single definition of "what the contract is" lives in
`scripts/importer-contract.ts`.

## Regenerating

```bash
npm run contract:importer
```

This boots the Nest application factory (no network socket), extracts the
importer routes plus every schema they reference, re-adds the `/api` global prefix, deep
key-sorts the result for byte-stability, and writes this file.

## Drift protection

`test/contracts/importer-contract.spec.ts` re-derives the contract from the live
Swagger document and asserts the checked-in JSON is **byte-identical**. If you
change an importer DTO, response, enum, or route without regenerating, the test
fails:

```
Expected the checked-in artifact to equal a fresh regeneration.
→ run `npm run contract:importer` and commit the result.
```

The same suite pins the semantic invariants clients depend on (status codes,
the shared `ErrorEnvelope` / `RateLimitError` bodies and their pinned `code`
enums, camelCase provenance inside the snake_case scout envelope, strict
ISO-8601 `capturedAt`), so a regeneration that silently changes them is caught
in review.

## Error bodies

Every importer 4xx/5xx references one of two **shared** schemas that mirror the
server's real runtime output — not a per-route shape:

- **`ErrorEnvelope`** — the body emitted by the global `HttpExceptionFilter`
  (`src/filters/not-found-envelope.ts`). Always carries
  `statusCode`, `message`, `error`, `timestamp`, `path`; `code` and `request_id`
  are present only when set. `message` is a **string** for most errors and a
  **string array** when the global `ValidationPipe` reports one entry per failed
  constraint (e.g. a malformed `pair/redeem` body). Where a status has a fixed
  machine-readable `code`, the response composes `ErrorEnvelope` with an
  `allOf` that pins the `code` enum (required on `auth/extension/refresh` 401 and
  `pair/redeem` 410; optional-but-pinned on `pair/redeem` 400 and `pair/init` 400,
  both of which can also arrive code-less from the ValidationPipe — the domain
  paths set `invalid` and `code_mint_failed` respectively).
- **`RateLimitError`** — the `429` body emitted by `ThrottlerExceptionFilter`.
  It is intentionally a different shape (`retryAfter`, matching the
  `Retry-After` header; no `timestamp`/`path`), so it is a distinct schema.
  Every importer route can emit it: `pair/redeem` under its explicit per-IP
  `@Throttle`, and the authenticated routes (`pair/init`, `pair/status`, the
  scout routes) under the global authenticated default enforced by
  `UserThrottlerGuard`, so the `429` is documented on each for parity.

## Generating clients

The artifact is standard OpenAPI 3.1 and works with any generator. Examples:

**TypeScript types (extension / mobile):**

```bash
npx openapi-typescript docs/contracts/importer-openapi.json \
  -o src/generated/importer-contract.d.ts
```

**A full typed client (openapi-generator):**

```bash
npx @openapitools/openapi-generator-cli generate \
  -i docs/contracts/importer-openapi.json \
  -g typescript-fetch \
  -o ./importer-client
```

Consumers should generate their types **from this file** rather than
hand-writing request/response shapes — that is what keeps the extension, the
mobile app, and the backend in lockstep behind a single frozen contract.

## Notes

- Paths are shown with the real `/api` prefix that clients call. The in-memory
  Swagger document records bare paths (the prefix is applied at runtime via
  `setGlobalPrefix`); the generator re-adds it.
- The `bearer` security scheme is a Supabase-issued JWT sent as
  `Authorization: Bearer <token>`. `pair/redeem` is intentionally unauthenticated
  (the extension has no token yet — that's what it's redeeming for).
- Feature gating (`FEATURE_EXTENSION_PAIRING`, `FEATURE_SCOUT_INGEST`) returns a
  uniform `404` at the edge while a flag is off; the `404` response is part of
  the contract.
