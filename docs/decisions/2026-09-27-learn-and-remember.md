# L0: learn-and-remember — decode, learn, import, verify, remember, in one process (contract)

- **Status:** T4 cross-repo decision record (backend, extension, mobile), **r9, condensed contract**;
  doc only, claims nothing has run. **Owner:** Bradley Gleave. **Date:** 2026-09-27; r9 2026-09-29.
  **Prior text:** r8 at `f89e761a` in git history; r9 replaces it and carries nothing by reference.
- **Binds** the rules, invariants and tests owning slices (§3) must pass; how a slice realises a rule
  is its own design, reviewed at its own T4 with the named tests green on its exact head.
- **Split with FAM-0** (`2026-09-29-fam0-all-families.md`): L0 owns the run, learn step, memory,
  origin/credential/read-only bounds and the **one run-status projection** (D-L0-6.3); FAM-0 owns
  families, destinations, PRESERVE, redaction, erasure, media and reconciliation inputs, citing L0 by
  section. North Star: `docs/importer/NORTH_STAR.md`.

## 1. Owner decisions recorded (binding)

- **D1 "complete"** = _"All past client and coaching records in this site are now in TGP"_. No
  narrowing: any reachable family that did not land makes the run `partial`, named. Unclaimable until
  CL (§7). **D2** pilot = the owner's own coaching account on the owner-chosen platform. **D3** AI
  spend cap $20/day, a placeholder until per-site cost is known.
- **D4 no unsupported families:** everything reachable moves into TGP, native or preserved in the
  universal tenant-scoped destination; preserved records count as "in TGP" (FAM-0).
- **D5 honesty detail:** a `partial` run shows, per family, what came and what did not — unknown as
  unknown, never 0 — in the popup and the Roman result, both from the one projection. **D6 backend
  origin** `https://backend-spring-lake-3890.fly.dev`; `tgp.coach` is never used.
- **D7 origins:** one Start authorizes only the tab origin; cross-origin data APIs the page itself
  called are reached without extra permission by replaying its learned GET/HEAD templates.
- **D9** one Start button; the rest of the popup is status. **D10** billing and payment history move
  (preserved, coach-visible, per-client next payment date; no live charge moves; FAM-0 D-FAM-5).
  **D11** registrable-domain fallback: later. **D12** media storage spend approved on existing
  S3-compatible storage (FAM-M1). **D13** Web Store: later.
- **D14 / B2** partner and third-party data reachable through the coach's own logged-in page
  **moves**, bounded: read-only GET/HEAD replay of requests the page itself made, re-attaching only the
  credential header it sent to that origin; no stored credential, login or mutation; rate-bounded;
  every outside origin named in the result.

## 2. Decisions stated as rules

### D-L0-1 The one process

- One server-owned run (S7-L `mode='server'`): the extension executes; the backend decodes,
  remembers, writes and settles; phone and popup are status. Start (X1 grants the tab origin, revoked
  at settle) → observe → learn → explore → round 2 → replay → ingest → claim → conformance →
  reconstruct → S9 → S10 → arbiter → CAS terminal → acceptance → projection; zero coach actions.
- **Extension credential (S18 / G3-AUTH):** the full coach session pairing hands over today becomes a
  short-lived, revocable **importer capability scoped to one intent and its run**, valid only on that
  intent's importer routes, revoked at settle, cancel or disconnect, never refreshed into a general
  session. S18 lands before any coach other than the pilot owner is enabled.

### D-L0-2 Where AI runs, and on what

AI runs only on the backend via the fail-closed gateway capability `importer.mapping` (L1-gw); the
extension is keyless. Input is the hostile, value-free `StructureDigestV1`, built on the device:

```text
StructureDigestV1 { digestVersion 2; round 1|2 (2 = union after explore); truncated {templates, linkTemplates, shapes};
  origins[] ≤ 9 { ref ("o0" = tab); scheme 'https'; hostTemplate (slot rule); port int|null (null = 443; an integer
                  field, outside the literal digit-run rule); contacted; credentialed (informational only) };
  templates[] ≤ 64 { ref; originRef; method GET|HEAD; template (ids :pN, words :sN); slots[]; queryKeys[] (names);
                     paginationSignals; statuses; role collection|single|refused; collectionPaths ≤ 4;
                     shape (keys, kinds, classes, buckets; depth ≤ 4; no values); discoveredBy landing|explore };
  linkTemplates[] ≤ 64; constantHeaderNames[]; nonGetDataOrigins int; missingFamilies[] (round 2) }
```

- **Never sent:** any value, id, name, email, phone, free text, cookie, bearer, query or header value,
  full URL, host label outside the slot rule, page or link text, DOM, or the slug.
- **Path rule:** a segment or host label stays literal only if every token (split on `-` `_` `.` and
  camel-case) is in `STRUCTURAL_PATH_VOCABULARY` or `MUTATING_VERB_VOCABULARY` (closed, versioned,
  vendor-neutral contract code, mirrored by fixture); otherwise it is a typed slot.
- **Key admission:** a key leaves the device only if (1) grammar holds (no whitespace, `@`, digit run
  ≥ 4, credential-like name), (2) its tokens equal no captured value of this run (device only), (3)
  every token is structural vocabulary or it recurs with the same kind in ≥ 2 siblings; else the
  object collapses. One `admitKey` fixture runs on device (1-3) and server (1, 3).
- Header **names** only; values, slots and origins are rebound on the device from this run's capture;
  an unbound slot emits zero requests (`slot_unbound`).
- **Bounds:** digest ≤ 32 KiB; **origins ≤ 9 = tab origin + the ≤ 8 outside origins a run may name**
  (a ninth outside origin is refused at capture, never enters the digest, so origins never truncate).
  Over-bound digests truncate deterministically (`digest_truncated`), round-1 material kept first.

### D-L0-3 `POST scout/runs/learn` and reuse

- Only on an open server run in `discovering`, before the first staged row. Template **identity** =
  `(origin: scheme + host template + port, method, slotted template)`; all matching is by identity.
- Under the run-row lock: an existing pin for `(coach, intent, round)` is returned unchanged → an
  `accepted` version for `(coach, slug)` covering every round-1 collection identity is pinned with no
  model call (its unseen steps become explore targets) → else one model call and a `candidate` pin;
  one repair; a second failure settles `failed/transfer_failed` + `learn_refused`, zero requests.
- **Round 2** matches only the round-1 pin. Round-1 identities carry forward; a union omitting or
  shrinking one **without** a truncation flag is `digest_not_union` (twice ⇒ `learn_refused`); a
  truncated union is never refused; a new collection ⇒ one call keeping every round-1 step present.
  The version at first `ingest` is frozen. A step absent this run is `template_absent`: zero requests.

### D-L0-4 Output grammar, validators, conformance

- `LearnedProposalV1`: ≤ 16 `steps` (templateRef, entityType, family, itemsPath, idField, idScope,
  parentEdge, timestampField, collectAs, forEach, pagination page|cursor|next_url|none),
  `mappingSpec`, `nativeRules|null`, `unmapped[]` (`out_of_scope_account_settings|
out_of_scope_ui_config|unknown`), `explore` ≤ 8, `rationale` ≤ 512. **No** origin, header, URL,
  method, code, slot value or destination: a FAM-0 family label only; `destinationFor` decides.
- **Validators before any request:** V-L0 digest (strict, bounds, vocabulary, admission, port
  1-65535); V-L1 strict JSON; V-L2 mapping spec; V-L3 native rules; V-L4 families from FAM-C1; V-L5
  step/template consistency and **no literal path segment or query-key name in
  `MUTATING_VERB_VOCABULARY`**; V-L6 paths resolve to admitted keys; V-L7 S10 manifest; V-L8 explore ⊆
  links; V-L9 ≤ 64 KiB; V-L10 each collection once in steps ∪ unmapped. Then `normalizeBlueprint`.
- **Conformance** (locked, write-once per epoch, before reconstruct): C0 identity per family (mismatch
  drops that family, `identity_conflict`); C1 families resolve; C2-C4 per record (named clients; native
  rules per row, not-ok ⇒ preserve; a child links iff its parent is a passing staged parent or a
  verified Person link of this coach on this platform); C5/C6 per EX1. Whole-family effects only when
  a check fails on every non-empty row.

### D-L0-5 Memory — per coach in V1

- Key `(coach_id, slug)`, slug = the tab origin's hostname (server-side, never prompted). Four
  additive coach-scoped tables (S10-B RLS): versions (`candidate|accepted|suspect|superseded|
invalidated`), write-once run pins, insert-only events, spend ledger. No value, digest, slot or
  header value or credential stored; no cross-coach row.
- `candidate` → `accepted` on structural acceptance (C0-C4 pass, ≥ 1 Person, no trigger; the verdict
  does not gate it); accepted versions serve the same coach and slug with zero calls, re-validated.
  One trigger ⇒ `suspect` (relearn v+1); two ⇒ `invalidated`. Triggers (closed, structural,
  server-computed): `template_absent` (link visited and issued data requests), `items_path_missing`,
  `id_field_missing`, `conformance_identity`, `native_rules_dropped`, `link_conformance`; sparsity,
  bad rows, auth loss, timeouts, cancels, restarts never trigger. One seam: `SourceRegistryProvider`.

### D-L0-6 Truthfulness

- Identity = `(platform, family, source_id)` from `idField`; model output reaches a write only through
  V-L2/V-L3 and C0-C6. **`complete` is unreachable until CL:** closure is `null`, so a run with
  usable results settles `partial/coverage_basis_unknown` + `completeness_not_proven`.
- **No usable result ⇒ `failed`:** a run with **zero usable native or preserved results** (Σ
  `moved_native` + `preserved` = 0) settles `failed/transfer_failed`, `failure_code:
no_usable_result` (master-prompt terminal definitions), implemented in L2d as the one permitted
  change to the arbiter's inputs. Cancel, deadline and block keep their status.
- **Counting (X2b, L3b):** `page` exhausts only on an empty page, `cursor`/`next_url` on an absent
  next; `none`, short pages, budget, cycle, error or refused pages never prove. `proven` iff every step
  is exhausted and ids equal the staged side; `observed` iff every step has a page and no
  error/budget/cycle stop (fan-out shortfall ⇒ `observed` + `list_not_exhausted`); else `unknown`.
- **Destinations (D4)** per FAM-0 (`destination_gate_closed` until viewable). **Media is deferred
  whole to FAM-M1:** no L0 slice fetches media bytes; L0 has no media mechanism and no media test.

### D-L0-6.2 Origins, credentials and the read-only bound

- **Origin = scheme + host + port.** X1 authorizes the tab origin only. A foreign origin is admissible
  iff `https` (any port) and FAM-0's partner-origin rule admits it; named `https://host[:port]` (443
  omitted); non-`https` page data origins are never replayed (`cross_origin_insecure`). **Cap: 8
  outside origins**; a ninth is never fetched (`outside_origin_refused`); the digest bound matches.
- **Credentials:** **I-C1** no cookie or credential-header value is ever persisted, logged, buffered,
  put in a digest, package, batch or evidence, sent to TGP or a model, or handed to a page script.
  **I-C2** only the browser attaches cookies; the jar is never read and `Cookie` never set. **I-C3**
  no widening: a foreign replay carries cookies only where the page's own request did, else none and
  the auth gap (tab origin keeps today's path; its in-origin over-send is stated). **I-C4** a
  non-cookie credential header goes only to the exact origin and frame context that carried it;
  subframe/worker headers and storage JWTs are never used. **I-C5** auth loss ⇒ ≤ 1 reload, then the
  auth gap; never a form. **I-C6** a restarted worker never resumes; it claims what is staged with
  `worker_restarted`. **I-C7** the extension holds only the S18 intent/run capability.
- **No-mutation bound.** `MUTATING_VERB_VOCABULARY` (closed, versioned: logout, login, auth, password,
  delete, remove, cancel, archive, create, update, set, mark, toggle, submit, confirm, read, seen,
  view, open, track, notify, action, operation, command, event, …; exact whole tokens, so `events`
  and `sets` do not hit). **It is checked against URL structure only — the template's literal path
  segments and query-key names — never query values, slot values, rebound values, response values
  or other coach data** (`?status=complete` and a client slug `mark-smith` pass).
  - **Replay:** GET/HEAD, no body, admitted origin, a learned template the page issued this run, query
    keys = an observed set ∪ the validated pagination param (or a same-origin same-identity
    `next_url`), no vocabulary hit (`mutating_template_refused`); each `(template, parent, page)` at
    most once, no retry after send; ≤ 2 concurrent per origin, ≥ 250 ms apart.
  - **Navigation** (explore, Start reload): same origin, an inventory link with no hit (else
    `navigation_refused`; a hitting Start URL ⇒ `start_page_refused`); never click, fill or submit.
  - **Residual** (hidden GET side effects, visited pages' own scripts) is observed by V1-P item 9.
- Other gaps: `cross_origin_*`, `tab_lost`; no replayable collection ⇒ `failed/no_collections_observed`.

**Tests T-01..T-16** (packaged MV3 extension in Chromium, fixture server, green on the owner's head;
a protocol probe discharges none). T-17 (media) moved to FAM-M1.

| Id   | Owner  | Fixture and assertion                                                                                                                |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| T-01 | X3     | Single-origin site: `origins=[o0]`, empty outside/excluded lists, records moved.                                                     |
| T-02 | X3     | HttpOnly sentinel cookie (tab + foreign) absent from every buffer, log, storage, message, argument, upload.                          |
| T-03 | X3     | Foreign origin called without cookies while the jar holds one: replay sends no `Cookie`; family moves.                               |
| T-04 | X3     | Mixed public/credentialed foreign pair + SameSite/partitioned variant: page's outcome or auth gap.                                   |
| T-05 | X3     | Tab origin served by the page's own service worker: replay succeeds.                                                                 |
| T-06 | X3     | Header set only by a subframe or page worker: never re-attached or handed on; auth gap.                                              |
| T-07 | X3     | Worker killed mid-crawl: no resume, nothing stored, `partial` + `worker_restarted`, no trigger.                                      |
| T-08 | X3     | Session invalidated mid-run: ≤ 1 reload, zero form fills, `source_auth_unavailable`, staged rows kept.                               |
| T-09 | X3     | `/logout`, `/items/:id/delete`, `/settings?action=unsubscribe` never visited; `/api/events` visited.                                 |
| T-10 | X2b/L1 | `/api/action?operation=cancel`, `?mark_read=1` refused; `?status=complete`, value `open`, slug `mark-smith` admitted.                |
| T-11 | X2b    | Unobserved validated `page` key and same-origin `next_url` admitted; cross-origin/hitting `next_url` refused.                        |
| T-12 | X2b    | Source drops the response after processing: exactly one request, `error` stop, `list_not_exhausted`.                                 |
| T-13 | X3     | `https://api.example.test:8443` captured (digest `port: 8443` passes V-L0), replayed, named so; `http://` ⇒ `cross_origin_insecure`. |
| T-14 | X3     | Nine outside origins: eight named, the ninth never fetched nor in the digest, `outside_origin_refused`.                              |
| T-15 | X3     | Excluded categories not captured, counted in `excluded_origins[]`; CORS-denied gap; closed tab `tab_lost`.                           |
| T-16 | X3     | Storage JWT never sent; bearer foreign API served by re-attachment to that exact origin only.                                        |

### D-L0-6.3 `RunStatusProjectionV1` — the one run-status projection (owned here)

`GET scout/import/status` adds (enums closed, append-only, `RUN_REASON_CODES` unchanged):

```text
families[]         { family; source_count int|null (null = unknown, never 0); count_basis proven|observed|unknown;
                     moved_native (bucket j + bucket i); preserved (j-p, once viewable); not_moved int|null }
not_moved[]        { family; count int|null; reason NotMovedReason }   -- counted facts
gaps[]             { family|null (null = run-level); code GapCode }     -- unknowns, never counts
outside_origins[]  ≤ 8 { origin ^https://[a-z0-9.-]+(:[0-9]{1,5})?$ (443 omitted); requests ≥ 1 }
excluded_origins[] { category ExcludedOriginCategory; count ≥ 1 }      -- never an origin string
failure_code?      FailureCode
NotMovedReason = excluded_by_policy | source_refused | unresolved_parent | identity_conflict | destination_gate_closed
               | over_limit | write_failed | cause_unknown
GapCode        = completeness_not_proven | list_not_exhausted | digest_truncated | navigation_unexplored
               | collection_unmapped | slot_unbound | template_absent | non_get_data_unobserved | cross_origin_unobserved
               | outside_origin_refused | cross_origin_cors_denied | cross_origin_auth_unavailable
               | cross_origin_csp_blocked | cross_origin_insecure | source_auth_unavailable | mutating_template_refused
               | navigation_refused | worker_restarted | residual_unknown | tab_lost
ExcludedOriginCategory = analytics | feature_flags | ads | error_reporting | identity_provider | payment_card_entry
FailureCode    = learn_unavailable | learn_refused | learning_budget_exhausted | no_collections_observed
               | origin_mismatch | extension_update_required | start_page_refused | no_usable_result
```

- A counted fact goes to `not_moved`, an unknown to `gaps`, never both; unknown is `null`. Under
  `proven`: `source_count = moved_native + preserved + not_moved`. `outside_origins` is the one string
  exception (D14): a device-attested X3 unit, server-checked for grammar, ≤ 8 and ≤ contacted origins.
- **L2d activates it** with a total placement table (an unplaced key fails the build); FAM-R1 extends it:

| Source at the L2d base                                                                                           | Placement                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------- |
| bucket j `native_present_verified`; bucket i `unresolved:native_target_removed`                                  | `moved_native`            |
| C0 family drop; bucket h; `native_uniqueness`; `rejected:missing_source_id`                                      | `identity_conflict`       |
| C2 row; bucket a `unresolved:<family>`; bucket f `unresolved:evidence_only`; native-rule row codes before FAM-P2 | `destination_gate_closed` |
| C4 row; `no_native_client_principal`; `relationship_pending`; `relationship_missing`                             | `unresolved_parent`       |
| bucket c `failed`; bucket g `unresolved:provenance_missing`; other `rejected:*`                                  | `write_failed`            |
| `unresolved:pass_ceiling_exceeded`                                                                               | `over_limit`              |
| refused fetches on known identities                                                                              | `source_refused`          |
| `unresolved:not_reconstructed`; `unresolved:reason_unrecognised`; bucket k                                       | `cause_unknown`           |

- Verdict fields come from the settled S9 report; family counts via this table, then FAM-R1's live
  recompute. X4 and R2 render only this projection (`failure_code` first, R1 copy).

### D-L0-7 The AI step

- **Prompt:** instruction parts (goal; live target structure from the validators' objects,
  `contractHash`; generated schema; ≤ 2 repository-fixture examples; rules), then the digest and at most
  one coach-derived example package, each in its own per-call-nonce block; no site- or coach-derived
  byte outside them. No tools, network or memory writes; `temperature: 0`; explicit `maxTokens`.
- **Limits** (env): 4 calls/run; 24k in / 4k out per call, 80k/run; 90 s/call; learn phase 600 s;
  24 explore visits × 8 s; run deadline 30 min (re-sized after 10 V1-P runs); 12 calls/coach/day;
  $20/day global (D3); kill switch. Budget ⇒ `learning_budget_exhausted`; else `learn_unavailable`.
- **Spend** reserved (maximum cost) in a committed ledger before every call; a failed settle leaves
  the maximum charged; remembered sites cost zero. **Model:** strongest configured with a passed eval
  record for the live tuple (L1e CI); fallback only if configured and recorded; no stub in production.
- **Failures** settle server-side through the CAS terminal as `failed/transfer_failed` +
  `failure_code`, zero source requests. `extension_update_required` = ingest refusal below
  `SCOUT_MIN_RULES_VERSION` (FAM-0).

### D-L0-8 V1 proof

**V1-P** (owner's account, pinned SHAs) records: (1) one gesture; (2) `learned` then `reused` with zero
calls from another landing page; (3) every family landed or disclosed, `outside_origins[]` complete,
visible counts checked; (4) `partial` + `completeness_not_proven`, package accepted; (5) forced
structural failure ⇒ `suspect` ⇒ v+1; (6) legacy-oracle parity; (7) eval record, L13, cost
provenance; (8) timings, T-01..T-16 on the pinned extension; (9) read/seen side effects, per-token
refusals. **V1-C** needs CL. **DEL** after (6) removes the legacy oracle and shrinks allowlists.

## 3. Slices and dependency graph

| Id     | Repo      | Tier | Scope                                                                                                                   | Deps                       |
| ------ | --------- | ---- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| L1-gw  | backend   | T4   | Fail-closed `importer.mapping` gateway, spend-ledger port, typed errors (PR #592)                                       | —                          |
| L1     | backend   | T4   | Pure learn library: contracts, vocabularies, `admitKey`, V-L0…V-L10, prompt, schema, fixtures (PR #591; conforms to r9) | L1-gw, FAM-C1              |
| L1e    | backend   | T4   | Eval harness + CI eval job                                                                                              | L1, L1-gw                  |
| L2a    | backend   | T4   | `SourceRegistryProvider.forRun` (merged, #588)                                                                          | —                          |
| L2b    | backend   | T4   | Memory tables, `runs/learn`, pins, per-coach match, ledger binding, deadline, learn-failure settle                      | L1, L1-gw, L2a             |
| L2c    | backend   | T4   | Conformance C0-C4, per-coach lifecycle and triggers                                                                     | L2b                        |
| L2d    | backend   | T4   | Projection activation, enums, placement table, `outside_origins` unit, `no_usable_result`, OpenAPI                      | L2c, L3b                   |
| L3a    | backend   | T4   | Reshape #589: no closure mechanism, short page observed, `observed` basis                                               | —                          |
| L3b    | backend   | T4   | Per-family evidence grammar + evaluator                                                                                 | L3a, L2b                   |
| S18    | both      | T4   | G3-AUTH intent/run-scoped revocable importer capability (I-C7)                                                          | X1                         |
| X0     | extension | T2   | Backend origin (D6)                                                                                                     | —                          |
| X2     | extension | T4   | Digest builder + compile; leak tests; mirrors L1 fixtures                                                               | X1, L1                     |
| X2b    | extension | T4   | Engine evidence; fetch router under I-C1..I-C6 and the no-mutation bound; T-10..T-12                                    | L1                         |
| X3     | extension | T4   | Server-mode learn path; picks its own browser mechanisms; T-01..T-09, T-13..T-16 gate it                                | X0, X2, X2b, L2b, L3b, L2d |
| X4     | extension | T2   | Popup result detail; one Start button                                                                                   | L2d                        |
| R2     | mobile    | T3   | Roman result detail                                                                                                     | L2d                        |
| FAM-\* | backend   | T4   | FAM-0 slices in FAM-0 order; FAM-C1 owns the catalogue module L1 imports                                                | FAM-0, L2a                 |
| EX1    | backend   | T4   | Exercise-reference resolution (PR #578)                                                                                 | S8-D3                      |
| V1-P   | all       | T4   | D-L0-8 items 1-9                                                                                                        | L1e, L2d, L3b, X3, X4, R2  |
| CL     | backend   | T4   | Completeness-closure record (§7)                                                                                        | V1-P readings              |
| L2g    | backend   | T4   | Cross-coach memory (§7)                                                                                                 | L2c, CL                    |
| DEL    | ext+back  | T3   | Delete the legacy oracle; shrink allowlists                                                                             | V1-P item 6                |

Graph: L2a → FAM-C1 → L1; L1-gw → L1 → {L1e, X2, X2b}; L1 + L2a → L2b → L2c; L3a + L2b → L3b; L2c +
L3b → L2d → {X3, X4, R2, FAM-R1}; X0 + X2 + X2b → X3; X1 → S18; V1-P → CL → L2g; V1-P(6) → DEL.

## 4. Invariants

- **INV-1** core diff = 0. **INV-2** AI returns data only (origins, methods, headers, destinations and
  completion never model output). **INV-3** values and credentials never leave the device. **INV-4**
  unknown is never zero. **INV-5** no false `complete` until CL. **INV-6** zero usable results ⇒
  `failed/no_usable_result`. **INV-7** coach-scoped memory; structural triggers; reuse re-validates.
- **INV-8** no positional ids; C0 per family. **INV-9** read-only and confined: learned GET/HEAD once
  per page; vocabulary on URL structure only; origin = scheme + host + port; ≤ 8 outside, named.
  **INV-10** one registry seam. **INV-11** hostile input stays data; spend reserved before every call.
  **INV-12** one projection, each fact once. **INV-13** destination derived. **INV-14** I-C7.

## 5. Acceptance cases (L-cases)

- **L01 (L1)** one refusal per V-L0…V-L10 (a `destination` field, an off-catalogue family, a mutating
  token in a literal segment or query key, port 0 or 70000); `port: 8443` admitted. **L02 (L1, X2)**
  identities ignore values, slots, kinds and buckets, include the port, match across two accounts of
  one site, byte-equal to the extension fixture. **L03 (X2)** fixture digests hold no value, id,
  email, name, header value, link text or slug; admission fixture identical on device and server.
- **L04 (X2)** learned legacy blueprint replays to the legacy identity set. **L05 (L2b, PG)** RLS,
  cross-coach invisibility, concurrent versions, caps under concurrency. **L06 (L2a)** `forRun` and
  `verifyPin` (merged). **L07 (L1, L1-gw)** memory hit ⇒ no call; each gateway failure ⇒ typed code,
  zero source requests, server terminal; ledger reserved per call.
- **L08 (L2b, L2c, PG)** acceptance; reuse from another landing page and a sparser account; sparse,
  key-growth and truncated cases never refuse; unflagged shrink refused; no cross-coach serving;
  trigger/non-trigger cases; C0 per family; C2-C4 incl. cross-platform Person negative; write-once pins.
- **L09 (X3, X2b)** packaged-harness end-to-end learn run plus T-01..T-16. **L10** V1-P items 1-9.
  **L11 (L1)** prompt structure = `describeCanonicalContract()`. **L12 (L1e)** no passed eval record
  ⇒ refuse and fail CI. **L13 (L1)** adversarial corpus; injected bytes only inside nonce blocks.
- **L14 (L2d)** enums disjoint; proven arithmetic; placement total; `completeness_not_proven` on every
  run; **zero usable results ⇒ `failed/no_usable_result`, one moved record ⇒ `partial`**; bad
  `outside_origins` units refused. **L15 (L3a, L3b)** first-page-only, short pages, bad fan-out,
  budget and refused pages never `proven`. **L16 (L2d, X4, R2)** codes only, R1 copy, `failure_code`
  first, `origin` verbatim with port.

## 6. Rejected

Run-closure machinery (closure objects, hidden-surface probes, `confirmExclusion`); model-proposed
destinations; exclude-by-default partner origins; billing as a gap; reading or re-injecting cookies;
persisting credentials; resuming after restart; retrying a sent request; replaying or visiting a
vocabulary-hitting URL, or applying the vocabulary to values; media in L0; untested browser claims; a
second catalogue; global memory in V1; free-text `error_summary`; synthetic ids; a second gesture; a new
phase or terminal status; DOM fallback; export ingestion; guess paths; value samples; storing digests,
slot/header values or credentials; stub fallbacks; `partial` with nothing usable; a full coach session
in the extension; per-site tokens or thresholds.

## 7. Deferred

- **CL — completeness closure** (own record; unblocks V1-C). Inputs: C-01 navigation ≠ record surface;
  C-02 SPA-only routes; C-03 first/short pages; C-04 file packages lack closure; C-05 durable,
  epoch-bound, never producer-asserted inputs; C-06 fan-out identity; C-07 exclusions need proof; C-08
  requests stay in D-L0-6.2; C-09 filter/status variants; C-10 partner collections; C-11 empty
  terminals; C-12 gaps reach the coach; C-13 residual-less records; C-14 one bucket order; C-15 one
  projection and destination authority; C-16 resumption.
- **L2g — cross-coach memory** (own record), minimum: quorum of ≥ 2 independently provisioned coaches
  on distinct account scopes; identical core digests; per-run re-validation, never serving a key the
  coach's digest lacks; one run marks `suspect` only; global rows hold only corroborated keys.
- Media (FAM-M1), D11, D13, cross-host reuse, multi-scope, export learning, vocabulary growth, non-GET.

## 8. Owner-reserved and release boundary

Nothing is owner-pending. Owner-reserved: deploy, flags, provider key, enablement, Web Store, `main`
merges. Green tests prove candidate behaviour only; V1-P also needs deploy approval, the provider key,
credential rotation before real client data, and FAM-0 approved.
