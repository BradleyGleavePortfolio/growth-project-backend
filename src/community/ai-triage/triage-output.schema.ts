import { z } from 'zod';

// v2-4 — locked output contract for the community AI inbox triage surface.
//
// The triage service sorts a coach's UNANSWERED community inbox (the same
// unanswered client messages + posts the v1-6 CommunityCoachInboxService
// surfaces) into exactly five categories. The model only ever CLASSIFIES and
// SUMMARISES existing items; it never authors a reply and never writes. Each
// summarised item carries the source message/post id it was derived from so a
// coach can jump straight to the underlying thread and verify the read.
//
// Design rules baked into this contract:
//   - Five categories, fixed vocabulary, no sixth (TRIAGE_CATEGORIES).
//   - Every summarised item cites its source id (source_item_id) and source
//     kind (message | post) — provenance is mandatory, never optional.
//   - .strict() everywhere: a model response that smuggles an unexpected key
//     (prompt-injection, or a drifted field) is a hard validation failure,
//     not silently accepted-and-stripped.
//   - Category copy is professional and calm; the `urgent` framing is for
//     coach prioritisation, never an alarmist or medical claim (renderer +
//     guardrails enforce tone too).

// The five triage categories, in priority order. This is the single source of
// truth; the controller, prompt builder, tests, and mobile mirror all key off
// this list. There is intentionally no sixth bucket.
export const TRIAGE_CATEGORIES = [
  'urgent',
  'win_to_celebrate',
  'form_check',
  'general',
  'no_action_needed',
] as const;

export const TriageCategorySchema = z.enum(TRIAGE_CATEGORIES);
export type TriageCategory = z.infer<typeof TriageCategorySchema>;

// The two kinds of inbox item the triage operates over (mirrors the v1-6
// inbox `type` discriminator). Posts and messages are summarised the same
// way; the kind is preserved so the coach UI can build the correct deep link.
export const TRIAGE_SOURCE_KINDS = ['message', 'post'] as const;
export const TriageSourceKindSchema = z.enum(TRIAGE_SOURCE_KINDS);
export type TriageSourceKind = z.infer<typeof TriageSourceKindSchema>;

// A single triaged inbox item. `summary` is a short, neutral one-liner the
// model produced FROM the item's existing text — it is a reading aid, never a
// drafted reply. `source_item_id` is the id of the CommunityMessage /
// CommunityPost the summary was derived from (mandatory provenance).
export const TriageItemSchema = z
  .object({
    source_item_id: z.string().uuid(),
    source_kind: TriageSourceKindSchema,
    category: TriageCategorySchema,
    summary: z.string().min(1).max(280),
  })
  .strict();
export type TriageItem = z.infer<typeof TriageItemSchema>;

// One category bucket: the category label plus the items the model placed in
// it. A bucket may be empty (length 0) — an honest "nothing here" rather than
// an omitted key, so the renderer can show a calm per-category empty state.
export const TriageBucketSchema = z
  .object({
    category: TriageCategorySchema,
    items: z.array(TriageItemSchema),
  })
  .strict();
export type TriageBucket = z.infer<typeof TriageBucketSchema>;

// The model's raw classification output, validated before any projection.
// We require EXACTLY the five buckets (one per category) so the wire shape is
// stable regardless of which categories ended up populated.
export const TriageModelOutputSchema = z
  .object({
    buckets: z.array(TriageBucketSchema).length(TRIAGE_CATEGORIES.length),
  })
  .strict();
export type TriageModelOutput = z.infer<typeof TriageModelOutputSchema>;

// ── Wire response ──────────────────────────────────────────────────────
// `generated_at` is an ISO-8601 datetime. `source_item_ids` is the flat,
// de-duped list of every id the triage covered — a fast invariant the
// controller + tests assert provenance against. `is_empty` marks the typed
// "nothing to triage / degraded" state (see emptyTriage()) so a renderer
// never has to infer emptiness from a zero-length buckets array.
export const TriageResponseSchema = z
  .object({
    generated_at: z.string().datetime(),
    is_empty: z.boolean(),
    buckets: z.array(TriageBucketSchema).length(TRIAGE_CATEGORIES.length),
    source_item_ids: z.array(z.string().uuid()),
  })
  .strict();
export type TriageResponse = z.infer<typeof TriageResponseSchema>;

// Disabled-state body returned when FEATURE_COMMUNITY_AI_TRIAGE is off and
// the route is reached via the always-reachable summary handler. Distinct
// from the 404 kill-switch on the generation route — this lets a client that
// asks "is triage available?" get a typed, non-error answer.
export const TriageDisabledSchema = z
  .object({
    feature_flag_state: z.literal('disabled'),
    code: z.literal('community.ai_triage.disabled'),
  })
  .strict();
export type TriageDisabled = z.infer<typeof TriageDisabledSchema>;

// Build an ordered, fully-empty set of buckets (one per category, in priority
// order). Used as the skeleton the service fills, and as the empty-state body.
export function emptyBuckets(): TriageBucket[] {
  return TRIAGE_CATEGORIES.map((category) => ({ category, items: [] }));
}

// The typed empty/degraded triage. Returned when there is nothing unanswered
// to triage, or when the LLM path failed and there is no usable cache — an
// explicit, honest "no triage" rather than a fabricated "all clear" reading.
export function emptyTriage(generatedAt: Date): TriageResponse {
  return {
    generated_at: generatedAt.toISOString(),
    is_empty: true,
    buckets: emptyBuckets(),
    source_item_ids: [],
  };
}
