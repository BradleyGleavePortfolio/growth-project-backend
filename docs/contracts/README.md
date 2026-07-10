# Importer public contract (R80 freeze)

`importer-openapi.json` is the **frozen public contract** for the tgp-importer
Chrome extension and the mobile pairing surface. It is an OpenAPI 3.1 slice
covering exactly these routes:

| Method + path                      | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| `POST /api/auth/extension/refresh` | Rotate the extension's Supabase session      |
| `POST /api/extension/pair/init`    | Mint a 6-digit pairing code (mobile)         |
| `POST /api/extension/pair/status`  | Poll a pairing code's status (mobile)        |
| `POST /api/extension/pair/redeem`  | Exchange a code for a token pair (extension) |
| `POST /api/scout/ingest`           | Ingest a batch of crawled entities           |
| `POST /api/scout/progress`         | Mirror a crawl progress snapshot             |
| `POST /api/scout/ingest/complete`  | Settle an import to its terminal state       |

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

This boots the Nest application factory (no network socket), extracts the seven
routes plus every schema they reference, re-adds the `/api` global prefix, deep
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
the `PairRedeemErrorDto` failure enum, camelCase provenance inside the
snake_case scout envelope, strict ISO-8601 `capturedAt`), so a regeneration that
silently changes them is caught in review.

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
