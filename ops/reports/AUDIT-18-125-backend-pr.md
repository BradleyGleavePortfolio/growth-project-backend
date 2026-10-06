Tier: T2
Why: Restores the catalog's existing browser request contract and common lift lookup without changing authorization or persistence.
T4 trigger scan: none; playback authorization, roles, tenant scope, signing, and writes are unchanged.
T3 trigger scan: none; existing read DTO/service only.
Bounded T1: NO — query validation and identifier/search semantics need a targeted behavioral proof.
Canonical builder: GPT-6.1 Sol
Parent owner: operator agent 125
Acceptance evidence: exercise-catalog.launch.spec.ts runs the production ValidationPipe on `limit=20`, preserves page-size validation, and pins common lift words and seed source-reference lookups; existing catalog service/controller specs remain applicable.
Promotion triggers: any playback authorization, paid-media, or lesson tenancy change must go to T4.

## Launch defects
- B1: An ordinary client opens Exercise Library and `limit=20` arrives as a string that fails `@IsInt`, so every browser request errors; explicitly transform the numeric query parameter.
- U1: A client searches normal `push-up`, `pullup`, `RDL`, or `OHP` names and gets empty results for curated lifts; match ordinary name words and common abbreviations.
- U4: A client taps assigned exercise info using a `seed:` source ID and the catalog checks only UUID/slug; resolve the existing `source_ref` as another read identifier.

## Boundaries
- Companion mobile fix omits the optional limit, so the 10-07 build also works before this backend change is deployed.
- No overlap with open #427/#428 (flag-off custom exercise authoring).
- No authorization, secret, schema, migration, dependency, lockfile, or production change.
