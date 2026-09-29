# L0: learn-and-remember — decode, learn, import, verify, remember, in one process

- **Status:** T4 cross-repo decision record (backend, extension, mobile). Doc only: it changes no code,
  schema, API or flag, claims nothing has run, and grants no builder, PG slot or review.
- **Date:** 2026-09-27; **r2/r3 amendments 2026-09-28; r4 2026-09-29; r5 2026-09-29 (executive
  reset); r6 2026-09-29 (owner decisions D9-D14 applied); r7 2026-09-29 (r6 T4 audit closure,
  FAM-0 r9 amendments); r8 2026-09-29 (scope reduction: contracts, invariants and acceptance tests
  instead of browser mechanism).** **Decision owner:** Bradley Gleave. The executing parent makes
  D-L0-1 to D-L0-9; §6 lists what stays owner-reserved.
- **r8 (2026-09-29), doc-only; operator direction under the T4 doctrine (repeated failure ⇒ reduce
  scope).** r7 failed both re-audits (`R581-c7A2`, `R581-c7B2`) on browser-mechanism detail a
  record cannot prove on paper. r8 **deletes mechanism claims** and binds **contracts, invariants
  and acceptance tests** the owning slices (X2b, X3, FAM-M1, L2b, L2c, L2d) must pass on the real
  packaged MV3 extension (D-L0-6.2). Dispositions 1-8: credential invariants with an honest
  transient-exposure bound and frame provenance, worker restart never resumes; origin = scheme +
  host + port; the no-mutation bound covers explore navigation; round-2 truncation never refuses;
  media deferred whole to FAM-M1; Person links scoped to coach and platform;
  `native_target_removed` counts as moved. Shorter than r7; §8 r8 rows, FAM-0 r10 amendments applied.
- **r7 (2026-09-29).** Closed `R581-c7A`/`R581-c7B`: identity matching and monotone round 2
  (D-L0-3); per-record C2-C4 (D-L0-4); few-shot inside the untrusted block (D-L0-7.1); L2d
  activation, FAM-C1 as catalogue owner, #589/#591 owed lists (D-L0-9); FAM-0 r9 amendments
  (D-L0-6.3). Its credential model and media authority are **superseded by r8**.
- **r6 (2026-09-29).** Owner decisions D9-D14/B2 recorded; billing and partner-origin data move
  (D-L0-6.1); the AI proposes a `family` label, never a destination (D-L0-4); base `249fd0d4`.
- **r5 (2026-09-29) — the binding executive reset after r4 failed both T4 re-reviews.**
  Completeness is **decoupled from learning**: until the completeness-closure record (**CL**) lands
  every run settles `partial` with gap `completeness_not_proven` and a false `complete` is
  impossible by construction (D-L0-6); closure machinery deleted, per-family counting evidence
  kept; memory is **per coach** in V1 (D-L0-5); the one `RunStatusProjectionV1` is owned here
  (D-L0-6.3); §9 lists every closure finding as a required input to CL.
- **Owner decisions of 2026-09-28 (binding; verbatim except where bracketed):**
  - **D1, what "complete" means:** _"lets do complete to mean 'All past client and coaching records
    in this site are now in TGP'"_. Unchanged. Under r5 it **cannot yet be claimed** by any run;
    CL will define how it is proven (D-L0-6, §9).
  - **D2, V1 pilot:** _"Lets do [the owner-chosen V1 pilot platform] as the pilot, my coaching
    account"_ → the pilot is the owner's own coaching account on that platform (name in evidence, not
    here).
  - **D3, AI spend cap:** _"$20/day ... lets just leave the cap alone/ placeholder value until we learn
    the real cost per site"_ → D-L0-7.3.
- **Owner decisions of 2026-09-29 (binding; recorded as decided):**
  - **D1 reaffirmed, no narrowing.** `complete` means **all** client and coaching records the site
    holds are in TGP; any reachable family that did not land makes the run `partial` and is named.
  - **D4, no unsupported families.** Anything reachable moves into TGP: native (the canonical
    contract expanded to every family TGP models) or **preserve** (a universal tenant-scoped
    preserved-record destination; preserved records count as "in TGP"). Detail: **FAM-0**
    (`docs/decisions/2026-09-29-fam0-all-families.md`, PR #590); principles and slice placement here
    (D-L0-6.1, D-L0-9).
  - **D5, honesty detail.** A `partial` run shows the coach, per family, what came and what did not
    — unknown as unknown, never 0 — in the popup and the Roman result, both from the **one** server
    projection (D-L0-6.3; X4, R2).
  - **D6, backend origin.** `https://backend-spring-lake-3890.fly.dev`; `tgp.coach` is unregistered
    and must not be used (D-L0-1; X0).
  - **D7, origins.** One Start authorizes only the tab's origin (X1); cross-origin data APIs are
    reached **without extra permission** by replaying learned GET/HEAD templates from the authorized
    page's own main world (D-L0-6.2); the registrable-domain wildcard is later (D11).
- **Owner decisions of 2026-09-29 09:52-11:00 PDT (binding; recorded as decided in r6; the r5 items
  P1-P6 are closed by them, none pending):**
  - **D9 (was P1), popup Start:** exactly one Start button; everything else is status (D-L0-1.1).
  - **D10 (was P2), billing:** billing and payment history **MOVE** (preserved, coach-visible, a
    **per-client next payment date** carried; the live charge does not move); FAM-0 **D-FAM-5** owns
    the detail; billing is a moving family, never a gap or exclusion (D-L0-4, D-L0-6.1).
  - **D11 (was P3), registrable-domain fallback:** later, not default. **D12 (was P4), media storage
    spend:** approved; existing S3-compatible storage (FAM-M1). **D13 (was P5), Web Store:** later.
  - **D14 / B2 (was P6), partner and third-party data.** Data reachable through the coach's own
    logged-in page **MOVES**. Bounds: read-only GET/HEAD replay of requests the authorized page itself
    made, re-attaching only the credential header the page itself sent to that same origin; no stored
    credential, no new login, no mutation, rate-bounded, **every outside origin named in the result**
    (D-L0-6.1, D-L0-6.2, D-L0-6.3 `outside_origins[]`). FAM-0 D-FAM-1 "Partner-origin rule" owns
    the capture-time origin rule; this record references it and does not duplicate it. The
    credential bound is stated as **invariants and acceptance tests** in D-L0-6.2 (r8), not as a
    browser mechanism; it narrows nothing the owner decided.
- **North star:** `private-evidence/execution/42d8c5b5/northstar/NORTH_STAR.md` ("NS"). Owner
  requirement (2026-09-27 20:51Z, verbatim): _"This is a new site" → call AI support, decode their
  data structure, autonomously LEARN AND REMEMBER that structure and complete the import in one
  process to NEVER have to do platform specific work again._
- **Read trees (r6).** `B:` = backend `integration/importer`
  `249fd0d431279a8eb115354d6099d93c9eca8f1a` (L2a merged; line citations into
  `lifecycle.service.ts`, `scout-ingest.service.ts` and `observation.service.ts` re-read there,
  every other cited file is byte-identical to r5's `d6cf9eb6`). `E:` = extension `main`
  `efb3fd18200bcfa4b9e6ab386bf10da6d3d44b6f`. `E-X1:` = X1 PR #35 head
  `142501a2febfb7584b72929badb98f7cba9c7730`. `M:` = mobile `main`
  `adf3f2b9cf5947aa76a6488bc4b867069dcc6a27`. `L3:` = PR #589 head `61b0d251` (r2, **read as is;
  not yet aligned** — its owed changes are listed at D-L0-9 L3a). Unprefixed `path Lx` is `B:`.
- **`LO` (legacy oracle).** The one quarantined file spec under `src/scout/reconstruct/sources/` and
  the extension's legacy extractor/blueprint (`E:extractors/`, `E-X1:legacy/`), both in each repo's
  `.vendor-name-guard.json`.
- **Fixed inputs (incorporated, not redesigned):** X1 origin authorization (`northstar/X1_GRANT.md`);
  R1 Roman journey (`northstar/R1_GRANT.md`); C2b-1 (`E:` #32); **L1-gw** (PR #592, `cand/x44/l1-gw`
  `df330304`, fail-closed `importer.mapping` gateway, D-L0-7.5); **L1** (PR #591, `cand/x44/l1-core`
  `debce080`, the pure learn contract library, D-L0-9); **L2a** (PR #588, **merged** as
  `249fd0d4`, `SourceRegistryProvider`); **FAM-0 r9** (PR #590 `0924fc1`, D4/D10/D14 detail; it
  references D-L0-6.3 by name); **FAM-0 r10** (`61c7c97f`, read for r8: its §8.1 amendments
  L0-A2′/A4′/A5/A6/A7/A8 and the D-FAM-1 executive interpretation of D14 are applied, D-L0-6.2,
  D-L0-6.3; r8's asks to FAM-0's next round are in §8).
- **Sources:** S7L-DOC, S8-DOC, S9-DOC, S10-DOC, S11-DOC, S8D-DOC, S12-B2 (test-only artifacts refused
  outside dev/test, `src/scout/induction/manifest-registry.ts` L29-46), EX1.

## 1. Why this exists

The backend engine is data-driven per platform: a generic interpreter over a JSON `SourceMappingSpec`
(`src/scout/reconstruct/mapping-spec.ts` L114-125, L334-376), native rules
(`src/scout/reconstruct/native/native-rules.ts` L93-100, L794) and the S10 manifest
(`src/scout/induction/manifest-registry.ts` L44-80). But every spec is a file in `src`, shipped by a
deploy; the only real spec is `LO`'s; no AI exists in `src/scout`; there is no memory. The extension
has capture (`E:shared/capture.js`), the C2a primitives, endpoint roles (`E:shared/blueprint/roles.js`
L417), a fail-closed normalizer (`E:shared/replay/blueprint.js` L393) and a generic replay engine
(`E:shared/replay/engine.js` L112), but nothing turns a capture into a blueprint. Three gaps close
here: **G1** nothing decodes an unseen structure; **G2** nothing remembers one without a deploy;
**G3** no flow runs decode → import → verify from one Start with zero coach actions (NS). Proving
that an import is _complete_ is a fourth problem; r5 assigns it to CL (§9) so that this record can
converge.

## 2. Decisions

### D-L0-1: the one process

One server-owned run (S7-L `mode='server'`, `prisma/schema.prisma` L6866-6873). The extension is the
executor on the coach's computer; the backend is the brain and the memory; the phone and the popup
are status surfaces. The TGP API origin is `https://backend-spring-lake-3890.fly.dev` (D6):
`E:shared/protocol.js` L3 and `E:manifest.json` L33 still name `api.tgp.coach`; slice **X0**
replaces both before X3.

| #   | Step            | Where    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                | Roman screen                        | Status read                                                           |
| --- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| 1   | Pick the site   | phone    | Setup creates the `ImportIntent` (`POST extension/pair/init`, `chosen_platform` slug, `src/extension-pair/extension-pair.dto.ts` L26-36; picker `M:src/constants/importPlatforms.ts` L23-28 incl. `custom`). The slug is a label; the run's identity is the authorized origin. A custom URL that does not match the tab origin is refused with a stable code.                                                               | `ImportSetupView` `source`          | `pair/session` readiness (S11 D-S11-5)                                |
| 2   | Authorize       | computer | X1: the popup's one gesture requests the optional host permission for the tab origin; granted origin = the run's single authorized origin, revoked at settle (D-L0-1.1).                                                                                                                                                                                                                                                    | `computerHandoff`                   | —                                                                     |
| 3   | Start once      | computer | `POST scout/runs/start` with `import_intent_id` (`src/scout/lifecycle/run.controller.ts` L88-97); server clock and deadline start (D-S7L-3; D-L0-7.3). `POST scout/runs/declaration` (`observation.controller.ts` L95). Zero coach actions from here.                                                                                                                                                                       | `ImportProgressView` `finding`      | `running` / `discovering` (`M:src/types/importRunStatus.ts` L55)      |
| 4   | Observe         | computer | Attach capture to the authorized tab (`E:shared/capture.js` L202), reload once (the reload URL passes the D-L0-6.2 navigation bound), wait for network idle, record the origins the page itself contacted and, per origin and frame, the non-cookie credential headers its requests carried (worker memory only, D-L0-6.2), inventory in-app link paths, build `StructureDigestV1` (D-L0-2). Values never leave the device. | `finding`                           | `discovering`                                                         |
| 5   | Decode, explore | backend  | `POST scout/runs/learn` (D-L0-3): per-coach memory or model call. Model returns data only (D-L0-4). Explore: the extension visits every uncaptured in-app link template by URL that passes the D-L0-6.2 navigation bound, bounded (D-L0-7.3); round 2 re-submits the union digest.                                                                                                                                          | `finding`                           | `discovering`                                                         |
| 6   | Learn           | backend  | The accepted package is stored as a version of **this coach's** memory for the slug and pinned to this run and round (D-L0-5). A reused package skips the model call after re-validation.                                                                                                                                                                                                                                   | `finding`                           | `discovering`                                                         |
| 7   | Crawl           | computer | `compileLearnedBlueprint` rebinds slots, `:q` values and header values from this run's own capture (D-L0-2) → `normalizeBlueprint` (`blueprint.js` L393) → `runReplay` (`engine.js` L112) with the per-origin fetch router under the D-L0-6.2 credential and no-mutation invariants → `POST scout/ingest` batches. Per-step evidence is uploaded (D-L0-6).                                                                  | `transferring`                      | `phase: transferring`, `families[]`                                   |
| 8   | Map             | backend  | Staged rows resolve through the run's pinned package in the one registry provider: `SourceRegistryProvider.forRun(db, coachId, intentId)` (merged L2a, `source-registry.provider.ts` L262; D-L0-5).                                                                                                                                                                                                                         | `transferring`                      | —                                                                     |
| 9   | Reconstruct     | backend  | Claim via `POST scout/ingest/complete` (`scout.controller.ts` L110). Conformance C0-C4 (D-L0-4) **per family** in its own locked transaction before `reconstructRun` (`lifecycle.service.ts` L459); a failing family is dropped and disclosed, the others proceed; S8-G reconstruct (native) and the preserve writer (FAM-0 FAM-P2) through `destinationFor`.                                                               | `checking`                          | `phase: reconciling`                                                  |
| 10  | Verify, verdict | backend  | S9 reconcile → S10 evaluator with `closure: null` → arbiter → CAS terminal (`lifecycle.service.ts` L453-497, `writeTerminal` L497). The AI has no input. Under r5 the verdict is `partial/coverage_basis_unknown` at best (D-L0-6); the detail is in the projection.                                                                                                                                                        | `ImportResultView` (R1 adapter; R2) | terminal `status`, `reason_code` (`reason-codes.ts` L50-60), D-L0-6.3 |
| 11  | Remember        | backend  | In the settle transaction after the CAS: this coach's pinned version is marked `accepted` or `suspect` from persisted, server-computed inputs only (D-L0-5). No cross-coach row is written in V1.                                                                                                                                                                                                                           | —                                   | —                                                                     |

Binding to `E#19`: C2a/C2b-1 survive as digest evidence; the normalizer and engine survive with the
X2b changes; C2c → `compileLearnedBlueprint`; A2 → one action, _navigate the authorized tab to an
inventory URL_; C3b → the deterministic gate. **Deleted:** C2b-2 edges, C2b-3 pagination inference,
confidence scoring, Learn UI, coach confirmation, DOM/SSR fallback, a separate memory slice.

#### D-L0-1.1 Where Start happens (owner D9; `R581-B-B7`)

NS says the popup is a status surface, but an optional host permission is granted only inside a user
gesture in the extension's own UI (X1). **Decided (D9):** the popup carries **exactly one Start
button** — _Start = authorize this site_ — and everything else in it is status (X4); the Roman
journey owns pairing, source choice, progress and the verdict; the phone's Start step reads _press
Start in the extension on your computer_ (R1 copy). No second action or gesture exists.

### D-L0-2: where AI runs, and on what

**AI runs on the backend only, through the existing AI gateway** (`src/ai/gateway/`): capability gate
(`ai-gateway.config.ts` L7-17, L36-76), redaction before every provider call
(`ai-redaction.service.ts` L28-69, applied at `ai-gateway.service.ts` L248-265) and one
`AiRequestAudit` row per call (`prisma/schema.prisma` L2520-2553; insert is best-effort,
`ai-gateway.service.ts` L405-431, so spend is reserved elsewhere, D-L0-7.3). L1 adds the capability
`importer.mapping`; L1-gw makes it fail-closed (D-L0-7.5). The extension stays keyless.

**Input = `StructureDigestV1`,** built on the device from the redacted capture and scrubbed of every
value. The capture buffer keeps non-secret PII (`E:shared/capture-policy.js` L15-16), so the digest
builder is the PII boundary; every byte of the digest is hostile input (D-L0-7.2).

```ts
interface StructureDigestV1 {
  digestVersion: 2; // r5 changes admission before any implementation exists; no shipped version to distinguish
  round: 1 | 2; // round 2 = the UNION digest after explore; refs re-issued in canonical order
  truncated: { templates: boolean; linkTemplates: boolean; shapes: number };
  origins: { ref: string; template: string; contacted: boolean; credentialed: boolean }[]; // "o0" = tab origin; r8: an origin is scheme + host + port, so template = `https://` + host labels under the slot rule + `:port` when non-default (D-L0-6.2); contacted = the page fetched JSON from it this run; credentialed = the page's requests to it carried a non-cookie credential header (informational: scope is FAM-0's partner-origin rule, not this flag)
  templates: {
    // one per structure key (D-L0-3), ≤ 64; the model refers to templates only by ref
    ref: string; // "t0".."t63"
    originRef: string;
    method: 'GET' | 'HEAD';
    template: string; // root-relative; C2a ids → :p1..; every other segment → :s1.. unless in STRUCTURAL_PATH_VOCABULARY
    slots: {
      slot: string;
      class: 'int_like' | 'uuid_like' | 'slug_like' | 'opaque';
      distinct: 1 | 2 | '3+';
    }[];
    queryKeys: { key: string; distinct: 1 | 2 | '3+' }[]; // names under the key rule; never a value
    paginationSignals: string[]; // ⊆ PAGINATION_VOCABULARY, seen among top-level response keys, query keys or header names
    statuses: number[];
    observations: number;
    role: 'collection' | 'single' | 'refused'; // roles.js L417; EVERY collection template is listed (V-L10)
    refusedKind?: 'not_collection' | 'collection_unproven';
    collectionPaths: string[][]; // ≤ 4; each segment an admitted key
    shape: ShapeNode; // admitted keys + kinds, depth ≤ 4; NO values
    discoveredBy: 'landing' | 'explore'; // r5: round-1 landing structure vs explore-only (D-L0-3 reuse key)
  }[];
  linkTemplates: { ref: string; template: string; captured: boolean }[];
  constantHeaderNames: string[]; // NAMES only; values are rebound on the device
  nonGetDataOrigins: number; // count of same-page JSON responses to non-GET requests; disclosed as a gap
  missingFamilies: string[]; // round 2 only: FAM-0 families/groups still unmapped
}
type ShapeNode =
  | { kind: 'object'; keys: Record<string, ShapeNode>; optional?: string[] }
  | {
      kind: 'map';
      values: ShapeNode;
      keyClass: 'int_id' | 'uuid' | 'short_id' | 'iso_date' | 'text' | 'unadmitted';
      sizeBucket: '1' | '2-9' | '10+';
    }
  | { kind: 'array'; items: ShapeNode; lengthBucket: '0' | '1' | '2-9' | '10-99' | '100+' }
  | {
      kind: 'string';
      class:
        | 'int_id'
        | 'uuid'
        | 'short_id'
        | 'iso_date'
        | 'email_like'
        | 'phone_like'
        | 'url'
        | 'media_url'
        | 'text';
      lengthBucket: '≤8' | '≤32' | '≤256' | '>256';
    }
  | { kind: 'number'; class: 'int' | 'float' }
  | { kind: 'boolean' }
  | { kind: 'null' }
  | { kind: 'mixed' };
```

- **The slug is not in the digest (r5; `R581-A2-01`).** The memory key (authorized tab hostname,
  D-L0-5) is server-side, coach-scoped, and never enters the prompt. The model sees hosts only as
  `origins[].template` under the slot rule (`alice.example.com` → `:s1.:d`).
- **What is sent:** admitted key names, kinds, value classes, counts, URL templates with ids and every
  unproven word collapsed, admitted query key names, constant header **names**, pagination-signal
  names from a closed list. **Never sent:** any value, id, name, email, phone, note, free text,
  cookie, bearer, query value, header value, full URL, host name outside the slot rule, page text,
  link text or DOM.
- **Path rule (r4, kept; `R581-A-02`, `R581-B-B10`).** Every path segment that is not a C2a id is a
  typed session slot `:sN` **unless every token** of it (split on `-`, `_`, `.`, camel-case) is in
  `STRUCTURAL_PATH_VOCABULARY`: a closed, versioned, vendor-neutral list of generic API and resource
  words (`api`, `v<n>`, `rest`, `list`, `detail`, `search`, `users`, `coaches`, `clients`, `members`,
  `workouts`, `programs`, `exercises`, `sessions`, `messages`, `notes`, `habits`, `nutrition`,
  `meals`, `checkins`, `forms`, `photos`, `progress`, `history`, `archived`, `inactive`, plurals,
  the FAM-0 group words; no given names). Host labels follow the same rule; the registrable domain
  is `:d`. A tenant slug that happens to be a vocabulary word is a generic word from our own list,
  not an identifying value, and with per-coach memory it reaches no shared row. There is no hash
  proof. The vocabulary lives in shared contract code (`src/scout/learn/contract-vocabulary.ts`,
  mirrored by fixture in `E:shared/learn/`); a change bumps `contractHash` (D-L0-7.1).
- **Object-key admission rule (r5; `R581-A-01`, `R581-B-A3`, `R581-A2-01`, `R581-B2-A3`).** A JSON
  object key leaves the device **only if all of (1)-(3)** hold; otherwise the object collapses to
  `{kind:'map', keyClass:'unadmitted'}` (keys never sent, never mappable, V-L6). **Coach-defined
  labels are data:** unless a key is a closed contract-vocabulary word, it is admitted only through
  (2) and (3), and the preserve path (D-L0-6.1) still moves such objects as records with their
  values.
  - **(1) Grammar.** `^[A-Za-z_][A-Za-z0-9_]{0,63}$` or the same with `-`/`.` as internal separators;
    **any whitespace ⇒ refused**; no `@`, no digit run ≥ 4; not a credential-like name
    (`E:shared/credential-policy.js` set plus `token`, `secret`, `password`, `apikey`, `api_key`,
    `session`, `cookie`, `auth`, `bearer`, `csrf`, `signature`, `otp` as whole tokens) — a
    credential-like key collapses the whole object and marks the template `credential_shape`.
  - **(2) Value cross-check (device only).** A key whose normalised token sequence (lower-case, split
    as above) equals the normalised tokens of **any captured string value** in this run's payloads is
    refused (`alice_smith` vs the value `Alice Smith`; a client's name used as a pivot column). The
    server cannot run this check (it never sees values); it is in the shared fixture and X2's leak
    tests, and the server's V-L0 runs (1) and (3).
  - **(3) Structural corroboration.** Either every token of the key is in `STRUCTURAL_KEY_VOCABULARY`
    (the contract's canonical field names — `id`, `name`, `first_name`, `created_at`, `next`, `data`,
    `items`, ...), **or** the key appears with the same kind in **≥ 2 siblings**. _Sibling_ is
    defined: two objects at the same shape path whose enclosing container is the same array (two
    items) or the same map (two values) — nested objects compare with the object at the same path
    under another item (`items[i].custom_fields` against `items[j].custom_fields`). A key identical
    across ≥ 2 siblings is part of the site's schema by construction; the one way a **value**
    recurs as a key in every row (name-keyed pivot rows) is caught by (2). A key seen once, a
    question text or a token-shaped string therefore never leaves the device.
  - **Value-like keys.** An object whose admitted keys are ≥ 50% id/date-class, or whose key set
    differs across observations of the same position, collapses to `{kind:'map'}` with the key class.
  - One pure function `admitKey(key, siblings, capturedValues) → admitted | unadmitted` with a
    **shared test-vector fixture** (`test/fixtures/scout/learn/key-admission.json`, mirrored
    byte-for-byte in `E:test/fixtures/learn/`), run device-side in X2 and server-side as **V-L0**
    ((1) and (3)) on every digest; a digest the server would not admit is refused
    (`digest_unadmitted_key`). The fixture includes name-keyed single objects, question-text-keyed
    forms, token-bearing dynamic keys, `{ "Alice Smith": {...}, "id": 1 }`, a 3-sibling roster, a
    **name-keyed pivot row** and a **nested custom-field label object**.
- **Constant-header rule.** The digest and package carry header **names** only: not a credential
  (`E:shared/credential-policy.js`), not `Authorization`, `Cookie`, `Sec-*` or `X-CSRF*`, and the
  value was byte-identical on ≥ 90% of observations for that origin. Values are rebound on the
  device at replay (D-L0-6.2 covers credential headers separately).
- **Rebinding.** `compileLearnedBlueprint` (X2) binds each `:sN`, origin slot, `:q` value and header
  value from **this run's own capture** for the same identity. A slot with k observed values
  fans out into k steps; 0 bindings fail closed (`slot_unbound`: zero requests, a named gap). Slot
  values never enter the package, events, `ingest` or a log.
- **Bounds:** digest ≤ 32 KiB canonical JSON; templates ≤ 64; shape depth ≤ 4, keys ≤ 64 per object;
  link templates ≤ 64; origins ≤ 8. Over-bound digests are truncated deterministically and marked in
  `truncated` (gap `digest_truncated`), never rejected. **Truncation order (r8; `R581-c7B2-02`):**
  in a round-2 union the round-1 templates and their round-1 key paths are reserved first;
  explore-only templates and explore-only key paths truncate first. Truncation can therefore never
  make round 2 refuse (D-L0-3 (ii)).
- **Prompt injection.** Admitted key names and vocabulary words are the only site-chosen strings and
  are attacker-controlled; the validators, not the prompt, are the defence: no key name is ever
  executed, fetched or written, only matched against the digest.

### D-L0-3: `POST /api/scout/runs/learn` (the decode call) and reuse

Same posture as `runs/start` (`run.controller.ts` L88-97: coach = bearer, uniform 404 under
`FEATURE_SCOUT_INGEST` off, `@Roles('coach','owner')`, throttle). Body
`{ import_intent_id, digest: StructureDigestV1 }`; only on an open `mode='server'` run in phase
`discovering`, before the first staged row.

**Template identity, structure key and reuse key (r5; r7 `R581-c7A-01`).** A template's
**identity** is `(originTemplate, method, slotted template)`; its **structure key** is the identity
plus `keyPaths`, the sorted set of admitted key paths — names only, no kinds, no length buckets.
Every match in this record is **by identity alone** (r8 wording; `R581-c7B2-C-01`): a digest
template matches a package template when the identities are equal; key paths are compared only by
V-L5/V-L6 in match mode (a mapped path whose key this digest never observed is compatible and binds
nothing at crawl; an `idField` absent from the digest's item shape is a **miss** — a collection
without its id key is another structure) and by the round-2 shrink test. **Key-path growth** (extra
admitted keys on the same identity) binds nothing, is counted on the pin as `keypath_growth`, an
audit drift signal that is never a trigger; the preserve path moves such records whole anyway
(D-L0-6.1). A package's **round-1 fingerprint** is sha256 over the structure keys of its templates
with `discoveredBy: 'landing'`; explore-only templates never participate. The reuse key is
`(coach_id, slug)`; the fingerprint is stored per version as a match and drift signal, never compared
for equality.

**Order inside the handler, under the run-row lock:**

1. parse the digest strictly (V-L0);
2. read the run's existing pin for this round (`ScoutRunLearnedPackage`, PK `(coach_id, intent_id,
round)`); if present, return it unchanged (retry is a pure read);
3. **per-coach memory lookup** (D-L0-5): among this coach's `accepted` versions for the slug, a
   version **matches** when every round-1 `collection` template of this digest is covered by a
   package step or `unmapped` entry by identity match (digest ⊆ package), and V-L5/V-L6 pass
   for the covered steps in **match mode** (a mapped path whose key this digest never observed is
   compatible and binds nothing at crawl). Package steps whose templates are absent from this round-1 digest are **not a
   miss**: they become mandatory explore targets (the package records each step's discovering link
   template). Ties → highest version. A hit creates the round pin with `source: 'memory'`, **no
   model call**;
4. else call the model (D-L0-7), validate (D-L0-4), store a new `candidate` version for this coach,
   pin it, return `source: 'learned'`; validation failure → one repair call with the validator error
   list; a second failure → the server settles the run `failed/transfer_failed` with `failure_code:
learn_refused` (D-L0-7.5), no source request ever made.

Response: `{ package: LearnedPackageV1, source, exploreOrder: string[], deadline_at }`.

**Round 2.** After explore the device re-submits the **union digest**; the handler runs the same steps
for `round = 2` and creates a new pin row exactly once. **Round-2 match rule (r7; `R581-c7A-01`,
`R581-c7B-02`; operator disposition 3).** Round 2 matches the union digest against **the round-1
pin only** — never a fresh memory lookup, so one run has one interpretation. The handler:

- (i) requires a round-1 pin for this intent, else `409 learn_round_order`;
- (ii) **monotone observation rule, truncation-safe (r8; `R581-c7B2-02`; operator disposition
  4):** every template identity of the **round-1 digest** (stored on the round-1 pin as
  `observed_identities` with its key paths, names only) **carries forward by identity** into round
  2 whether or not the union digest lists it: the handler's working union is the submitted union ∪
  the round-1 identities, each with round-1 key paths ∪ union key paths. A union that lists a
  round-1 identity with **fewer** key paths while `truncated.shapes = 0`, or omits one while
  `truncated.templates = false`, is not a union of this run's observations and is refused
  `digest_not_union` (the device re-submits; a second refusal settles `learn_refused`). A round-1
  identity or key path missing from a **truncated** union is carried forward, never a refusal; its
  family keeps gap `digest_truncated`. Package steps are **never** part of this test: a package step
  the run did not observe is `template_absent` (below), never a refusal — so a sparse account, an
  unvisited link, a feature the coach does not use or an account so rich that its union exceeds the
  digest budget can never fail round 2;
- (iii) runs the D-L0-3 match of the **working union** against the round-1 package in
  **full-applicability mode** (every `collection` template covered by identity by a step or
  `unmapped` entry; V-L5/V-L6 over it; key-path growth compatible as above): a hit **re-pins the
  same version unchanged** with the round-1 pin's `source`. Otherwise (a new collection identity the package does
  not cover) the model is called once over the union digest with the round-1 package as a few-shot
  example inside the untrusted block (D-L0-7.1), and the resulting candidate v+1 must keep every
  round-1 step **whose identity is in the working union** (V-L10 union rule) or is refused; a refusal after
  repair settles `learn_refused` as in step 4 — the run never falls back to guessing.

**The version at first `ingest` is frozen:** the ingest gate refuses rows while a learn call is in
flight; after the first staged row `runs/learn` returns `409 learn_after_ingest`. Both pins are
audit; the last pin is the run's interpretation. Worked examples (fixtures in L08): _sparse
account_ — a memory hit on a package with a `habits` step; the visited habits page issues no habits
request; (ii) passes (round 1 never had that identity), the version re-pins, `habits` is
`template_absent`, everything else moves; _key-path growth_ — the roster re-observed with two extra
optional keys is the same identity ⇒ re-pin, `keypath_growth: 2`; _large account_ — a union that
overflows drops explore-only templates first and carries every round-1 identity forward ⇒ re-pin or
one model call, never `learn_refused`.

**`template_absent` (r6; r7 wording).** A package step whose identity appears in **no** template of
the round-2 digest (or of the round-1 digest when round 2 is skipped) is _absent this run_.
Effect: `compileLearnedBlueprint` emits **zero requests** for the step (a template is never
synthesized from the package — there is nothing to rebind from), the family it feeds gets gap
`template_absent` (D-L0-6.3) and, if no other step feeds that family, `count_basis: 'unknown'`.
Absence is a **structural invalidation trigger** (D-L0-5) only when **all** of: the step's recorded
discovering link template **was visited this run**; that visit issued ≥ 1 JSON data request to the
step's origin (so the page was not served wholly from a cache or service worker — `R581-c7B-C-02`);
and the page still did not issue the request — the site's structure changed under the same page.
When the discovering link was not in this run's inventory, or the visit issued no data request, the
absence is account reach or caching (an unvisited link under the explore budget ⇒ also
`navigation_unexplored`) and is a run-local gap only.

### D-L0-4: AI output grammar, validators and conformance checks

**Grammar — data only.** The model returns exactly one `LearnedProposalV1`:

```ts
interface LearnedProposalV1 {
  proposalVersion: 2;
  steps: {
    // ≤ 16, ordered
    templateRef: string; // a digest template ref with role 'collection'
    entityType: string; // a spec `steps` key; ≤ 64 [a-z0-9_]
    family: FamilyLabel; // r6: a label from the closed FAM-0 D-FAM-1 catalogue ('unclassified' = the only catch-all); classification only — the destination is NEVER proposed (below)
    itemsPath: string[]; // one of that template's collectionPaths
    idField: string; // key of the item shape with class int_id|uuid|short_id; NEVER positional
    idScope: 'global' | 'parent'; // r5: 'parent' ⇒ identity is `${parentId}:${id}` (R581-B2-B2); required when forEach is set
    parentEdge?: { field: string; toStep: string };
    timestampField?: string;
    collectAs?: string;
    forEach?: string; // fan-out over an earlier step's collectAs; :p1 param only
    pagination:
      | { style: 'page' | 'cursor'; param: string; start?: number; nextPath?: string[] }
      | { style: 'next_url'; nextPath: string[] } // r5: follow the response's own next link (R581-B2-B5)
      | { style: 'none' }; // a claim; never yields a proven count (D-L0-6)
  }[];
  mappingSpec: SourceMappingSpec; // mapping-spec.ts L114-125, verbatim grammar (FAM-0 expands `families`)
  nativeRules: NativeRuleSet | null; // native-rules.ts L93-100, verbatim grammar
  unmapped: { templateRef: string; reason: UnmappedReason }[]; // every collection template not in steps
  explore: string[]; // ≤ 8 linkTemplate refs to visit FIRST (round 1 only); an ordering hint
  rationale: string; // ≤ 512 chars, logged, never executed or shown
}
type UnmappedReason = 'out_of_scope_account_settings' | 'out_of_scope_ui_config' | 'unknown'; // r6: `out_of_scope_billing` deleted — billing is a family (D10; FAM-0 D-FAM-5)
```

No `apiBase`, headers, absolute URL, method, budgets, manifest, code, selectors, verifier, slot value
**or destination**. The extension sets each step's origin, header values and every `:s`/`:q` slot
from its own capture (D-L0-2). The package stores steps by structure key, not by ref. **Destination
is derived, never proposed (r6; item a; FAM-0 D-FAM-1).** `destination.kind` is deleted from the
grammar: the model classifies a collection with a `family` label from the closed catalogue and the
destination of **each record** is the pure function `destinationFor(family, gateState, typedResult)
→ 'native' | 'preserve'` (FAM-0 D-FAM-1, slice FAM-C1) — `native` iff the writer registry lists a
native writer for the family and its typed interpretation is `ok`, else `preserve`. A family may
therefore be partly native and partly preserved (D-L0-6.3 `moved_native` + `preserved`). The
`InductionManifestV1` is **derived by the server**: `expectedFamilies` = every step `family`,
`basisKinds = {}`, `verifiers: []`, `nativeRules` declared ⇔ rules accepted. **Every collection gets
a family (D4):** a coaching collection the mapping cannot name is `unclassified`; billing collections
are `billing_history` / `billing_schedule` (D10). **An `unmapped` reason is a claim, never an
exclusion (r5; `R581-A2-07`):** r4's `confirmExclusion` rule is deleted; the reason is recorded on
the pin and every `unmapped` collection appears in the projection as gap `collection_unmapped`
(D-L0-6.3). Whether a claimed exclusion may ever count towards `complete` is CL's question (§9).
No family in the catalogue is excluded by policy today (FAM-0 D-FAM-1).

**Validators that must accept before any source request (V-L\*, backend, `src/scout/learn/`):**

- **V-L0** digest: strict keys, bounds, `digestVersion: 2`, templates root-relative and parameterised
  only by `:p`/`:s`; every literal segment and host label passes the vocabulary; every object key
  passes `admitKey` (1) and (3) on the shared fixture; no credential-like key or header name;
  `paginationSignals ⊆ PAGINATION_VOCABULARY`; no digit run ≥ 4 in any literal or key.
- **V-L1** proposal strict keys and bounds; JSON only (structured output; non-JSON or truncated ⇒
  validation failure, not a retry loop).
- **V-L2** `parseSourceMappingSpec(mappingSpec, origin)` (`mapping-spec.ts` L334-376) with
  `sourcePlatform` equal to the run's slug.
- **V-L3** `parseNativeRuleSet` (`native-rules.ts` L794) when present; families ⊆ spec families.
- **V-L4** every `steps[].family` is in the D-FAM-1 catalogue **as exported by FAM-C1's catalogue
  module** (the one owner, r7 `R581-c7B-05`; L1 imports it and defines no family list of its own);
  a step whose family is a native-contract (mapped) family has a `mappingSpec.steps` entry naming the
  same family and vice versa; a classification-only label (preserve-only family or `unclassified`)
  has none; two steps into one family ⇒ `sharedIdSpaces` (V-L2, `mapping-spec.ts` L383-433).
- **V-L5** `templateRef` has role `collection`; `itemsPath ∈ collectionPaths`; `idField` is an
  admitted id-class key; `pagination.param ∈ queryKeys` of the template **or** `param ∈
PAGINATION_VOCABULARY` when the template's `paginationSignals` contains the matching signal
  (`R581-B2-B5`); `nextPath` resolves in the template shape; `style: 'none'` only if
  `paginationSignals` is empty; `forEach` names an earlier `collectAs`, the template has exactly one
  `:p` and `idScope` is present; `parentEdge.field` is admitted and `toStep` earlier; **no token of
  the template's literal path segments or `queryKeys` is in `MUTATING_VERB_VOCABULARY`** (r7; the
  server-side half of the D-L0-6.2 no-mutation bound — such a collection may only be `unmapped`).
- **V-L6** every mapping path, native-rule path, preserve field path, `parentEdge.field` and
  `timestampField` resolves to an admitted key in the item shape of a step feeding that family.
- **V-L7** derived manifest passes S10 V1-V6 in `buildInductionRegistry` (`manifest-registry.ts`
  L116) with the spec and rules.
- **V-L8** `explore` ⊆ `linkTemplates[].ref`, ≤ 8; it orders the visits and never shrinks the set.
- **V-L9** package canonical JSON ≤ 64 KiB; `package_digest` = sha256 over it.
- **V-L10 (family-set closure; union rule)** every `collection` template appears exactly once across
  `steps[].templateRef` ∪ `unmapped[].templateRef`; in round 2 the domain is the union and every
  round-1 step whose identity is in the union is still a step (D-L0-3).
- **Extension gate:** `normalizeBlueprint(compiled, {allowedOrigins})` before the first request
  (`blueprint.js` L393) with the D-L0-6.2 origin set; a throw aborts with a stable code, zero
  requests.

**Conformance against the actual staged rows (C\*, backend; r5 placement closes `R581-B2-B3`):**
C0-C4 are pure functions over the rows the facts service already groups (S10-DOC E6) and the
per-step engine evidence (D-L0-6). Slice L2c adds **one locked transaction** run by
`onTransferSettled` before `reconstructRun` (`lifecycle.service.ts` L453, L459): `lockRun` → epoch
check → compute C0-C4 → write `pin.conformance` **if null for this `execution_epoch`** → commit;
re-entry sees the row and skips. Their outcome is therefore durable before any write, and step 11
reads it — never the client's free-text `error_summary` (`scout.dto.ts` L156-163).

**Per-family and per-record enforcement (r6 item f; r7 `R581-c7A-07`, `R581-c7B-04`; operator
disposition 4).** C0 and C1 are evaluated **per family**; C2, C3 and C4 are evaluated **per record**
(consistent with `destinationFor`). A family that fails C0 is **dropped for this run**: zero writes
for it, its staged identities disclosed in `not_moved` with a count, a structural trigger recorded
on the pin. A record that fails C2, C3 or C4 is disclosed alone; its family and every other family
proceed. Whole-family effects arise only from structural signals stated below (a check failing on
**every** non-empty row). The package as a whole is never refused at claim, and the verdict
reflects dropped families and records through the arbiter's existing order. The **effective parent
set** of a run is the set of staged parent identities whose family passed C0 and whose row passed
C2, **plus** existing verified Person links (S8-D) for **this coach on this run's
`source_platform`** (r8; `R581-c7B2-08`; operator disposition 6; `Person` is unique on `(coach_id,
source_platform, source_person_id)`, `schema.prisma` L6971 — a Person of another platform with the
same source id never links); C4 is defined over it.

- **C0 identity (r5; `R581-B-A2`, `R581-B2-B2`).** Per **family**, over the union of steps and
  `:q` variants feeding it: Σ engine `raw_items == Σ distinct_raw_ids + Σ duplicate_ids`,
  `synthetic_ids == 0`, and the union's distinct id set size equals the staged distinct
  `(entity_type, source_id)` count. Steps with `idScope: 'parent'` compose `parent:id` in the engine
  **and** in `sourceId`, so per-parent namespaces never collapse in staging (`skipDuplicates`,
  `scout-ingest.service.ts` L55-72, stays). Mismatch drops **that family** for this run: its staged
  identities are `not_moved: identity_conflict` (count = staged distinct identities), the arbiter
  yields `partial/unresolved_identities`, and the failure is the structural trigger
  `conformance_identity` (D-L0-5); other families proceed. Learned packages never emit positional
  ids: X2b counts a missing `item[idField]` (`id_field_missing`) and a duplicate (`duplicate_id`)
  instead of synthesising (`engine.js` L292-307 today).
- **C1** every staged `(source_platform, entity_type)` resolves via `resolveStagedFamily`; otherwise
  rows are skipped with the existing reasons and the arbiter yields `partial/unresolved_family`.
- **C2 (per record)** a `clients` row is eligible iff `mapClient` is `ok` and `displayName` is
  non-null; a failing row is `not_moved: destination_gate_closed` (count 1 each), leaves the
  effective parent set, and every other row proceeds. When **every** non-empty `clients` row fails
  the roster is dropped whole and the failure is structural (`items_path_missing`, D-L0-5).
  Client-owned rows whose parent left the effective parent set fall to C4.
- **C3 (per record)** native rules (`interpretWorkout`/`interpretProgram`, `native-rules.ts` L413,
  L370, and every FAM-0 interpreter) are applied row by row: a row whose typed interpretation is
  `ok` is `native`, any other row is `preserve` (this **is** `destinationFor`, FAM-0 D-FAM-1), so a
  family may be partly native and partly preserved and a malformed source row never invalidates a
  package. The family's native rules are dropped for the run — and `native_rules_dropped` recorded
  as a trigger — only when the rules fail on **every** non-empty row of the family (≥ 1 row), which
  is a structural signal about the mapping, not a data defect.
- **C4 (per record, over the effective parent set)** a child row links iff its `parentEdge` value
  resolves to an identity in the effective parent set. An unlinked child row is `not_moved:
unresolved_parent` (count 1 each); linked rows of the same family proceed. When **no** child row
  of a family links although both sides have rows, the edge is dropped for the run and
  `link_conformance` is recorded. A child of a parent that was staged but dropped (C0 family drop,
  C2 row failure) is therefore always attributed, never written against a missing or mislinked
  Person.
- **C5/C6 (EX1, PR #578):** catalog space all-or-nothing; every custom-exercise row carries a name.
- C0-C6 add no reason code and no status field; their outcomes appear in the projection and on the
  pin.

### D-L0-5: memory — per-coach in V1, cross-coach later (L2g)

**Slug.** The canonical platform token of a learned source is the authorized tab origin's hostname,
lower-case (`isCanonicalPlatform`, `scout-platform.ts` L2-8). It depends on nothing the coach did and
is, with `coach_id`, the memory key (D-L0-3). It is never in the digest or the prompt. Persons from
earlier `LO` runs on the same host carry `LO`'s file slug and do not link to learned runs
(`R581-c7B2-C-04`); V1-P item 6 records the effect and DEL removes the cause.

**Schema (backend, additive; S10-B posture: RLS ENABLE+FORCE, REVOKE anon/authenticated, one
`service_role` policy, RESTRICTIVE deny-all; `prisma/migrations/20270122000000_.../migration.sql`
L168-182 as the copy source; every table carries `coach_id` and the composite FK to `ScoutImport`
where an intent exists, `schema.prisma` L6898):**

```
ScoutLearnedPackage             -- r5: COACH-SCOPED; no global/tenant-free table exists in V1
  id uuid PK; coach_id; source_platform text; version int; round1_fingerprint char(64);
  status text CHECK IN ('candidate','accepted','suspect','superseded','invalidated');
  package jsonb (LearnedPackageV1: structure keys, steps incl. family label/edges/idScope/discovering link, mappingSpec, nativeRules|null, manifest, constantHeaderNames, unmapped claims by structure key; no destination — derived per record, D-L0-4);
  package_digest char(64); learned_at; accepted_at; suspect_at; invalidated_at;
  invalidation_trigger text NULL CHECK IN (INVALIDATION_TRIGGERS);
  UNIQUE (coach_id, source_platform, version)
ScoutRunLearnedPackage          -- the run's pins, one per round
  coach_id; intent_id; round int CHECK IN (1,2); learned_package_id FK; package_digest; source text CHECK IN ('memory','learned'); pinned_at;
  digest_sha char(64);  -- audit; the digest itself is not stored
  observed_identities jsonb;  -- r7: this round's template identities + keyPaths (names only, no values); the round-2 monotone test reads round 1's (D-L0-3)
  keypath_growth int NULL;    -- r7: admitted key paths in this digest beyond the pinned package's; audit drift signal, never a trigger
  model text NULL; prompt_template_version text NULL; contract_hash char(64) NULL; output_schema_hash char(64) NULL;
  metering jsonb NULL;  -- audit copy of the run's calls (D-L0-7.3); the spend ledger is authoritative
  conformance jsonb NULL; -- C0-C6 outcome, closed codes and counts; write-once per execution_epoch (D-L0-4)
  PK (coach_id, intent_id, round)
  -- write-once: every column at insert, except conformance (once per epoch)
ScoutLearnedPackageEvent        -- insert-only audit, coach-scoped
  id; coach_id; intent_id; learned_package_id; kind CHECK IN ('learned','reused','accepted','suspect','invalidated','refused');
  trigger text NULL; gaps text[]; model text; tokens_in int; tokens_out int; latency_ms int; created_at
ScoutLearnSpendLedger           -- r5: committed reservation home (D-L0-7.3)
  scope text CHECK IN ('coach','global'); scope_id text; day date; reserved_usd numeric; charged_usd numeric; calls int;
  PK (scope, scope_id, day)
```

- **No secrets, no PII by construction.** The package grammar has no field that can hold a source
  value; the digest is not stored; the `refused` event stores validator codes only. L2b's fixture
  gate asserts no `@`, no digit run ≥ 4, no `Authorization`/`Cookie`, no literal outside the
  vocabulary and no unadmitted key in any stored package fixture. Because every row is coach-scoped,
  a corroborated non-vocabulary key (D-L0-2 (3)) sits only in that coach's tenant.
- **Lifecycle (V1, per coach; `R581-B-A1`, `R581-B2-A1`).** `candidate` (pinned by the run that
  learned it) → `accepted` when that run settles with **structural acceptance**: C0-C4 passed with
  no dropped native family, ≥ 1 Person reconstructed, no structural trigger. The verdict does not
  gate acceptance (an unproven count means the site is not proven covered, not that the mapping is
  wrong; `R581-A-08`). `accepted` versions are served to **later intents of the same coach on the
  same slug, on any source account scope of that coach**, with zero AI calls (NS). A structural
  trigger on a served `accepted` version marks it `suspect`; the coach's next Start on the slug
  learns v+1 (the model call includes the suspect package as a few-shot example, inside the
  untrusted block of D-L0-7.1, only if it has no trigger of class `conformance_identity`); when v+1
  is accepted, the old version is `superseded`;
  a `suspect` version with two triggers is `invalidated`. Nothing is written to any cross-coach row.
- **Every reuse re-validates (`R581-B-B1`).** Before a memory pin is written, the D-L0-3 match runs
  against **this run's** digest; at claim, C0-C4 run against this run's rows before any write. A
  V-L failure at learn is drift: not a hit; learn v+1.
- **Invalidation triggers are structural only (r5; `R581-B2-B1`).** `INVALIDATION_TRIGGERS =
{ template_absent, items_path_missing, id_field_missing, conformance_identity, native_rules_dropped,
link_conformance }`: a package step's template absent although its discovering link was visited
  this run (D-L0-3 `template_absent`, structural case only); mapped paths failing to parse on a
  **non-empty** response, or `mapClient` failing on **every** non-empty `clients` row (C2); C0
  failure with non-zero raw items; native rules failing on **every** non-empty row of a family (C3,
  r7 — one failing row is a preserve, never a trigger); a parent edge linking **no** child row or a
  link template failing conformance (C4). Each is derived by the backend from the persisted
  conformance record and evidence rows. **Account-sparsity, data-quality and interruption
  conditions never invalidate:** `slot_unbound`, empty collections, unproven pagination, key-path
  growth, single malformed rows, auth loss, timeouts, cancels and a **worker restart or deadline**
  (r8; `R581-c7B2-05`: C0 is evaluated only for a family whose evidence row is complete; a family
  without one is `count_basis: unknown`, never a trigger, and the package state is unchanged) are
  run-local gaps or per-record dispositions only.
- **Pins (`R581-B-B3`).** Read first under the run-row lock; one new row per round; frozen at first
  `ingest`. Concurrent first learns for one `(coach, slug)` allocate `version` under `SELECT ... FOR
UPDATE` on the max row with one retry (`R581-B-C4`).
- **L2g — cross-coach memory (deferred slice; invariants binding on its record).** "The next coach
  on that site starts instantly" is L2g's, not V1's. Its record must satisfy at minimum: (a)
  promotion needs a quorum of ≥ 2 independently provisioned coaches on distinct
  `account_scope_id_digest`s; coach accounts are TGP-provisioned (`src/auth/auth.service.ts`
  L36-44, L946-984) and promotion fails closed whenever `ALLOW_SELF_SERVICE_BECOME_COACH` is on;
  (b) identical `package_digest` over the core templates; (c) per-run conformance re-validation
  before a global package drives any write, and the served package never contains a key the served
  coach's digest lacks; (d) closed-enum server-computed triggers; one run marks `suspect`, never
  invalidates; (e) a global row holds only vocabulary keys or keys corroborated by ≥ 2 coaches'
  digests, keyed by a quorum-proven registrable domain — a one-coach hostname never enters a global
  row (`R581-A2-01`). L0 states these invariants; it does not design L2g.

**Runtime loading — one registry provider (L2a, PR #588, merged as `249fd0d4`; CORE DIFF = 0 for a
new site).** `SourceRegistryProvider.forRun(db, coachId, intentId) → RunRegistries =
{ sourceMappers, nativeRules, induction, pinned, pinDigest }` (`source-registry.provider.ts` L237-282)
composes the three file registries with the run's pinned package read **on the caller's transaction**
through the required `RUN_PACKAGE_SOURCE` binding (`NO_RUN_PACKAGE` until L2b plugs in the
`ScoutRunLearnedPackage` read, one query, no cache). Provenance is `pinned`/`pinDigest`: `null` =
the run sees exactly the repository files, else the sha256 of the pinned package's canonical JSON;
`verifyPin` re-reads the pin under the run-row lock and refuses (`RunRegistryPinChangedError`) when
one settle would observe two pins (`R589-B-A2` is met by the pin digest, not by an `origin` field —
r6 aligns the text with the merged shape). A file spec and a learned package for the same slug is a
load-time error. A new site adds rows, not files; the S10-D gate (`scripts/s10-core-diff-gate.sh`)
stays green by construction.

### D-L0-6: truthfulness — AI never decides identity, writes or `complete`

- **Identity** is `(platform, family, source_id)`; `source_id` is the engine's `idField` value
  (`engine.js` L326 → `ScoutEntityDto.sourceId`), composed with the parent id under `idScope:
'parent'`. Learned packages never use synthetic positional ids (`R581-B-A2`); `LO` keeps the
  engine's fallback until DEL. Identity uniqueness is checked per parent scope, not per entity type.
- **Writes.** Reconstruction writers, the person writer, FAM-0 native and preserve writers and the S9
  arbiter are deterministic; the learn route writes only learn tables; model output reaches a write
  only through V-L2/V-L3 parsers and C0-C6 over real rows.
- **`complete` is unreachable until CL (r5; executive reset §1).** The S10 evaluator dispatches on
  `basis_kind` (`src/scout/induction/verify.ts` L20, L371). Under r5 **no package type** — learned,
  file/reviewed or legacy — has a run-level closure: `CoverageEvaluationInput.closure` is `null` for
  every run ⇒ every expected family `known: false` ⇒ `partial/coverage_basis_unknown` through the
  existing D-S9-2 order, with gap `completeness_not_proven` in the projection. `complete` stays
  reachable only through the test-only `source_signed_enumeration` basis (`verify.ts` L74; refused
  outside dev/test by S12-B2). A false `complete` is impossible by construction. **Deleted:**
  `RunClosureV1`, the hidden-surface cases (r4 D-L0-6.1 i a–k), status probes and
  `SCOUT_LEARN_PROBE_MAX`, `confirmExclusion`, the `reviewed_package` closure (`R581-A2-04`,
  `R589-A1`) and L3's `observed_templates`/`ExclusionSignalsV1` (`R589-A2`, `R589-B-A1`). Anything
  those mechanisms tried to prove is a required input to CL (§9).
- **Per-family counting evidence is kept (reset §1; `R581-A-03`, `R581-A2-03`, `R581-A2-06`,
  `R589-A3`, `R589-A4`, `R589-B-B1`).** It gives the projection a **source count per family** with a
  stated basis. The engine (X2b) records for every step and `:q` variant a
  `StepEvidenceV1 { stepKey, pages_fetched, raw_items, distinct_raw_ids, duplicate_ids, synthetic_ids,
missing_id_items, stop: StopReason, advertised_next: boolean, refused_pages, id_set_digest,
fan_out: { parent_ids_digest, contexts_expected, contexts_fetched, contexts_exhausted } | null }`,
  `StopReason ∈ { absent_next, empty_page, short_page, first_page_only, budget, cycle, error,
advertised_next }`. **Positive exhaustion per step:**
  - `page`: `stop = empty_page` after ≥ 1 page (a short page is **not** proof: `short_page` = observed);
  - `cursor` / `next_url`: `stop = absent_next` (the next path resolves to null/absent) after ≥ 1
    page; `next_url` targets are followed only when same origin, same identity and every query key
    and value passes the D-L0-6.2 token check, checked on the device before each fetch (keys
    admitted as served, `R581-c7B2-06`);
  - `none`: **never proven** (`first_page_only` = observed) — a first page is never certified;
  - `advertised_next`, `budget`, `cycle`, `error` or `refused_pages > 0` ⇒ not exhausted.
  - **Fan-out (`R581-A2-06`):** `parent_ids_digest` must equal the parent step's `id_set_digest`
    (server-checked), `contexts_expected` = parent `distinct_raw_ids`, `contexts_fetched` = distinct
    parent ids actually fetched (each parent once), and the fan-out counts as exhausted only if
    `contexts_exhausted = contexts_expected` with every context positively exhausted; `pages_fetched`
    is the page total across contexts. `expected: 0` with a non-empty parent is refused. **Fan-out
    shortfall (r8; `R589-c7B2` class C; one rule, stated here only):** `contexts_fetched <
contexts_expected` or a context not positively exhausted, with no `error`/`budget`/`cycle`
    stop, leaves the family **`observed`** (never `proven`) with gap `list_not_exhausted`; only a
    missing, extra or duplicate step, a zero-page root step or an `error`/`budget`/`cycle` stop
    makes it `unknown`. #589 already follows this rule.
  - **Unknown is never 0:** `pages_fetched = 0` on a root step is refused by the parser.
- **Family count basis (consumed by D-L0-6.3):** `count_basis = 'proven'` iff every step and variant
  feeding the family is positively exhausted, the union id-set digest and count equal the staged side
  (E6 consistency, `R589-B-C4`), and no step is missing, extra or duplicate; `'observed'` iff every
  feeding step has ≥ 1 page and no `error`/`budget`/`cycle` stop but at least one is not positively
  exhausted; `'unknown'` otherwise. `source_count` = the union distinct id count under `proven` or
  `observed`, `null` under `unknown`. A proven count is a **count**, not a closure: it says "48 of
  the 48 this list returned", not "48 of all records the site holds".
- **Evidence cardinality (`R581-A-04`, `R589-B-C6`).** `ScoutRunObservation` stays one row per unit
  (`schema.prisma` L7057-7075; `observation.service.ts` L282-317). The family's single evidence row
  for kind `replay_terminal_enumeration` carries an aggregate `steps: StepEvidenceV1[]` (≤ 64;
  `stepKey` unique in the row; body bound 64 KiB for this kind), plus family `observed_unique` and
  `id_set_digest`. The evaluator (L3b) requires every step of the pinned package feeding the family to
  be present; a missing, extra or duplicate `stepKey` ⇒ `unknown`. Two basis kinds in one family fail
  closed (`R589-B-C2`); `step === family` accepted when the spec maps no other step (`R589-B-C7`).

### D-L0-6.1: destinations, scope and owner decisions (D1, D4, D5, D10, D12, D14)

- **Landing — native or preserved (D4).** Every staged identity, including every child, lands in TGP:
  S9 bucket **j** for native records, bucket **j-p** (FAM-0 §6.2) for preserved ones. FAM-0 holds
  the family catalogue (D-FAM-1), preserve schema, media path, reconciliation buckets and slice
  order; this record fixes the principles: the destination of each record is `destinationFor`
  (D-L0-4), never a proposal; native destinations are the models TGP already has (client-owned
  models key on the client's `user_id` and need the S8-D person link, `Person` L6959, resolved
  first); preserve is one universal tenant-scoped destination, idempotent by `(coach_id,
source_platform, family label, source_id)`, linked to its parent through the learned `parentEdge`,
  readable and exportable, and **never visible to the AI or to any memory row**; a family graduates
  from preserve to native by a deterministic backfill on the same identity (FAM-G1). **Media is
  deferred whole to FAM-M1 (r8; `R581-c7A2-03`, `R581-c7B2-10`; operator disposition 5):** no L0
  slice fetches a media byte; every media reference in a staged record is `not_moved:
destination_gate_closed` (count = distinct media references where the staged rows carry them,
  else `null`) until FAM-M1 lands — a **disclosed gap**, not a mechanism. FAM-M1 uploads through
  the existing S3-compatible storage (**D12**) under the media invariants of D-L0-6.2 and owns
  every mechanism (fetch context, redirects, CORS, caps, dedup, scan). Until the preserve writer is viewable
  (FAM-P2 + FAM-P3 `PRESERVE_VIEWABLE`) or a family's native writer slice lands, its staged records
  are disclosed as `not_moved: destination_gate_closed` (count known; FAM-0 §6.3 mapping).
- **Scope in time and status.** "Past" = records the site exposes to the coach at run time. Archived
  or inactive lists are in scope when the site exposes them; what a run cannot observe is a CL input
  (§9), never assumed absent. Nothing is back-filled from exports.
- **Billing moves (D10, decided 2026-09-29; was P2).** Billing and payment history are records:
  families `billing_history` and `billing_schedule` (FAM-0 D-FAM-5), preserved per client,
  coach-visible, read-only; the **per-client next payment date** is carried as derivation inputs
  and computed at read time with a stated basis; **moving the date moves no live charge** (the
  source keeps charging through the coach's connected payment account until the coach cancels
  there; card and bank data are never stored). In this record billing is therefore a moving family
  like any other: it is **never** a gap, never `excluded_by_policy`, and `out_of_scope_billing` is
  deleted from `UnmappedReason` (D-L0-4). Payment instruments are removed at ingest by FAM-0's rules
  file, not by anything here.
- **Partner and third-party data moves (D14/B2, decided 2026-09-29; was P6; `R581-B2-B6`).** Data
  reachable through the coach's own logged-in page moves and is used like any other reachable record
  of its family. The capture-time origin rule is FAM-0's **"Partner-origin rule"** (D-FAM-1) — an
  origin is in scope iff the authorized page itself issued the request this run under the D-L0-6.2
  credential model, it is in the run's contacted set, and the response is JSON; FAM-0's
  **excluded categories** (analytics, feature flags, ads, error reporting, identity-provider token
  endpoints, payment-card entry endpoints) are recognised by structural signatures in its rules file
  and are **not captured**: no record, no `not_moved` row, no gap, only L0's capture-time
  `origin_rejected` counter **per category** (count only, never an origin string), carried in the
  projection as `excluded_origins[]` (D-L0-6.3, FAM-0 L0-A5). This record does not restate that
  rule. The r5 exclude-by-default and gap `third_party_not_imported` are **deleted**. Bounds that
  stay L0's: GET/HEAD only, no body, learned templates only, the no-mutation and navigation bounds
  with their named residual, per-origin rate bounds, the credential invariants, `https` origins
  identified by scheme + host + port (D-L0-6.2), and **every outside origin the run read from is
  named in the result** (D-L0-6.3 `outside_origins[]`).

### D-L0-6.2: origins, credentials and the read-only bound — contracts, invariants, acceptance tests (D7, D14; r8)

r8 states **what must hold** and **what test proves it**; how a slice realises it in Chrome is the
slice's design, reviewed at its own T4 with the tests below green on a real packaged MV3 extension.

- **Authorization is exactly X1:** one Start authorizes the tab origin only; revoked at settle.
- **Base case — a single-origin site.** The page contacts only its own origin: `origins = [o0]`,
  every template has `originRef: 'o0'`, `allowedOrigins = {tab origin}`, replay uses today's
  background fetch only (`E:background.js` L753-776, unchanged), **no MAIN-world injection**, the
  projection carries no `outside_origins` entry and no `cross_origin_*` gap. Every multi-origin rule
  below degrades to it when the foreign set is empty; X3 proves it first (T-01).
- **Cross-origin data APIs are replayed from the authorized page's own top-frame main world**
  (`chrome.scripting.executeScript`, `world: 'MAIN'`; `E-X1:manifest.json` L29 declares `scripting`)
  by a helper that receives only URLs and headers the worker already admitted; no replay follows a
  redirect (`redirect: 'error'`); `navigator.serviceWorker.controller` is recorded as a run qualifier.
- **Origins (r8; `R581-c7A2-02`; operator disposition 2).** An **origin is scheme + host + port**.
  A foreign origin is admissible iff its scheme is `https` (any port) and FAM-0's partner-origin
  rule admits it; it is named in `outside_origins[].origin` as `https://host[:port]` (port omitted
  when 443) and attributed to families like any other. A page-issued data request to a non-`https`
  origin is never replayed and its families carry gap `cross_origin_insecure` (D-L0-6.3). The r7
  category `non_canonical_origin` is deleted. The tab origin is whatever X1 authorized and is never
  an outside origin.
- **Credential invariants (r8; `R581-c7A2-01`, `-04`, `-06`, `R581-c7B2-03`, `-04`, `-05`, `-09`;
  operator dispositions 1 and 8). Binding on X2b and X3; each has a test below.**
  - **I-C1 Never persisted, logged, transmitted or handed on.** No cookie value and no credential
    header value is ever written to `chrome.storage.*`, IndexedDB or a file; appears in a log, the
    capture buffer, `inflight`, the digest, the package, an `ingest` batch, an evidence upload or a
    message to TGP or a model; or is handed to a page script beyond what that realm sent (T-02, T-06).
  - **I-C2 Cookies are attached only by the browser.** The extension never reads the cookie jar,
    never sets, copies or re-injects a `Cookie` header. **Honest exposure bound:** the capture
    mechanism the slice chooses may deliver cookie values to the worker transiently inside a browser
    event; if so the handler retains no part of the event, serialises nothing from it, and the values
    are unreachable once it returns. The record does **not** claim "never enters worker memory"; it
    binds "never retained, never serialised, never leaves", measured by T-02 with a planted sentinel.
  - **I-C3 No widening.** A replayed request to a foreign origin carries cookies only where the
    page's own request to that template did; where the slice cannot establish that for a template,
    it sends **none** and the family settles with the auth gap — never `include` by default, never
    a new login (T-03, T-04). The tab origin keeps today's background path (`credentials:
'include'`, `E:background.js` L776): a page's same-origin requests carry its cookies by default,
    so this matches the page's own behaviour except for a page that deliberately omits them — an
    in-origin over-send on the site the coach is logged into, accepted and stated here (T-05).
  - **I-C4 Non-cookie credential headers: page-carried, exact origin, same frame.** The worker
    holds, in memory only, the credential-policy headers (`Authorization`, `X-CSRF*`;
    `E:shared/credential-policy.js`; `Cookie` and browser-managed headers excluded) that the page's
    own requests carried, keyed by **exact origin (scheme + host + port) and frame provenance**
    (`frameId`, recorded with every observation; disposition 8). A header is re-attached only to a
    learned GET/HEAD request to that exact origin issued from the same frame context; V1 replays
    only from the top frame and the background fetch, so a header observed only on a subframe's or
    a worker's request is **never** re-attached and never handed to any realm — the family gets the
    auth gap (T-06). The storage-JWT heuristic of `E:content/main.js` L16-33 is not used in learned
    runs (`LO` keeps it); a JWT found in storage is never sent (T-16).
  - **I-C5 Loss.** A 401/403 where the page's own request succeeded triggers at most **one**
    re-observation (reload of the authorized tab; the reload URL passes the navigation bound), then
    gap `source_auth_unavailable` (tab origin) or `cross_origin_auth_unavailable` (foreign) with
    zero further requests to that origin. A session lost mid-run lands on whatever the site serves;
    the extension **never fills or submits a form** and the run settles `partial` with the gap
    (T-08).
  - **I-C6 Worker restart.** The credential table dies with the worker. A restarted worker **does
    not resume** the run (`E:background.js` L20-22: rehydrate the snapshot, do not resume); its only
    action for an in-flight learned run is to claim what has been staged with run-level gap
    `worker_restarted` (the claim body carries it; else the server deadline settles the run). No
    re-observation, no re-attach, no
    resumed counters; C0 never fires from a family whose evidence row is incomplete (D-L0-5), so a
    restart can never produce `suspect` (T-07).
- **No-mutation bound — replay and navigation (r8; `R581-c7A2-05`, `R581-c7B2-01`, `-06`,
  `R581-c7B2-C-02`; operator disposition 3; an engineering bound inside D14).**
  - **Vocabulary and token semantics.** `MUTATING_VERB_VOCABULARY` — closed, versioned,
    vendor-neutral, shared contract code mirrored by fixture in the extension: `logout`, `signout`,
    `sign_out`, `signoff`, `logoff`, `log_off`, `login`, `signin`, `auth`, `sso`, `oauth`, `password`,
    `delete`, `remove`, `destroy`, `cancel`, `unsubscribe`, `subscribe`, `deactivate`, `activate`,
    `send`, `create`, `update`, `archive`, `unarchive`, `reset`, `revoke`, `accept`, `decline`,
    `approve`, `reject`, `assign`, `complete`, `confirm`, `submit`, `dismiss`, `toggle`, `set`, `mark`,
    `read`, `unread`, `seen`, `ack`, `acknowledge`, `view`, `viewed`, `open`, `opened`, `track`,
    `visit`, `notify`, `action`, `operation`, `op`, `command`, `cmd`, `event`. A URL **hits** when any
    token (lower-cased; split on `-`, `_`, `.`, camel-case; exact whole token, no stemming — `events`
    and `sets` do not hit) of a path segment, query key or query value is listed. Over-refusal of a
    read-only surface is an honest, disclosed gap; V1-P item 9 records refusals per token.
  - **Replay (FAM-0 D-FAM-1 executive interpretation of D14: the page's own learned templates
    with other ids and pages, values rebound from observed values, pagination and a same-origin
    `next_url`; nothing else is ever synthesized).** A request is admitted only if **all** hold: GET or HEAD; no body; origin ∈
    `allowedOrigins` = `{tab origin} ∪ {admissible foreign origins the package's steps need}`; the
    path matches a learned template of the pinned package that the page itself issued this run
    (identity in the working union; `template_absent` steps emit nothing); its query-key set equals
    an observed key set of that identity this run **∪ {the step's V-L5-validated pagination
    `param`}**, or it is a `next_url` served by the previous page of the same origin and identity
    with keys admitted as served; values are rebound from this run's observed values or the
    pagination rule; the URL does not hit the vocabulary (a hit ⇒ `mutating_template_refused`, zero
    requests, on the device **and** at V-L5). Each admitted `(template, parent id, page)` is issued
    **at most once**; any failure after send is terminal for that request (`error` stop, `list_not_exhausted`)
    — there is no retry, so the worst case is exactly one request per page (`R581-c7A2-05`). Rate:
    ≤ 2 concurrent per origin, ≥ 250 ms spacing (`SCOUT_LEARN_REPLAY_MIN_SPACING_MS`).
  - **Navigation (explore and the Start reload).** The device holds the literal URL; before every
    navigation it checks: same origin as the tab; path from the run's link inventory; the URL does
    not hit the vocabulary. A hit is **never visited** and counted as gap `navigation_refused` for
    the run; a Start reload URL that hits refuses the run (`failure_code: start_page_refused`, zero
    requests). Explore is **navigation only**: the extension never clicks, fills, submits a form or
    dispatches an event; a visited page's own scripts run as they would for the coach (T-09).
  - **Residual, stated honestly.** Two effects are outside any lexical bound: a source GET with a
    hidden side effect (a read receipt, a "last viewed" stamp), and requests a visited page's own
    scripts issue. The bound limits them to requests the page itself issued, once per page, and to
    pages reachable by the coach's own links; **V1-P item 9 observes both** on the pilot account and
    records what changed, per template and per page. That reading decides whether a further bound
    is needed; nothing is decided here.
- **Media invariants (r8; operator disposition 5) — binding on FAM-M1, which owns every mechanism.**
  (a) Nothing before FAM-M1 fetches media (D-L0-6.1). (b) A media fetch is GET without body, to the
  tab origin or an `https` origin the page itself loaded media bytes from this run (a set the
  capture holds in worker memory); every such origin is named in `outside_origins[]` inside the
  same ≤ 8 cap. (c) The URL is a response value used verbatim and does not hit the vocabulary. (d)
  The credential invariants apply unchanged. (e) A redirect, an opaque or unreadable response and a
  cap breach are counted `not_moved` outcomes (`excluded_by_policy`, `source_refused`,
  `over_limit`), never silent. (f) **Open for FAM-M1's record (`R581-c7A2-03`), not decided here:**
  whether a JSON-supplied URL on an authorized media origin whose path the page never requested (a
  signed export URL) stays inside D14; FAM-M1 states its rule and carries the negative fixture
  (T-17). FAM-0 §5.2's `redirect: 'manual'` wording is likewise FAM-M1's to prove (`R581-c7B2-10`).
- **Outside-origin cap with refusal (FAM-0 r10 L0-A4′).** The router **refuses (never fetches) a
  ninth outside origin** in a run; a refused origin is gap `outside_origin_refused` for the families
  its templates feed (distinct from `cross_origin_unobserved`, which means the page did not contact
  it), so the ≤ 8 cap never hides an origin the run read from (T-14). Lifting the cap is FAM-0
  OQ-14.
- **Feasibility risks are named gaps:** an origin the package needs that the page did not contact
  ⇒ `cross_origin_unobserved`; CORS-denied/opaque ⇒ `cross_origin_cors_denied`; injection or fetch
  blocked by policy ⇒ `cross_origin_csp_blocked`; non-`https` ⇒ `cross_origin_insecure`; tab closed
  or navigated away ⇒ `tab_lost` (R1 copy: "keep this tab open"). Zero replayable collection
  templates ⇒ `failed/transfer_failed`, `failure_code: no_collections_observed`.
- **Capture (X3 adds).** To today's `E:shared/capture.js` (origin check before header reads,
  `origin_rejected` without the origin string, L246-290): JSON responses from admissible foreign
  origins on the same redaction path, the contacted-origin list, the credential-header table with
  frame provenance and the media-origin set — all worker memory. Non-JSON foreign responses, FAM-0
  excluded-category origins (counted per category) and any TGP origin stay `origin_rejected`. The
  only origin fact that persists is `outside_origins[]` (D-L0-6.3).
- **Fallback — later slice, not default (D11):** tab origin plus the registrable domain's https
  subdomains in one `permissions.request`; about reach, not credentials; not scheduled in D-L0-9.

**Required acceptance tests (r8).** Each runs the **packaged MV3 extension loaded into Chromium**
(Playwright Chromium, labelled as such, not branded Chrome) against a local fixture server. A CDP
probe of a plain page is evidence about the protocol, not about the extension, and discharges no
test. The owning slice's PR is not merge-eligible until its tests are green on its exact head.

| Id   | Owner  | Fixture and assertion                                                                                                                                                                                                                                                                              |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | X3     | Single-origin site: `origins = [o0]`, zero injections, `outside_origins: []`, `excluded_origins: []`, records moved.                                                                                                                                                                               |
| T-02 | X3     | Planted HttpOnly sentinel cookie on the tab and a foreign origin: the sentinel is absent from the capture buffer, `inflight`, every log line, every `chrome.storage` area, IndexedDB, every message, every `executeScript` argument and every upload; the run still moves records.                 |
| T-03 | X3     | Foreign origin the page called **without** cookies while the jar holds one for it: the fixture records no `Cookie` header on replay; the family moves.                                                                                                                                             |
| T-04 | X3     | Cookie-authenticated foreign origin with a **mixed** public + credentialed endpoint pair, plus a `SameSite`/partitioned-cookie variant: each template either replays with the page's own outcome or settles `cross_origin_auth_unavailable`; never a widened send, never a login page interaction. |
| T-05 | X3     | Cookie-session tab origin whose data requests are served through the page's **own service worker**: tab-origin replay succeeds via today's background path.                                                                                                                                        |
| T-06 | X3     | Credential header set only by a **subframe** (different origin) and one by a page worker: neither is re-attached to any replay nor passed to any `executeScript` argument; the family gets the auth gap; frame provenance recorded.                                                                |
| T-07 | X3     | Worker terminated mid-crawl: the run is not resumed, no re-observation, nothing credential-like in any storage, the run settles `partial` with `worker_restarted`, no structural trigger, package state unchanged.                                                                                 |
| T-08 | X3     | Fixture invalidates the session mid-run: at most one reload, zero form fills or submissions, `source_auth_unavailable`, `partial`, records already staged kept.                                                                                                                                    |
| T-09 | X3     | Inventory containing `/logout`, `/items/:id/delete`, `/settings?action=unsubscribe` links: none is visited, zero requests to them, session survives, `navigation_refused` counted; `/api/events` and `/api/sets` pages **are** visited.                                                            |
| T-10 | X2b/L1 | Templates and variants hitting the vocabulary (`/api/action?operation=cancel`, `?mark_read=1`, a rebound value `read`) refused on the device and at V-L5; `/api/events`, `/api/sets` admitted.                                                                                                     |
| T-11 | X2b    | Page 2 with an unobserved `page` key (validated pagination `param`) admitted; a `next_url` with a new cursor key on the same origin and identity admitted; a `next_url` to another origin or with a hitting key refused.                                                                           |
| T-12 | X2b    | Fixture processes the GET then drops the response: exactly **one** request reaches the source, the step stops `error`, family `list_not_exhausted`.                                                                                                                                                |
| T-13 | X3     | Partner origin on a non-default port (`https://api.example.test:8443`) captured, replayed and named exactly so in `outside_origins[]`; an `http://` partner origin never replayed, `cross_origin_insecure`.                                                                                        |
| T-14 | X3     | Ninth outside origin refused: `outside_origin_refused` for its family, the eight named.                                                                                                                                                                                                            |
| T-15 | X3     | Excluded-category origins (telemetry beacon, IdP token response) not captured, counted in `excluded_origins[]`; a CORS-denied origin ⇒ `cross_origin_cors_denied`; closed tab ⇒ `tab_lost`.                                                                                                        |
| T-16 | X3     | A JWT planted in `localStorage` of the tab origin is never sent by a learned run; a bearer-authenticated foreign API the page called with `Authorization` is served by header re-attachment to that exact origin only.                                                                             |
| T-17 | FAM-M1 | Media: a redirecting media URL, a CORS-less image, a JSON-supplied URL on an authorized media origin with an unrequested path — each yields the counted `not_moved` outcome FAM-M1's record states; no media byte is fetched before FAM-M1.                                                        |

### D-L0-6.3: `RunStatusProjectionV1` — the ONE run-status projection (D5; owned by L0; FAM-0 §6.3 cites this section by name and restates nothing)

`GET scout/import/status` (S7-L §5 additive rule; the existing `families[]` entry,
`lifecycle.service.ts` L146-165, keeps its keys) returns `RunStatusProjectionV1`: the existing
verdict fields (`status`, `reason_code`, `completed_at`, ...) plus:

```ts
interface RunStatusProjectionV1 {
  // existing verdict fields unchanged: status, reason_code, completed_at, phase, ...
  families: FamilyRowV1[]; // one row per family seen, INCLUDING preserved families
  not_moved: NotMovedV1[]; // records known to exist that did not land
  gaps: GapV1[]; // things we could not determine; never counts
  outside_origins: OutsideOriginV1[]; // r6 (D14 bound): every origin other than the tab origin the run read from (data; media once FAM-M1 lands); empty in the single-origin base case
  excluded_origins: ExcludedOriginV1[]; // r7 (FAM-0 L0-A5): capture-time origin_rejected counts per category; never an origin string
  failure_code?: FailureCode; // FAM-0 r10 L0-A6: set when the server settled a learn failure (D-L0-7.5) or refused an ingest (extension_update_required); r8 also the refused Start page (start_page_refused)
}
interface OutsideOriginV1 {
  origin: string; // r8 (was `host`): scheme + host + port, `^https://[a-z0-9.-]+(:[0-9]{1,5})?$`, port omitted when 443, ≤ 262 bytes; never a path, query, header or credential
  requests: number; // int ≥ 1; GET/HEAD requests the router admitted to it this run
}
interface ExcludedOriginV1 {
  category: ExcludedOriginCategory;
  count: number; // int ≥ 1
}
type ExcludedOriginCategory =
  | 'analytics'
  | 'feature_flags'
  | 'ads'
  | 'error_reporting'
  | 'identity_provider'
  | 'payment_card_entry'; // FAM-0 rules-file categories (L0-A5); r8 deletes r7's `non_canonical_origin` (non-default ports are admissible; non-https is gap `cross_origin_insecure`)
interface FamilyRowV1 {
  family: FamilyLabel; // closed vocabulary (below); no destination field: a family may be partly native and partly preserved, which moved_native and preserved express
  source_count: number | null; // int; null = unknown, never 0
  count_basis: 'proven' | 'observed' | 'unknown'; // D-L0-6 family count basis
  moved_native: number; // int: bucket j native_present_verified + bucket i rows removed or archived after import, by the coach or the linked client (FAM-0 §6.2; r10 L0-A7; neutral copy "removed after import")
  preserved: number; // int; bucket j-p rows (0 until FAM-P2 writes any — a true zero, nothing exists to count)
  not_moved: number | null; // Σ not_moved[].count for this family when every entry has a count; else null
}
interface NotMovedV1 {
  family: FamilyLabel;
  count: number | null; // int; null only when the records are known to exist but could not be counted
  reason: NotMovedReason;
}
interface GapV1 {
  family: FamilyLabel | null; // null = run-level
  code: GapCode;
}
type FamilyLabel = string; // the FAM-0 D-FAM-1 catalogue (native and preserve-only families incl. billing_history, billing_schedule) ∪ 'unclassified' (the only catch-all)
type NotMovedReason =
  // closed, L0-owned (`reason-codes.ts`); FAM-0 §6.3 maps its FAM states onto it (FAM-R1); the L2d table below places every base key
  | 'excluded_by_policy' // owner-confirmed exclusion with a device-side count (none in the catalogue today); FAM-0 also maps media from an unconfined origin, scan-rejected media and an erased Person here
  | 'source_refused' // the source refused or errored on fetches for known identities (4xx/5xx, refused pages)
  | 'unresolved_parent' // C4: the parent/person edge could not be resolved (S8-D link missing)
  | 'identity_conflict' // C0 failure for the family (r6: per family), missing/duplicate/conflicting ids
  | 'destination_gate_closed' // a deterministic gate before the write was closed: C2 drop, preserved before PRESERVE_VIEWABLE, native writer slice not landed, media before FAM-M1
  | 'over_limit' // records beyond a configured bound (size, count, media caps, RECONSTRUCT_MAX_ROWS)
  | 'write_failed' // deterministic writer error, rows staged
  | 'cause_unknown'; // r8 (L0-owned append; `R581-c7B2-07`): the identity was staged and did not land, and the histogram key records no cause (`unresolved:not_reconstructed`, `unresolved:reason_unrecognised`, bucket k); count known, cause honestly unknown; R1 copy "did not move (reason not recorded)"
type GapCode =
  | 'completeness_not_proven' // every run until CL (family: null)
  | 'list_not_exhausted' // a feeding step is not positively exhausted (budget, error, advertised_next, cycle, refused pages)
  | 'digest_truncated'
  | 'navigation_unexplored'
  | 'collection_unmapped' // a collection template the proposal left unmapped (claimed reason on the pin)
  | 'slot_unbound'
  | 'template_absent' // r6: a package step's template not observed this run; zero requests, never synthesized (D-L0-3)
  | 'non_get_data_unobserved'
  | 'cross_origin_unobserved' // the page did not contact an origin the package needs
  | 'outside_origin_refused' // FAM-0 r10 L0-A4′: a contacted outside origin refused because the run already named eight; family-attributed
  | 'cross_origin_cors_denied'
  | 'cross_origin_auth_unavailable'
  | 'cross_origin_csp_blocked'
  | 'cross_origin_insecure' // r8: a page-issued data request to a non-https origin; never replayed (D-L0-6.2)
  | 'source_auth_unavailable'
  | 'mutating_template_refused'
  | 'navigation_refused' // r8 (run-level): explore links never visited because their URL hits the vocabulary (D-L0-6.2)
  | 'worker_restarted' // r8 (run-level): the extension worker restarted mid-run; the run was not resumed and settled with what was staged (D-L0-6.2 I-C6)
  | 'residual_unknown' // FAM-0 §6.3 (L0-A2′): residual content of some identities of this family is unknown — version-0 native identities whose staged payload is gone, payload-less legacy conversions, or rows captured at device_rules_version 0; identities are counted once in moved_native/preserved; no count here
  | 'tab_lost';
// r6: `third_party_not_imported` deleted (D14). `GapV1` carries no count; FAM-0 r9 §6.3 agrees (the identity count is an S9 histogram key for the history detail).
type FailureCode =
  | 'learn_unavailable'
  | 'learn_refused'
  | 'learning_budget_exhausted'
  | 'no_collections_observed'
  | 'origin_mismatch'
  | 'extension_update_required' // r7 (FAM-0 L0-A6): ingest refused, batch device_rules_version below SCOUT_MIN_RULES_VERSION (FAM-0 §4.3); R1/X4 copy: "update the extension and start again"
  | 'start_page_refused'; // r8: the tab's URL at Start hits the navigation vocabulary (a logout or auth page); zero requests; R1 copy: "open the site's main page and start again"
```

**Rules (normative; `R581-B2-B7`, `R590-B-A1`; orchestrator amendment to reset §6, 2026-09-29:
`destination` dropped from the row, single `NotMovedReason` list, `unclassified` catch-all):**

- **A fact with a count goes to `not_moved`; an unknown goes to `gaps`; never both.** The two enums
  are disjoint. Each fact appears exactly once; a family-attributable unknown carries the family,
  a run-level unknown carries `family: null`.
- **Unknown = `null`, never 0.** `source_count` is null under `count_basis: 'unknown'`; `not_moved` is
  null when any entry for the family lacks a count.
- Under `count_basis: 'proven'`: `source_count = moved_native + preserved + not_moved`
  (`R590-B-C5`; owner-confirmed exclusions are counted inside `not_moved` as `excluded_by_policy`).
- Counts and closed codes only; no path, ref, token, host or model text — with **one** additive
  exception (r6, D14 bound): `outside_origins[].origin`, an origin the run actually read from,
  uploaded by X3 as one run-level evidence unit (`kind: outside_origins`, ≤ 8 entries), rendered
  verbatim by X4 and R2. It is **device-attested** (r7, `R581-c7B-C-01`): the server never sees
  origins (the digest carries slot templates), so it checks grammar, `requests ≥ 1`, ≤ 8 entries
  and that the entry count does not exceed the working union's contacted foreign origins (FAM-M1
  extends the bound for media origins); the router's refusal of a ninth origin (D-L0-6.2) keeps the
  list complete.
- **Legacy records have one placement (r7; `R581-c7B-10`; FAM-0 r9 R590-c7B-06 agrees).** A legacy
  **evidence** row (`ScoutReconstructedEntity`, bucket f) not yet converted by FAM-P2 is `not_moved:
destination_gate_closed` and nothing else. A **version-0 native** identity is counted in
  `moved_native` and nothing else; if its staged payload is gone its family carries gap
  `residual_unknown` — a statement about residual content, not about the identity.
- `families[]` has a row for every family with any staged, moved, preserved or not-moved record
  (label from the D-FAM-1 catalogue; `unclassified` is the only catch-all). `NotMovedReason` is
  the single closed list; r4 names (`no_destination_yet`, `native_destination_pending`, ...) do not
  exist.
- **Activated at L2d, extended by FAM-R1 (r7 `R581-c7A-04`; r8 `R581-c7B2-07`, operator
  disposition 7).** L2d ships a **truthful** projection: verdict fields, `gaps[]`,
  `outside_origins[]`, `excluded_origins[]`, `failure_code`, `count_basis`/`source_count` (L3b) and
  the **total placement table** below over every source that exists at `249fd0d4` (`reconcile.ts`
  `classifyIdentity`, `types.ts` `S9_REPORT_CODE`, `native-contract.ts` `UNRESOLVED_CODE`,
  `pin.conformance`); an exhaustiveness test fails the build on an unplaced key (L14), so
  `source_count = moved_native + preserved + not_moved` holds under `proven` at L2d. FAM-R1
  **extends** the table (j-p ⇒ `preserved`, `preserved_missing`/`ledger_stale` ⇒ `write_failed`,
  media and quarantine states, `report_version`) and changes no row below.

  | Source at `249fd0d4`                                                                                                                                                                                                                                                       | Placement                                                        |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
  | bucket j `native_present_verified`                                                                                                                                                                                                                                         | `moved_native`                                                   |
  | bucket i `unresolved:native_target_removed` (row removed or archived after import by the coach or the linked client; FAM-0 §6.2)                                                                                                                                           | `moved_native` — **from L2d onward**, never `not_moved`          |
  | `pin.conformance` C0 family drop; bucket h `identity_conflict`; `native_uniqueness`; `rejected:missing_source_id`                                                                                                                                                          | `not_moved: identity_conflict`                                   |
  | `pin.conformance` C2 row; bucket a `unresolved:<family>` (C1); bucket f `unresolved:evidence_only`; native-rule row codes (`missing_required_field`, `invalid_value`, `enum_unmapped`, `prescription_not_integral`, `exercise_reference`, `source_archived`) before FAM-P2 | `not_moved: destination_gate_closed`                             |
  | `pin.conformance` C4 row; `no_native_client_principal`; `relationship_pending`; `relationship_missing`                                                                                                                                                                     | `not_moved: unresolved_parent`                                   |
  | bucket c `failed`; bucket g `unresolved:provenance_missing`; other `rejected:*`                                                                                                                                                                                            | `not_moved: write_failed`                                        |
  | `unresolved:pass_ceiling_exceeded`                                                                                                                                                                                                                                         | `not_moved: over_limit`                                          |
  | refused fetches (`refused_pages`, 4xx/5xx on known identities)                                                                                                                                                                                                             | `not_moved: source_refused`                                      |
  | `unresolved:not_reconstructed`; `unresolved:reason_unrecognised`; bucket k                                                                                                                                                                                                 | `not_moved: cause_unknown` (count known, cause honestly unknown) |

- `excluded_by_policy` is the only reason for an owner-confirmed exclusion: the collection is counted
  on the device (distinct ids of its observed pages; nothing staged, no value leaves), so it is a fact
  with a count, never a gap. A model-claimed exclusion the owner has not confirmed stays gap
  `collection_unmapped`. No family is excluded by policy today; billing moves (D10).
- **Wiring (FAM-0 r10 L0-A8):** the projection (slice L2d) reads the pin's `conformance`, the L3b
  family evidence and, for the **verdict fields** (`status`, `reason_code`, `completed_at`,
  `source_count`, coverage basis), the settled S9 report; `moved_native`/`preserved`/`not_moved[]`/
  `residual_unknown` come from the settled report and the D-S9-7 histogram through the placement
  table at L2d and, once FAM-R1 lands, from **FAM-R1's live read-only recompute for every intent**
  (FAM-0 §6.3); nothing in `reconcile.ts`, `coverage.ts` or `arbiter.ts`
  changes; `RUN_REASON_CODES` unchanged. `NotMovedReason`, `GapCode`, `FailureCode` and
  `ExcludedOriginCategory` are closed, append-only exports in `reason-codes.ts` (r6 appends
  `template_absent` and `residual_unknown`; r7 `extension_update_required` and the category enum;
  r8 `cause_unknown`, `cross_origin_insecure`, `navigation_refused`, `worker_restarted`,
  `start_page_refused`; nothing has shipped, so deleting `third_party_not_imported` and
  `non_canonical_origin` before L2d removes no live code). **X4** renders it in the popup result detail;
  **R2** renders it in `ImportResultView` from R1-owned copy (`ImportRunVerdictCard` retired by R1),
  keyed on `failure_code` first (`R581-B2-C6`); the mobile decoder (`M:src/types/importRunStatus.ts`
  L119) tolerates unknown fields and maps an unknown code to `'unknown'`. Nothing else renders run
  detail. A change to a field name here is a reviewed contract change recorded in this section and
  in FAM-0.

Settle order: C0-C6 (own locked transaction, persisted) → reconstruct (native + preserve) → S9
reconcile → S10 evaluator (`closure: null`) → arbiter → CAS (`writeTerminal` L497) → per-coach
acceptance/suspect → projection.

### D-L0-7: the AI step — prompt, injection defence, limits, best model, fallback

Owner requirements (2026-09-27, binding): a great prompt step, a clear limit to usage, always the best
model available. Gateway capability `importer.mapping` (D-L0-2, L1-gw). Every item is
env-configurable; every failure closes to an honest `partial` or `failed` with a stable code.

#### D-L0-7.1 Prompt construction (`src/scout/learn/prompt.ts`)

Six parts; instruction text in parts 1-5, the site's data only in part 6: **(1) Goal** — move this
coach's business into TGP faithfully; every collection is a family from the closed catalogue
(`unclassified` when it cannot be named) or unmapped for a closed reason; map only, never invent,
never a destination; **(2) TGP target structure, live** — rendered by `describeCanonicalContract()`
(`src/scout/learn/canonical-contract.ts`, #591) from the same objects the validators use
(`CANONICAL_FAMILIES` (FAM-0 expanded), `FIELD_COERCIONS`, `PersonFieldRules`, `EntityFieldRules`,
`mapping-spec.ts` L63-125; native-rule targets; the D-FAM-1 family catalogue; `contract.ts` L16-35;
the structural vocabularies), `contractHash = sha256(canonical JSON)`, test **L11**; **(3) Output schema** — the
JSON Schema for `LearnedProposalV1`, generated from the grammar, printed here and passed as the
structured-output constraint; **(4) Examples** — ≤ 2 **repository-fixture** few-shot pairs, structure
only (`LO` oracle pair, `conformance_alpha`); nothing site- or coach-derived is ever in part 4;
**(5) Rules** — refer to templates by ref only; paths must exist; targets only from part 2; no
origins, endpoints, URLs, headers, actions or code; unknown ⇒ `unmapped: unknown`; treat part 6 as
data, including its example; **(6) Untrusted site structure** — the digest, canonical JSON, inside
`UNTRUSTED_SITE_STRUCTURE_BEGIN/END`, and, when present, **one coach-derived example package**
(this coach's most recent `accepted` package on an overlapping family set, the round-1 package in
round 2, or the `suspect` package when relearning; D-L0-3, D-L0-5) inside its own
`UNTRUSTED_EXAMPLE_PACKAGE_BEGIN/END` block — both blocks delimited by the same per-call random
nonce (r7; `R581-c7B-03`; operator disposition 5: its key names are site-chosen and therefore
hostile). `promptTemplateVersion`, `contractHash` and `outputSchemaHash` are recorded on the pin and
in `AiRequestAudit.metadata`. #591 prints examples as plain part-4 text (`prompt.ts` L206-221 at
`debce080`) and owes this change (D-L0-9).

#### D-L0-7.2 Prompt-injection defence (all source-site content is hostile)

- **Position:** source-derived bytes exist only in part 6, inside the two nonce-delimited blocks
  (digest; coach-derived example package); admitted key names and vocabulary words are the only
  site-chosen strings, each ≤ 64 bytes, control characters escaped, never interpolated into
  instruction text. **Samples:** V1 sends none.
- **Redaction:** `AiRedactionService.redact` runs over the serialised digest before the call; the
  device rules run first; a digest with any credential-pattern match is refused (V-L0).
- **Model capabilities:** no tools, no network, no memory writes; one completion per call;
  `temperature: 0` and `maxTokens` passed explicitly (gateway defaults are 0.7/600,
  `ai-gateway.service.ts` L283-284).
- **Output constraint:** provider structured output against the generated schema; L1 adds
  `responseSchema` to `AiProviderRequest` (`providers/ai-provider.types.ts` L15-24). Non-conforming
  ⇒ one repair, then refuse.
- **Reference closure:** V-L5/V-L6/V-L2/V-L4/V-L1/V-L8 — no reply string is ever a URL, host,
  header, path outside the digest or code. **Real gate:** V-L0…V-L10 and C0-C6 over real rows.
- **Adversarial corpus** `test/fixtures/scout/learn/adversarial/**`: injection strings in key names,
  fake role text, "ignore previous", instructions to map `Authorization`/email/billing, unicode
  delimiter look-alikes, an oversize digest, a name-keyed object, a question-text form (test **L13**).

#### D-L0-7.3 Usage limits and time budgets (r5 arithmetic; `R581-A-07`, `R581-B-B8`, `R581-A2-09`, `R581-A2-10`, `R581-B2-B4`, `R581-B2-B8 iv`)

**Stated latencies:** reload to network idle 5-20 s; one frontier call on a 24k-token prompt 20-60 s
(cap 90 s); an explore visit 2-8 s; one source request 0.2-2 s (cap 15 s, `blueprint.js` L132-137).
A roster of N clients with H history pages each needs ≈ N × (1 + H) requests; N = 300, H = 3 ⇒
≈ 1 200 requests ≈ 6-20 min sequential.

**One shared deadline.** The learned-run deadline is a **config value**, `SCOUT_LEARN_RUN_DEADLINE_MS`
(default 1 800 000 = 30 min), set by the server at `runs/start` (D-S7L-3, `schema.prisma` L6878) for
every intent whose canonical platform token (the authorized origin's hostname, D-L0-5; the
`chosen_platform` label is not consulted, `R581-c7B-C-06`) resolves to **no repository file spec** in
`SourceRegistryProvider`; the parent-frozen `SCOUT_RUN_DEADLINE_MS_DEFAULT = 300_000`
(`lifecycle.service.ts` L74) stays for `LO` runs. Owned by L2b. **DP-1:** after the first ten V1-P
runs the operator re-sizes the default from recorded p95 phase timings. The device stops work at
`deadline_at − 60 s` and claims what it has (`list_not_exhausted` gaps).

**Learn phase priority (Start → crawl), worst case = 20 s reload + 4 × 90 s calls + 24 × 8 s
visits = 572 s ⇒ cap 600 s.** Inside `SCOUT_LEARN_PHASE_MAX_MS` (default **600 000**): the round-1
call and its repair come first; explore runs while `remaining > 2 × call timeout + 60 s`, visiting
in `explore` order then canonical order; round 2 is skipped (gap `navigation_unexplored` for unvisited
links) when fewer than `2 × call timeout` remain; the crawl always receives at least
`deadline − phase cap − 60 s` = 19 min.

| Limit                          | Default                                            | Env                                                        | On breach                                                 |
| ------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Model calls per run            | 4 (decode, repair, round-2 decode, round-2 repair) | `SCOUT_LEARN_MAX_CALLS_PER_RUN`                            | `learning_budget_exhausted`                               |
| Input / output tokens per call | 24 000 / 4 096                                     | `SCOUT_LEARN_MAX_INPUT_TOKENS` / `..._OUTPUT_TOKENS`       | digest truncated deterministically / non-conforming reply |
| Tokens per run                 | 80 000                                             | `SCOUT_LEARN_MAX_TOKENS_PER_RUN`                           | `learning_budget_exhausted`                               |
| Per-call timeout               | 90 s                                               | `SCOUT_LEARN_CALL_TIMEOUT_MS`                              | `learn_unavailable`                                       |
| Learn phase (Start → crawl)    | 600 s (≥ 572 s worst case)                         | `SCOUT_LEARN_PHASE_MAX_MS`                                 | round 2 skipped ⇒ `navigation_unexplored`                 |
| Explore visits / visit time    | 24 / 8 000 ms                                      | `SCOUT_LEARN_EXPLORE_MAX` / `SCOUT_LEARN_EXPLORE_VISIT_MS` | `navigation_unexplored`                                   |
| Run deadline (learned)         | 30 min; DP-1                                       | `SCOUT_LEARN_RUN_DEADLINE_MS`                              | `deadline_exceeded`; claimed work kept                    |
| Replay spacing / concurrency   | 250 ms / 2 per origin                              | `SCOUT_LEARN_REPLAY_MIN_SPACING_MS`                        | engine waits                                              |
| Per-coach daily calls          | 12                                                 | `SCOUT_LEARN_COACH_DAILY_CALLS`                            | `learning_budget_exhausted`                               |
| Global daily spend (USD)       | 20, **PLACEHOLDER** (D3)                           | `SCOUT_LEARN_GLOBAL_DAILY_SPEND_USD`                       | `learn_unavailable`; alert                                |
| Kill switch                    | off                                                | `SCOUT_LEARN_AI_ENABLED` + gateway flags                   | `learn_unavailable`                                       |

**Spend reservation has a committed home (`R581-A2-10`; r6 aligned with #592 r2).** Before **every**
provider call (including a first call and a repair) the gateway reserves the call's maximum cost
(input + `max_tokens` at the configured `AI_PRICE_*`) through the **`SpendLedger` port**
(`src/ai/gateway/structured/spend-ledger.ts`, DI token `SPEND_LEDGER`, L1-gw): `reserve` must commit
before the call and throws `ai_budget_exhausted` (cap) or `ai_unavailable` (ledger unreachable,
fail closed); `settle` converts the reservation to the actual charge afterwards, and a crash or
failed settle leaves the maximum charged (conservative). L1-gw ships the default implementation
(`AuditSpendLedger`: one transaction under `pg_advisory_xact_lock(hash(capability, UTC day))`,
reserved row in `AiRequestAudit`, **global** daily cap only). **L2b binds `ScoutLearnSpendLedger`
to the same port** and adds the per-coach scope: one atomic conditional update per scope row
(`UPDATE ... SET reserved_usd = reserved_usd + $max, calls = calls + 1 WHERE reserved_usd + $max <=
$cap RETURNING`; a missing row is inserted first, `ON CONFLICT DO NOTHING`); zero rows updated ⇒
the cap is hit before any call is made; a failure while reserving the second scope releases the
first (**no call has started**); once a call has started, a failed or crashed settle leaves the
maximum charged, as #592 (`R581-c7B-C-04`). Whichever implementation is bound is authoritative for
caps; `AiRequestAudit` and `pin.metering` are audit copies. Not charged to the coach's Coach-AI budget. **Remembered sites use zero AI calls** (L07). Worst case per
attempt ≈ 4 × 4 096 output + ≈ 63k input tokens ≈ **$1.50** at a $10/$50 per-MTok list price; $20
covers ≥ 13 worst-case first-time sites a day. **Measurement duty (V1-P):** elapsed time per phase,
request and page counts per step, `usd_estimate` per call, recorded on every run.

#### D-L0-7.4 Best model, eval harness, no silent downgrade

- `AI_MODEL_IMPORTER_MAPPING` names the model (`AI_PROVIDER_IMPORTER_MAPPING` the provider); default
  = the strongest frontier model the wired provider offers (`providers/provider-registry.ts` L8-12,
  L22-30). #592 keeps `COACH_AI_MODEL` (`coach-ai.constants.ts` L14) untouched: `importer.mapping`
  has its own gateway service with a per-request `model` (D-L0-7.5), so no shared constant changes.
- **Eval harness** `scripts/scout-learn-eval.ts` (slice **L1e**, D-L0-9; not in #591) scores a model on golden fixtures (`LO` parity,
  `conformance_alpha`/`beta`, `s10_unseen`, the adversarial corpus) plus cost, emitting
  `test/fixtures/scout/learn/eval/<model>.json` with `(model, promptTemplateVersion, contractHash,
outputSchemaHash, passed, date)`. A model is configurable only with a `passed` record for the live
  tuple (L12). **The re-run is a CI job owned by L1e** (`R581-B2-B8 ii`): it runs on every change to
  the contract, vocabulary, prompt template or schema generator — including every FAM-0 W or FAM-C1 merge that
  changes `contractHash` — and fails the PR when the live tuple has no passed record, so learning
  never halts silently after a family lands.
- **Never silently downgrade.** `SCOUT_LEARN_MODEL_FALLBACKS` lists models that hold a passed record;
  only if configured does the service try the next model once on a typed `unavailable`/429/5xx,
  recording the model used; otherwise `learn_unavailable`.

#### D-L0-7.5 Failure channels (`R581-B-B5`, `R581-B-B6`)

- **Gateway (L1-gw, PR #592 r2 `df330304`, in code).** Today `AiGatewayConfig.resolve` returns
  provider `stub` when disabled, disallowed or keyless (`ai-gateway.config.ts` L36-76) and
  `AiGatewayService` swallows provider errors into a stub completion (`ai-gateway.service.ts`
  L287-300). #592 leaves that path to the other capabilities and adds a **separate fail-closed
  service** for `importer.mapping`: `ImporterMappingGatewayService` (`src/ai/gateway/structured/`)
  with structured output against a caller-supplied `responseSchema`, `temperature: 0`, explicit
  output-token cap, a kill switch (`SCOUT_LEARN_AI_ENABLED`) re-read before and during every attempt,
  the `SpendLedger` reservation (D-L0-7.3), allow-listed content-free audit metadata, and typed
  `AiGatewayError` codes `ai_unavailable | ai_budget_exhausted | ai_timeout | ai_rate_limited |
ai_provider_error | ai_request_rejected | ai_malformed_output` (`structured-ai.errors.ts`). L2b's
  learn route maps them: `ai_budget_exhausted` ⇒ `learning_budget_exhausted`; `ai_malformed_output`
  ⇒ one repair, then `learn_refused`; every other code ⇒ `learn_unavailable`. The stub adapter is
  permitted only under `NODE_ENV=test` or the explicit dev flag outside production
  (`importer-mapping.config.ts` `stubAllowed`); stub output is never parsed as a proposal in
  production.
- **Learn failures have a server-side terminal.** `learn_unavailable`, `learn_refused`,
  `learning_budget_exhausted`, `no_collections_observed`, `origin_mismatch` are settled by the
  backend inside the learn route, under the run-row lock, through the CAS `writeTerminal` seam via
  `settleWithSnapshot` (`lifecycle.service.ts` L472-497), as `failed/transfer_failed` with the
  additive `failure_code` (D-L0-6.3). The extension makes zero source requests; Start can be pressed
  again later. There is no deterministic-only guessing path. `extension_update_required` (FAM-0
  L0-A6) is the ingest gate's refusal of a batch whose `device_rules_version` is below
  `SCOUT_MIN_RULES_VERSION` (HTTP 409 `rules_version_below_minimum`; the run settles `failed` with
  that `failure_code`; FAM-P1 owns the check, this record owns the code).

### D-L0-8: V1 proof and the oracle exit

**V1** = one real coaching platform no person has ever mapped, imported end to end from one Start on
pinned SHAs of all three repos; per D2 the owner's own account on the pilot. **Under r5 V1 is one
proof, V1-P (partial proof); V1-C is blocked on CL** (§9) and is not scheduled here.

**V1-P (runs when L1, L1e, L2a-d, L3a-b, X0, X2, X2b, X3, X4, R2 land; FAM-C1 lands before L1):**

1. exactly one Start gesture after authorization and zero coach actions after it;
2. `learned` event on the first run and `reused` (memory, zero gateway calls) on the same coach's
   second intent on that site — **from a different landing page** and, where a second source account
   of the same coach exists, on that sparser account (D-L0-3);
3. per-family: every staged family landed at its destination (native where the family's writer
   slice exists, preserved once FAM-P2/FAM-P3 exist, else `not_moved: destination_gate_closed`);
   `outside_origins[]` lists every foreign origin read (D14); operator-recorded source-visible
   counts equal `source_count` where `count_basis: 'proven'`, and are recorded against the projection
   line by line otherwise (the honesty check of D5);
4. terminal `partial/coverage_basis_unknown` with gap `completeness_not_proven` and no C0-C4 failure,
   so the first run **accepts** the package and item 2 is reachable;
5. **suspect path:** one forced structural failure (a mapped template removed) marks the version
   `suspect` and the next intent learns v+1 with zero duplicate native or preserved rows;
6. **oracle parity:** the learned path on `LO`'s host (file spec and `legacy/` disabled) yields the
   same `(family, source_id)` set and Person `displayName`s as `LO`;
7. **AI-step proof:** passed eval record for the live tuple; L13 green; provenance names model,
   tokens and `usd_estimate` per run;
8. **timing, origin and credential readings:** phase timings and request/page counts (DP-1 input);
   `origins[]` with `contacted`/`credentialed` flags; which D-L0-6.2 path served each cross-origin
   template or which gap it produced; zero credential bytes in any upload (leak test); the D-L0-6.2
   acceptance tests T-01..T-16 green on the pinned extension SHA (packaged MV3 in Playwright
   Chromium, labelled as such) recorded as evidence;
9. **side-effect observation (D-L0-6.2 residual):** for every family the run read and every page
   explore visited, the pilot account's read/unread, "seen" and last-viewed indicators recorded
   before and after the run; any change attributable to replay or navigation is recorded against
   the template or page that caused it; refusal counts per vocabulary token recorded. This reading
   decides whether the bound needs re-tuning; it is evidence, not a decision taken here.

**Exit (DEL, after item 6 is recorded):** delete `E:legacy/**` and `LO`'s
`src/scout/reconstruct/sources/*.json`; shrink the vendor-name-guard allowlists to tests only.

### D-L0-9: slices (r5 graph; each small, independently landable; tier per the T0-T4 doctrine)

All start after X1 and R1 land. "Deps" are hard prerequisites.

| Id     | Repo      | Tier | Scope (owned paths)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | LOC                   | Deps                                                                             |
| ------ | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------- |
| L1-gw  | backend   | T4   | Fail-closed `importer.mapping` gateway (D-L0-7.5): `ImporterMappingGatewayService` in `src/ai/gateway/structured/` — structured output against `responseSchema`, per-request `model`, temperature 0, explicit output cap, kill switch re-read per attempt, `SpendLedger` port + `AuditSpendLedger` (D-L0-7.3), typed `AiGatewayError`, env keys registered, `docs/ai-gateway.md`. In flight: PR #592 r2 `df330304`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ~2.1k src, ~1.6k test | none                                                                             |
| L1     | backend   | T4   | The AI step as a pure library (#591 r2 `debce080`): `src/scout/learn/{digest-contract,contract-vocabulary,admission,proposal,package,fingerprint,canonical-contract,prompt,schema}.ts`; V-L0…V-L10; shared `admission-rules.json` and `fingerprint-vectors.json` fixtures (mirrored byte-for-byte by X2 **after** L1 lands); derived manifest; `describeCanonicalContract`; schema generator; adversarial corpus; metamorphic core-diff test. **Not in it:** service, route, eval harness, CI job (L2b, L1e). **Owed by #591 before it is r7-conformant (implementation, not doc):** (1) drop `out_of_scope_billing` from `UNMAPPED_REASONS` (`proposal.ts` L89-94); (2) add `nonGetDataOrigins` to `digest-contract.ts`; (3) `FAMILY_LABELS` (`contract-vocabulary.ts` L411-436) becomes an import from FAM-C1's catalogue module, which carries `billing_schedule` — L1 defines no family list; (4) coach-derived few-shot packages move inside the nonce block (`prompt.ts` L206-221; D-L0-7.1); (5) `MUTATING_VERB_VOCABULARY` per D-L0-6.2 with the V-L5 token check; (6) V-L10 union rule and the identity/key-path match of D-L0-3. | ~4.5k src, ~2.3k test | L1-gw (types), **FAM-C1 (implemented catalogue; hard)**                          |
| L1e    | backend   | T4   | Eval harness `scripts/scout-learn-eval.ts`, golden fixtures, `test/fixtures/scout/learn/eval/<model>.json`, **CI eval job** that fails a PR when the live tuple has no passed record (D-L0-7.4, L12). Split out of L1 in r6 because #591 does not carry it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ~300                  | L1, L1-gw                                                                        |
| L2a    | backend   | T4   | `SourceRegistryProvider.forRun(db, coachId, intentId)`, `RunPackageSource` / `RUN_PACKAGE_SOURCE` (`NO_RUN_PACKAGE` until L2b), `pinned` + `pinDigest`, `verifyPin` (D-L0-5). **Merged:** PR #588 → `integration/importer` `249fd0d4`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ~300                  | none                                                                             |
| L2b    | backend   | T4   | Store + route + pins: `prisma/schema.prisma` (four additive coach-scoped models incl. the spend ledger), migration + down, `learned-store.service.ts`, `runs/learn` controller/DTO (D-L0-3 incl. the round-2 match rule and `template_absent`), per-coach match, binds `RUN_PACKAGE_SOURCE` to the pin read and `SPEND_LEDGER` to `ScoutLearnSpendLedger` (per-coach + global), maps `AiGatewayError` → `failure_code`, learned-run deadline config + DP-1, server-settled learn failures; `test/rls-g2-learn.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ~450                  | L1, L1-gw, L2a                                                                   |
| L2c    | backend   | T4   | Conformance + per-coach lifecycle: `conformance.ts` C0/C1 **per family**, C2-C4 **per record** over the effective parent set, in the pre-reconstruct locked transaction with write-once persistence (D-L0-4); `accepted`/`suspect`/`superseded`/`invalidated` in the settle transaction (`lifecycle.service.ts` L472-497); `INVALIDATION_TRIGGERS`; `settle-acceptance.pg.spec.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ~300                  | L2b                                                                              |
| L2d    | backend   | T4   | `RunStatusProjectionV1` (D-L0-6.3) **activated**: `families[]`/`not_moved[]`/`gaps[]`/`outside_origins[]`/`excluded_origins[]`/`failure_code`, closed enums in `reason-codes.ts` (incl. `template_absent`, `residual_unknown`, `extension_update_required`, `ExcludedOriginCategory`), the D-L0-6.3 placement table (total over the base's sources, exhaustiveness test, `native_target_removed` ⇒ `moved_native`), `outside_origins` evidence kind (`origin` field), OpenAPI regen; **prerequisite of X4, R2, X3 and FAM-R1** (which extends the mapping).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ~300                  | L2c, L3b                                                                         |
| L3a    | backend   | T4   | Reshape PR #589 for safety: delete `observed_templates`/`ExclusionSignalsV1` and the `reviewed_package` closure (closure is `null` for every package), `pages_fetched ≥ 1`, fan-out bound to the parent id-set digest; negatives from R589-A/B. **In flight in #589 (`61b0d251` read); owed by #589 before it is r7-conformant:** drop `short_page` from `REPLAY_TERMINAL_STOPS` (`contract.ts` L209-212: a short page is **observed**, never proof), rename `none_proven` → `first_page_only`, add `'observed'` to `FAMILY_COUNT_BASES` (L324) computed per D-L0-6 or state in code that L3b supplies it, L15 early-short-page negative. #589 already carries per-family `count_basis`/`source_count` (L3b scope), so the two rows below describe one PR plus a follow-up, not two PRs.                                                                                                                                                                                                                                                                                                                                                   | ~200                  | none                                                                             |
| L3b    | backend   | T4   | Per-family evidence grammar + evaluator: aggregate `steps: StepEvidenceV1[]`, `count_basis` (incl. `observed`) and `source_count` per family, typed per-family reason structure for L2d; `next_url`, `idScope` and fan-out context semantics. Partly present in #589; the remainder lands after L2b (pin).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ~300                  | L3a, L2b (pin)                                                                   |
| L2g    | backend   | T4   | **Deferred.** Cross-coach memory under the D-L0-5 L2g invariants; its own record first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | TBD                   | L2c, CL                                                                          |
| FAM-\* | backend   | T4   | FAM-0's slices, in FAM-0 r10 §7 order, each graded alone under FAM-0: **FAM-C1** (the **one owner** of the family catalogue module — tokens incl. `billing_history`/`billing_schedule` (D10), spec grammar, `destinationFor`, proposal validator; needs L2a and this record; **L1 imports it**), **FAM-P1** (preserve schema, rules file + corpus, `SCOUT_MIN_RULES_VERSION`), **X-RED1**, **FAM-E1a**, **FAM-P2**, **FAM-B1**, **FAM-P3**/**UX-P3**, **FAM-G1**, **FAM-R1** (j-p, `not_moved[]` extension, bucket i, `report_version` + live recompute; needs **L2d** and L3b), W slices **S8-E1a/b/c**, **FAM-N1/N2a/N2b/N2c/N6**, **FAM-E1b**, **FAM-M1** (media, D12; every media mechanism, under the D-L0-6.2 media invariants; test T-17; its record decides the open item (f)).                                                                                                                                                                                                                                                                                                                                                    | per FAM-0             | FAM-0, S8-D3, L0 r8, L2d (FAM-R1)                                                |
| EX1    | backend   | T4   | Exercise-reference resolution (own record, PR #578).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | TBD                   | S8-D3                                                                            |
| X0     | extension | T2   | Backend origin (D6): `shared/protocol.js`, `manifest.json` `host_permissions`, TGP-origin refusals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | ~30                   | none                                                                             |
| X2     | extension | T4   | Digest + compile (D-L0-2): `shared/learn/digest.js` (slot rule, key admission incl. value cross-check, `map` collapse, `paginationSignals`, `origins[]` with `credentialed`, `discoveredBy`, truncation, link inventory) and `shared/learn/compile.js` (identity match → rebinding → `normalizeBlueprint`); leak tests. Mirrors L1's `admission-rules.json`, `fingerprint-vectors.json` and the structural vocabularies byte-for-byte, so it lands after L1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | ~700                  | X1, `E:` #32, **L1 (fixture owner)**                                             |
| X2b    | extension | T4   | Engine evidence (D-L0-6): per-step `StepEvidenceV1`, fan-out contexts, `next_url`, `idScope` composition, learned-mode refusal of synthetic ids, per-origin fetch router under the D-L0-6.2 credential invariants and no-mutation bound (at-most-once requests, pagination key rule); tests T-10..T-12; `LO` unchanged. Mirrors L1's `MUTATING_VERB_VOCABULARY` fixture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | ~400                  | **L1 (vocabulary fixture)**                                                      |
| X3     | extension | T4   | Server-mode learn path in `background.js` (`handleStartImport` L835): start → declaration → attach/reload/idle → contacted origins + credential-header table with frame provenance + media-origin set (worker memory) → digest → learn → explore under the navigation bound → round 2 → compile → replay → evidence upload (incl. the `outside_origins` unit) → `ingest/complete`; capture additions; origin = scheme + host + port; FAM-0 partner-origin rule with per-category `origin_rejected` counts; ninth-origin refusal; worker-restart claim without resume; `tab_lost`. **Its own design decides the browser mechanisms; the D-L0-6.2 tests T-01..T-09, T-13..T-16 on the packaged MV3 extension are its merge gate.**                                                                                                                                                                                                                                                                                                                                                                                                           | ~750                  | X0, X2, X2b, L2b (route), **L3b (evidence shape)**, L2d (`outside_origins` kind) |
| X4     | extension | T2   | Popup result detail over `RunStatusProjectionV1` incl. `outside_origins[]`; exactly one Start button, otherwise status-only (D9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | ~200                  | L2d (OpenAPI)                                                                    |
| R2     | mobile    | T3   | Roman result detail over `RunStatusProjectionV1` (incl. `outside_origins[]`) in `ImportResultView` from R1 copy; `failure_code` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ~150                  | L2d (OpenAPI)                                                                    |
| V1-P   | all       | T4   | Partial proof (D-L0-8 items 1-9); no product code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 0                     | L1e, L2d, L3b, X3, X4, R2                                                        |
| CL     | backend   | T4   | **Completeness-closure record** (future; not this record): consumes §9; defines how `complete` is proven for learned, file and legacy packages; unblocks V1-C.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | doc                   | V1-P readings                                                                    |
| DEL    | ext+back  | T3   | Delete `legacy/**` and `LO`'s `sources/*.json`; shrink guard allowlists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | neg.                  | V1-P item 6                                                                      |

Graph: FAM-C1 → L1 (implemented catalogue, hard); L1-gw → L1 → L1e; L1 → X2 and L1 → X2b
(fixture owner: L1, the extension mirrors); L0 r8 + L2a → FAM-C1; L2a merged; L3a ∥ X0 now; X2 and
X2b after L1; L1 + L1-gw + L2a → L2b → L2c; L3a + L2b → L3b; L2c + L3b → L2d → {X4, R2, FAM-R1};
X0 + X2 + X2b + L2b + L3b + L2d → X3; V1-P needs L1e, L2d, L3b, X3, X4, R2; FAM-C1 → FAM-P1 → … →
FAM-M1 per FAM-0 §7; CL after V1-P readings; L2g after L2c and CL. No slice edits another's path;
every slice lands alone. The ~900 LOC guide is exceeded by the in-flight L1 (#591) and L1-gw
(#592), both pure contract/gateway code with their own T4 reviews — recorded here, not re-split.

**Said NO to:** `RunClosureV1`, hidden-surface machinery, status probes, `confirmExclusion`,
`reviewed_package` closure, `observed_templates`; a model-proposed destination; exclude-by-default
for partner origins; billing as a gap or exclusion; reading, copying or re-injecting cookie values;
persisting the credential table or resuming a run across a worker restart; retrying a request that
may have reached the source; visiting a link or submitting a form whose URL hits the vocabulary; a
media mechanism here; a Chrome-behaviour claim without a packaged-extension test; a second family
catalogue; GET as proof of no side effects; a global memory table in V1; hash promotion and
`slotHash`; free-text `error_summary` as input; synthetic ids; a second permission gesture; a new
phase or terminal status; DOM/SSR fallback; export ingestion; a deterministic guess path; value
samples in the digest; storing digests, slot values, header values or credentials; stub providers
as fallbacks; any change to `reconcile.ts`, `coverage.ts`, `arbiter.ts` or `RUN_REASON_CODES`; human
review before acceptance; any per-site token, vocabulary or threshold.

## 3. Invariants asserted by L-specs (S7-L to S12 invariants unchanged)

1. **NEW SOURCE → CORE DIFF = 0:** a learned site adds rows only; the S10-D gate is byte-clean; no slug
   or host literal enters `src/scout/learn/*.ts` or `shared/learn/*.js` (metamorphic test).
2. **AI returns data only:** every reply passes V-L1…V-L10 or is refused; origins, methods, headers
   and completion are never model output; an `unmapped` reason is a disclosed claim, never an
   exclusion.
3. **Values, credentials and unproven names never leave the device:** no value, credential-policy
   match, header value, whitespace key, value-equal key, non-vocabulary literal or unadmitted key in
   any digest or package; the server refuses a digest its own `admitKey` would not admit; no cookie
   value or credential header is ever persisted, logged, uploaded or handed to a page script
   (I-C1); cookies attach only by the browser (I-C2); credential headers live in worker memory,
   keyed by exact origin and frame, go only to that origin from that frame context, and die with
   the worker (I-C4, I-C6).
4. **Unknown is never zero:** `source_count` is null without an `observed`/`proven` basis; a first
   page is never certified; a fan-out shortfall is `observed` with gap `list_not_exhausted`; a
   missing step is `unknown` (D-L0-6).
5. **No false `complete`:** closure is `null` for every package type until CL; the only `complete`
   path is the test-only basis refused outside dev/test; every run carries `completeness_not_proven`.
6. **Tenancy and memory safety:** every memory row is coach-scoped in V1; no cross-coach row exists;
   an `accepted` package serves only the coach whose run proved it; triggers are structural, closed
   and server-computed; every reuse re-validates; L2g cannot land without its stated invariants.
7. **Identity is real:** no positional ids; per-parent namespaces are composite; C0 ties the union
   of engine counters to the staged identities per family, and a failing family is dropped alone.
8. **Read-only source, confined and bounded:** GET/HEAD, no body, templates the page itself issued
   this run with an observed query-key set plus the validated pagination key, no vocabulary hit in
   path, query key or value, at most one request per `(template, parent, page)`, rate-limited;
   explore navigates only to inventory URLs that pass the same check, never clicks, fills or
   submits; session loss settles `partial`, never a login; the residual (hidden GET side effects,
   visited pages' own scripts) named and observed by V1-P; origins (scheme + host + port) = tab ∪
   the `https` foreign origins the partner-origin rule admits and the package needs; cookies never
   widened (I-C3); headers re-attached only to the exact origin and frame context that carried them;
   every outside origin named in the result, a ninth refused; a worker restart settles the run and
   never resumes it.
9. **One registry seam:** every family assertion traces to `SourceRegistryProvider.forRun`.
10. **Hostile input stays data:** site and coach-derived bytes only inside the nonce-delimited blocks; prompt structure and
    schema are byte-derived from the contract; model, tokens and hashes in every run's provenance; a
    model without a passed eval record is never called; spend is reserved in a committed ledger before
    every call; a remembered site makes zero calls.
11. **One projection:** popup detail and Roman render only `RunStatusProjectionV1`; each fact appears
    exactly once, as a count in `not_moved` or an unknown in `gaps`.
12. **Destination is derived:** the model proposes a family label only; `destinationFor` decides
    native vs preserve per record; no proposal field can steer a write path (FAM-0 D-FAM-1).

## 4. Acceptance cases (L-cases)

- **L01 (L1)** valid digest + proposal → package; one refusing case per V-L0…V-L10, including a
  `templateRef` with role `single`, a `text` `idField`, a path not in the shape or into a `map`, a
  step token missing from `steps`, an absolute URL, an extra key, a 65 KiB package, a collection in
  neither or both of `steps`/`unmapped`, a `destination` field (extra key) or a `family` outside the
  D-FAM-1 catalogue, a literal or host label outside the vocabulary, a header
  value, an unadmitted key, a credential-like key, a whitespace key, `style: 'none'` with signals, a
  `forEach` step without `idScope`, a round-2 proposal dropping a round-1 step whose identity is
  in the union, a step template with a mutating token in a path segment or query key
  (`GET /api/items?mark_read=1`; V-L5); accepted:
  `next_url` with `nextPath` in shape, `param` from `PAGINATION_VOCABULARY` with the matching signal,
  a truncated digest (gap), a `collection_unproven` refusal (gap).
- **L02 (L1, X2)** template identities and the round-1 fingerprint ignore ids, values, slot values,
  kinds, length buckets and `null`/absent optional keys; are equal for two accounts of one site that
  differ in tenant segments, host labels, header values and data sparsity; a template observed with
  extra optional keys keeps its identity and matches with `keypath_growth`; the fingerprint changes
  when a template or a referenced key path changes; byte-equal to the extension fixture.
- **L03 (X2)** digest of the `LO` fixture and `conformance_alpha` contains no value, id, email,
  name, header value, link text or slug; three-tenant and two-coaches-of-one-gym counterexamples
  give one byte-identical digest; a name-keyed single object, a question-text form, a token-bearing
  dynamic key, a **name-keyed pivot row** (key equals a captured value) and a whitespace key each
  collapse to `map/unadmitted`; a 3-sibling roster and a nested `custom_fields` object with
  grammar-clean labels repeated across items are admitted; compile rebinds slots, `:q` values, origins
  and header values from the fixture capture; an unbound slot yields zero requests and `slot_unbound`;
  the key-admission fixture passes byte-identically on device and server.
- **L04 (X2)** compiled `LO`-learned blueprint passes `normalizeBlueprint` and drives the fixture
  replay to the same `(entityType, sourceId)` set as `legacy/`.
- **L05 (L2b, PG)** RLS/REVOKE posture as R31; a coach's `candidate`/`accepted` rows are invisible to
  another coach's lookup; version uniqueness under concurrent first learns; the spend ledger refuses
  the call that would cross the cap under two simultaneous requests; a failed first call leaves
  `reserved_usd` released; down refuses with rows.
- **L06 (L2a, merged)** every site resolves a run-pinned learned slug and still resolves `LO` and
  the synthetic specs; a slug in both file and memory throws; a run without a pin sees exactly the
  file registry (`pinned: null`, `pinDigest: null`); `verifyPin` refuses a pin changed within one
  settle (`source-registry.provider.spec.ts`, `settle-registries.spec.ts` at `249fd0d4`).
- **L07 (L1, L1-gw)** memory hit ⇒ no gateway call; disabled/stub/timeout/500/429/non-conforming ⇒
  typed error ⇒ `learn_unavailable`, zero source requests, server-written terminal; refused twice ⇒
  `learn_refused`; each cap ⇒ `learning_budget_exhausted`; fallback only when configured and
  recorded; temperature 0 and maxTokens on every request; ledger reserved before and charged after
  every call.
- **L08 (L2b, L2c, PG)** structural acceptance marks `accepted`; the same coach's later intent
  **from a different landing page** and on a **sparser second account** is `reused` with zero gateway
  calls, package steps absent from round 1 becoming explore targets; **sparse account:** a package
  step whose request the page never issues after its link was visited passes round 2, re-pins the
  same version, and its family is gap `template_absent` with `count_basis: unknown` while every
  other family moves — never `digest_not_union`, never `learn_refused`; **key-path growth:** the
  roster template re-observed with two extra optional keys passes (ii) and (iii) and re-pins with
  `keypath_growth: 2`; a union that drops a round-1 **observed** identity or shrinks its key paths
  **without** a truncation flag is refused `digest_not_union` and the true union then re-pins;
  **large account:** a round-1 digest at the template cap whose union overflows carries every
  round-1 identity forward and re-pins (or makes one model call), never `learn_refused`; a genuinely new collection identity
  triggers one model call whose candidate must keep every round-1 step present in the union; another
  coach on the same slug is **not** served it and learns separately; `slot_unbound`, an empty
  collection, unproven pagination and key-path growth do **not** trigger; `template_absent` with the
  discovering link visited **and** ≥ 1 other data request from that visit, and `items_path_missing`
  on a non-empty response, mark `suspect`; `template_absent` with the discovering link **absent from
  the inventory**, or with a visit that issued no data request (cached page), is a gap and no
  trigger; a second trigger invalidates, and the next intent learns v+1 with the old row
  `superseded`; round 2 never consults another memory version; a variant step and per-parent child
  ids pass union C0; a crafted extension whose counters are self-consistent but disagree with staged
  rows for **one** family fails C0 for that family only (`not_moved: identity_conflict`) while the
  other families reconstruct; **C3 per record:** one malformed workout row is preserved, the other
  rows of the family are native, no trigger; rules failing on every row drop the family's rules,
  preserve every row and record `native_rules_dropped`; **C2/C4:** a roster with two null-name rows
  writes the other clients, marks the two `destination_gate_closed`, attributes their children
  `unresolved_parent` (count each) and writes the children of the remaining clients and every
  coach-owned row; an all-null roster drops `clients` whole (`items_path_missing`), every
  client-owned child is `unresolved_parent`, coach-owned families proceed; a child of a client that
  exists only as a verified Person link (no staged row) on the **same** platform links, while a
  Person of another platform with the same source id does **not** (`unresolved_parent`); a worker
  restart or deadline mid-crawl leaves families without evidence `unknown`, fires no trigger and
  leaves the package `candidate`; CAS miss changes nothing; the round-2
  pin is a new row and the round-1 pin is byte-identical after settle; `conformance` is written once
  per epoch and re-entry skips.
- **L09 (X3, X2b; r8)** Start with unknown origin → server-mode run → learn → explore → replay
  (incl. `:q` variants, fan-out, `next_url`) → evidence → claim, in the **packaged-MV3 extension
  harness** against a fixture server; denial, non-https tab, `learn_unavailable`, normalizer throw,
  an uncontacted origin, a POST or body (refused) and every D-L0-6.2 acceptance test **T-01..T-16**
  as written there (single-origin first; HttpOnly sentinel; no-widening and mixed-endpoint cookie
  cases; service-worker-served tab origin; subframe header never handed on; worker restart settles
  `worker_restarted` without resume; session loss without a login; `/logout` and delete links
  never visited; vocabulary refusals and must-not-refuse `events`/`sets`; pagination key and
  `next_url` admission; at-most-once request; non-default-port origin named, `http` origin
  `cross_origin_insecure`; ninth origin `outside_origin_refused`; excluded categories; storage JWT never sent; `tab_lost`)
  each settle or gap truthfully with zero unauthorized requests and zero credential bytes in any
  upload. The fixture whose detail GET flips a read flag without a lexical trace is fetched once —
  the documented residual the harness bounds and cannot prevent.
- **L10 (V1-P)** D-L0-8 items 1-9 recorded on pinned SHAs.
- **L11 (L1)** prompt structure section == `describeCanonicalContract()` (hash equality); adding a
  family or field description changes `contractHash` with no other edit.
- **L12 (L1, CI)** a live tuple without a passed eval record refuses to configure the model **and
  fails the CI eval job** on a contract/vocabulary/family-catalogue change; the harness on the fixture adapter is
  deterministic.
- **L13 (L1)** adversarial corpus: every item ⇒ refusal or clean-baseline-identical proposal; injected
  bytes appear in the prompt only inside a nonce-delimited untrusted block — including an injection
  string planted as a key name in a coach-derived example package, which appears only inside
  `UNTRUSTED_EXAMPLE_PACKAGE_BEGIN/END` and never in parts 1-5.
- **L14 (L2d)** projection attribution: every `NotMovedReason` and `GapCode` is disjoint; a fact never
  appears in both; `source_count` null under `unknown`; proven rows satisfy `source_count =
moved_native + preserved + not_moved`; the D-L0-6.3 placement table is total over the base's
  histogram keys, `UNRESOLVED_CODE`s and conformance outcomes (an unplaced key fails the build);
  `unresolved:native_target_removed` counts in `moved_native` and never in `not_moved`;
  `not_reconstructed`/`reason_unrecognised` are `cause_unknown`; a preserve family gets a row;
  `collection_unmapped` for each unmapped template; `completeness_not_proven` on every run; a `null`
  closure never evaluates `complete`; a `source_signed_enumeration` manifest is refused outside
  dev/test; a bucket-f legacy row is `not_moved: destination_gate_closed` with no gap and a version-0
  native identity is in `moved_native` with no `not_moved` entry; `excluded_origins[]` carries counts
  only; an `outside_origins` unit with more entries than the working union's contacted foreign
  origins, or an entry that is not `https://host[:port]`, is refused.
- **L15 (L3a, L3b)** a missing step, a duplicate `stepKey`, `pages_fetched: 0` on a root step,
  `parent_ids_digest` ≠ the parent's digest, duplicate-parent-A/omitted-B contexts, `expected: 0` with
  a non-empty parent, H > 1 pages per context, a `budget` stop, `refused_pages > 0`, a **metadata-free
  17-item first page** (`first_page_only`) and an **early short page** each yield `observed` or
  `unknown`, never `proven` (the omitted-B shortfall is `observed` + `list_not_exhausted`; the
  missing step and zero-page root are `unknown`); a two-page fixture with `empty_page` on page 3 is `proven`; a reviewed
  file package and a legacy package both get `closure: null`; a `reviewed_package` record is never
  produced.
- **L16 (L2d, X4, R2)** counts and closed codes only, no path/ref bytes; every code rendered from
  R1-owned copy; unknown code ⇒ generic line; absent fields ⇒ today's rendering; `failure_code`
  keyed first; no fact rendered twice; `outside_origins[].origin` rendered verbatim (scheme, host,
  port), never a path;
  `excluded_origins[]` rendered as category counts; `extension_update_required` renders the R1 copy
  "update the extension and start again".

## 5. Not decided (deferred; not owner-reserved)

Cross-host memory reuse; multi-scope platforms (S10 E6 attribution); enum value sampling under
k-anonymity; learning from official exports; DOM/table evidence; an owner observability view of
memory versions; extending the vocabularies (reviewed contract changes, never per site); resumable
exploration across runs (V1-P timings decide); non-GET (GraphQL) read replay; non-English
vocabularies (`R581-B-C6`: such sites degrade to slots and gaps); L2g's design; everything in §9.

## 6. Owner-reserved questions (status)

- **Q-L0-1 — DECIDED by D1** (unclaimable until CL). **Q-L0-2 — by D2.** **Q-L0-3 — by D3;**
  provider key NEEDED BY USER; cap `=20` PLACEHOLDER. **Q-L0-4 — flags APPROVED pre-user
  2026-09-27;** deploy needs separate approval. **Q-L0-5 (Web Store) — later (D13)**; capture uses
  `chrome.debugger`, so every run shows the debugging bar and DevTools detaches capture — Web Store
  justification and R1 handoff copy. **Q-L0-6, Q-L0-7 — RESOLVED by NS.** **Q-L0-8 (retention) —
  DEFAULTED:** versions kept while `accepted`; `superseded`/`invalidated` kept 180 days unless
  pinned inside a run's retention (`SCOUT_LEARN_RETIRED_VERSION_RETENTION_DAYS`). **Q-L0-9 —
  CLOSED by r4.** **Q-L0-10 — by D1/D4.** **P1-P6 — DECIDED** as D9-D14/B2 (header).
- **Nothing in this record is owner-pending.** FAM-0's owner questions live in FAM-0. r7 and r8 add
  no owner item: the no-mutation and navigation bounds are engineering bounds inside D14 with their
  residual observed by V1-P item 9; the tab-origin in-origin over-send (D-L0-6.2 I-C3) is stated,
  not asked; the open media-URL authority item (D-L0-6.2 media (f)) belongs to FAM-M1's record.

## 7. Release boundary and V1 preconditions

A local contract for L1-gw, L1, L1e, L2a-d, L3a-b, FAM-\*, EX1, X0, X2, X2b, X3, X4, R2 and V1-P.
Passing L01-L16 proves candidate behaviour only; grants, PG slots and reviews are parent decisions;
deployment, flags, customer enablement, Web Store publishing and any `main` merge stay
owner-reserved. **V1-P preconditions:** owner deploy approval for the Q-L0-4 flags; the provider key;
credential rotation before real client data enters production; FAM-0 approved. **V1-C:** CL landed
and reviewed (§9), plus FAM-P2/FAM-P3 and the W slices the pilot exposes. Doc alignment here is not
implementation closure: #591, #589, FAM-C1 and the extension slices are conformant only when their
owed lists (D-L0-9) and the D-L0-6.2 tests are landed and reviewed.

## 8. Closure table — r8 rows first, then r7, r6 and r5 in brief (finding → section → status)

**r8.** The r7 T4 audits `R581-c7A2` (01-03 A, 04-05 B, 06 C) and `R581-c7B2` (01-02 A, 03-10 B,
C-01..C-05) requested changes on `e79e6578`. The operator's binding direction: repeated T4 failure
on browser-mechanism detail ⇒ **reduce scope** — bind contracts, invariants and acceptance tests,
delete mechanism claims. Every A and B finding is closed below. "Closed (doc)" means the record
states the rule and names the test; implementation closure belongs to the owning slice and is not
claimed here.

| Finding (r8)                                             | Class | Section                                                                                                                   | Status                              | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R581-c7A2-01, R581-c7B2-03                               | A / B | D-L0-6.2 I-C1, I-C2, T-02; §3 inv. 3                                                                                      | Closed (doc); X3 implements         | Disposition 1. The "never enters worker memory" claim and the deriving-event mechanism are **deleted**. Invariant: never persisted, logged, transmitted or handed on; cookies attached only by the browser; an **honest transient-exposure bound** (retain nothing, serialise nothing, unreachable after the handler returns); T-02 plants an HttpOnly sentinel and asserts every sink, not only `executeScript` args.                                                                                                                                                                                                                                                                                                                  |
| R581-c7A2-04, R581-c7B2-04                               | B     | D-L0-6.2 I-C3, T-03, T-04, T-05; §8 row consistency                                                                       | Closed (doc); X3 implements         | The per-origin boolean and its derivation are deleted. Contract: per template, cookies only where the page's own request carried them, else **none** and the auth gap — never `include` by default, never a login; tab origin keeps today's background path with the in-origin over-send stated. Mixed, SameSite/partitioned and service-worker-served fixtures (T-04, T-05). The r7 §8 contradiction is gone with the rule.                                                                                                                                                                                                                                                                                                            |
| R581-c7B2-05                                             | B     | D-L0-6.2 I-C6, T-07; D-L0-5 triggers; L08                                                                                 | Closed (doc); X3, L2c implement     | Restart semantics chosen: **the run does not resume** (`E:background.js` L20-22); the worker claims what is staged with `worker_restarted`; C0 evaluated only on complete evidence rows; restart/deadline added to the never-invalidate list; package state unchanged. `R581-c7B2-C-05` is moot (no re-observation on restart).                                                                                                                                                                                                                                                                                                                                                                                                         |
| R581-c7B2-09, R581-c7A2-06                               | B / C | D-L0-6.2 I-C4, T-06; D-L0-1 step 4                                                                                        | Closed (doc); X3 implements         | Disposition 8. Credential headers keyed by **exact origin and `frameId`**; re-attached only from the same frame context; V1 replays only from the top frame and background, so a subframe- or worker-observed header is never re-attached or handed to any realm (T-06).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R581-c7A2-02                                             | A     | D-L0-6.2 Origins, T-13; D-L0-6.3 `OutsideOriginV1`; D-L0-2                                                                | Closed (doc); X3, L2d implement     | Disposition 2. An **origin is scheme + host + port**; non-default `https` ports admissible under the same bounds, attributed to families and named as `https://host[:port]` in `outside_origins[].origin` (field renamed from `host`; FAM-0 ask); `non_canonical_origin` deleted; non-`https` ⇒ gap `cross_origin_insecure`, never a silent count.                                                                                                                                                                                                                                                                                                                                                                                      |
| R581-c7B2-01, R581-c7A2-05, R581-c7B2-06, R581-c7B2-C-02 | A / B | D-L0-6.2 No-mutation bound, T-09..T-12; D-L0-6 `next_url`; §3 inv. 8; D-L0-6.3 `navigation_refused`, `start_page_refused` | Closed (doc); X2b, X3, L1 implement | Disposition 3. The bound now covers **navigation**: every explore target and the Start reload URL pass the vocabulary check (extended with logout/signout/login/auth/oauth/deactivate/… terms; exact whole-token semantics, no stemming) or are never visited (`navigation_refused`); explore never clicks, fills or submits; session loss ⇒ one reload, no login, `partial`. Replay key rule made consistent: observed key set ∪ validated pagination `param`; `next_url` keys admitted as served under the token check; **at most one request** per `(template, parent, page)`, no retry after send. Residual restated (hidden GET effects **and** visited pages' scripts), V1-P item 9 observes both and records per-token refusals. |
| R581-c7B2-02                                             | A     | D-L0-2 bounds, D-L0-3 (ii)/(iii), L08                                                                                     | Closed (doc); L2b, X2 implement     | Disposition 4. Round-1 observed identities **carry forward by identity** into the working union; refusal only when a union shrinks or omits a round-1 identity **without** a truncation flag; explore-only templates truncate first. A rich account can never reach `learn_refused` through truncation.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| R581-c7A2-03, R581-c7B2-10                               | A / B | D-L0-6.1, D-L0-6.2 Media invariants, T-17; D-L0-9 FAM-\*                                                                  | Closed (doc, by deferral); FAM-M1   | Disposition 5. r7's media authority (`redirect: 'manual'`, per-hop, fetch context) is **deleted**. Nothing before FAM-M1 fetches media; media is a disclosed `not_moved: destination_gate_closed` gap. L0 binds invariants only (origin set the page itself loaded media from, named in `outside_origins[]`; verbatim URL; credential invariants; counted outcomes for redirects/opaque/caps). The unrequested-path question (c7A2-03) is **open for FAM-M1's record** and named as such.                                                                                                                                                                                                                                               |
| R581-c7B2-08                                             | B     | D-L0-4 effective parent set; L08                                                                                          | Closed (doc); L2c implements        | Disposition 6. Verified Person links scoped to **this coach and this run's `source_platform`** (`Person` unique on `(coach_id, source_platform, source_person_id)`); cross-platform same-id negative in L08.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R581-c7B2-07                                             | B     | D-L0-6.3 placement table; L14; D-L0-9 L2d                                                                                 | Closed (doc); L2d implements        | Disposition 7. Full **placement table** over every base key (`classifyIdentity`, `S9_REPORT_CODE`, `UNRESOLVED_CODE`, `pin.conformance`): `native_target_removed` ⇒ `moved_native` **from L2d onward** (FAM-0 bucket i); unknown-cause keys (`not_reconstructed`, `reason_unrecognised`, bucket k) ⇒ L0-owned append `cause_unknown` (count known, cause honestly unknown); FAM-R1 changes no row.                                                                                                                                                                                                                                                                                                                                      |
| R589-c7B2 (class C, via operator)                        | C     | D-L0-6 fan-out; §3 inv. 4; L15                                                                                            | Closed (doc); #589 already conforms | One rule in one place: a fan-out shortfall with no `error`/`budget`/`cycle` stop is **`observed`** with gap `list_not_exhausted`; only a missing/extra/duplicate step, a zero-page root or such a stop is `unknown`. §3 inv. 4 and L15 corrected to match; #589 follows this rule.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R581-c7B2-C-01, C-03, C-04, C-05; R581-c7A2 notes        | C     | D-L0-3, D-L0-6.3, D-L0-5                                                                                                  | Closed                              | C-01: match is by identity alone; absent `idField` is a miss. C-03: the media-origin self-attestation is gone with media deferral; the server bound is the working union's contacted foreign origins. C-04: `LO`-slug Persons noted under D-L0-5, V1-P item 6 records it. C-05: moot — a restarted worker never re-observes (I-C6). A Playwright CDP probe of a plain page is stated not to discharge any T-test.                                                                                                                                                                                                                                                                                                                       |

**FAM-0 r10 (`61c7c97f`) amendments, applied in r8 (none conflicts with an audit closure):**
L0-A2′ comment unchanged (already verbatim); L0-A4′ gap `outside_origin_refused` appended and used
for the ninth origin (D-L0-6.2, D-L0-6.3, T-14, L09); L0-A5 six categories, `non_canonical_origin`
withdrawn; L0-A6 `failure_code` comment widened; L0-A7 `moved_native` comment (coach or linked
client) and the placement table; L0-A8 wiring (verdict fields from the settled report, family
counts from FAM-R1's live recompute for every intent); D-FAM-1's executive interpretation of D14
referenced in the replay bound.

**Notes for FAM-0's next round (via the operator; the FAM-0 file is not edited here).** (a)
`OutsideOriginV1.host` → `origin` (`https://host[:port]`); D-FAM-1's "checked server-side against
the admitted origin set" → device-attested with the D-L0-6.3 bound. (b) `ExcludedOriginCategory`
does **not** gain `non_canonical_origin` (withdrawn). (c) `NotMovedReason` gains the L0-owned
`cause_unknown`; bucket i stays `moved_native` as FAM-0 §6.2 says; r8 also appends `cross_origin_insecure`, `navigation_refused`, `worker_restarted`, `start_page_refused`. (d) §5.2's `redirect: 'manual'`
per-hop wording is a FAM-M1 mechanism to prove on the packaged extension (T-17), with the
unrequested-path rule (D-L0-6.2 media (f)) decided in FAM-M1's record. (e) D-FAM-1 (a) "the page in
the authorized tab" means the **top frame** (I-C4). (f) The must-capture `events` corpus case is
consistent with exact-token semantics (`events` ≠ `event`).

**r7 (closed on `e79e6578`; rows kept for the audit trail, mechanism parts superseded above).**
`R581-c7A-01`/`c7B-02` identity matching and the monotone round-2 rule (D-L0-3; extended by r8);
`c7A-02`/`c7B-01` credential model (D-L0-6.2; **superseded by r8 invariants**); `c7A-03`/`c7B-07`
no-mutation bound and residual (D-L0-6.2; extended to navigation in r8); `c7A-04` L2d activation
(D-L0-6.3; table in r8); `c7A-05`/`c7B-05`/`c7B-09` FAM-C1 catalogue owner, L1 → X2/X2b edges,
#591 owed list (D-L0-4 V-L4, D-L0-9); `c7A-06` origins (**superseded by r8**: scheme + host +
port); `c7A-07`/`c7B-04`/`c7B-C-05` per-record C2-C4 and the effective parent set (D-L0-4);
`c7B-03` few-shot inside the untrusted block (D-L0-7.1); `c7B-06` #589 owed list (D-L0-9 L3a);
`c7B-08` media authority (**superseded by r8**: deferred to FAM-M1); `c7B-10` legacy placement
(D-L0-6.3); class C items closed; FAM-0 r9 §8.1 amendments L0-A2′/A4′/A5-A8 applied.

**r6 (closed on `d5bfea98`).** Owner decisions D9-D14/B2 recorded (header); r5 review items a-f:
`destination.kind` → `family` label with `destinationFor` (D-L0-4); slice text aligned with merged
L2a and in-flight #591/#592 (D-L0-5, D-L0-7, D-L0-9); round-2 rule (superseded by r7/r8);
`template_absent` (D-L0-3); single-origin base case (D-L0-6.2); C0 per family (D-L0-4); FAM-0 r8
amendment list applied; base `249fd0d4`.

**r5 (closed on the executive reset; full rows in the record's history at `e79e6578`).** Closed:
`R581-A2-01/03/04/05/06/07/08/09/10`, `R581-B2-A1/A2/A3/A5`, `R581-B2-B1/B2/B3/B4/B5/B6/B7/B8`,
`R581-B2-C1..C7`, `R581-A-01/02/03/06/07`, `R581-B-A1/A3`, `R581-B-B2/B4/B8/B9/B10`,
`R589-A1/A2/A4`, `R589-B-A1/B1`, `R590-B-A1` (L0 side), the FAM-0 → L0 r6 asks. **Deferred → CL**
(§9 inputs): `R581-A2-02`, `R581-B2-A4`, `R581-B2-B9`, `R581-A-05`, `R581-B-A4` — each is about
proving `complete`, which no run can claim under r5 (D-L0-6).

## 9. Deferred: completeness closure — required inputs to the CL record

Until CL lands, every run settles `partial` with gap `completeness_not_proven` (D-L0-6). CL must
address each input by id before any package type may settle `complete`; the source reports hold the
detail. **C-01** `R581-A-05`, `R581-B-A4`: observed navigation ≠ the site's record surface (hidden,
archived, filtered, paginated-away records need positive coverage evidence). **C-02** `R581-A2-02`,
`R581-B2-B9`: SPA-only routes are unobservable; a "referenced but unreached" signal is needed.
**C-03** `R581-A-03`, `R581-A2-03`: a first or short page never proves exhaustion. **C-04**
`R581-A2-04`, `R589-A1`, `R589-B-A2`: reviewed file packages have no closure either. **C-05**
`R581-A2-05`, `R581-B2-B3`, `R589-A2`, `R589-B-A1`: closure inputs must be durable, epoch-bound,
privacy-safe, never producer-asserted booleans. **C-06** `R581-A2-06`, `R589-A4`, `R589-B-B1`:
fan-out identity binding is the floor. **C-07** `R581-A2-07`: an `unmapped` exclusion counts only
with positive proof; ambiguous collections are preserved. **C-08** `R581-A2-08`: requests beyond
observed templates must stay inside D-L0-6.2's bounds. **C-09** `R581-B2-A4`, `R581-B2-B4`:
filter/status variants per family or an honest gap. **C-10** `R581-B2-B6`, D14: whether and how
partner-origin collections count. **C-11** `R589-A3`: empty collections need a positive empty
terminal. **C-12** `R589-A5`, `R589-B-B2`: named gaps reach the coach through D-L0-6.3. **C-13**
`R590-A2`, `R590-B-B3`: a native row that lost residual fields or a secret-stripped preserved record
is not "in TGP" for `complete`. **C-14** `R590-A3`, `R590-B-A2`, `R590-B-B1`, `R590-B-B2`:
graduation, archived records, the destination window and the legacy table reconcile under one
bucket order first. **C-15** `R590-B-A1`, `R590-B-B9`, `R590-B-C5`: one projection and one
destination authority; `source_count = moved_native + preserved + not_moved` under `proven`.
**C-16** `R581-B-B8`: V1-C on a large pilot may need resumable exploration (§5).
