import { z } from 'zod';

// PR-8 — Coach package CONTENTS authoring DTOs + zod schemas.
//
// We use a hybrid pattern:
//  - The HTTP body envelope is a plain object that the global Nest
//    ValidationPipe lets through (controller methods read it as `unknown`
//    and hand it to the service).
//  - The service feeds the full body to a discriminated-union zod schema
//    keyed on `cadence_kind`. zod gives us per-kind strict validation
//    (`.strict()` rejects unknown keys), which class-validator can't do
//    cleanly for a discriminated union with a Json payload column.
//
// The schemas below are the SINGLE SOURCE OF TRUTH for what shape the
// `CoachPackageContent.cadence_payload` JSON may carry. PR-9's fan-out
// reads these rows and snapshots them onto `ScheduledDrop.cadence_payload`
// verbatim, so any drift here would let a malformed cadence slip through
// to the drip executor.

// ── asset_type enum ──────────────────────────────────────────────────────
// Mirrors the canonical list in PR-3's schema (CoachPackageContent comment
// at prisma/schema.prisma:4657). PR-7 resolvers handle every type below.
export const ASSET_TYPES = [
  'workout_program',
  'workout_plan',
  'meal_plan',
  'pdf',
  'video',
  'auto_message',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

// ── cadence_kind enum + per-kind payload schemas ─────────────────────────
// Each `.strict()` rejects unknown keys with a clear zod error → 400 in
// the service. The discriminated union below is the entry point.

const ImmediatePayload = z.object({}).strict();

const RelativeToPurchasePayload = z
  .object({
    // Days from purchase_time. PR-9 will fire = purchase_time + offset_days
    // converted to seconds. v1 is days-only (per brief). 0 means "immediate
    // but go through the scheduled path"; integer ≥ 0.
    offset_days: z.number().int().min(0),
  })
  .strict();

const FixedCalendarPayload = z
  .object({
    // Absolute ISO 8601 datetime. PR-9's rule (per brief): if release_at is
    // already in the past at purchase time, the fan-out treats it as
    // immediate. We only validate the SHAPE here.
    release_at: z
      .string()
      .refine(
        (v) => !Number.isNaN(Date.parse(v)),
        'release_at must be an ISO 8601 datetime',
      ),
  })
  .strict();

const OnCompletionPayload = z
  .object({
    // Optional reference to which prior content row's completion triggers
    // this drop. PR-11 will wire the trigger.
    depends_on_content_id: z.string().min(1).optional(),
  })
  .strict();

const OnMilestonePayload = z
  .object({
    // Named milestone emit (PR-11 will define the well-known keys; for now
    // we only validate that a non-empty string is present).
    milestone_key: z.string().min(1),
  })
  .strict();

// Map of cadence_kind → its payload schema. Exported for the service AND
// for tests that want to assert one kind in isolation.
export const CADENCE_PAYLOAD_SCHEMAS = {
  immediate: ImmediatePayload,
  relative_to_purchase: RelativeToPurchasePayload,
  fixed_calendar: FixedCalendarPayload,
  on_completion: OnCompletionPayload,
  on_milestone: OnMilestonePayload,
} as const;

export type CadenceKind = keyof typeof CADENCE_PAYLOAD_SCHEMAS;
export const CADENCE_KINDS = Object.keys(
  CADENCE_PAYLOAD_SCHEMAS,
) as CadenceKind[];

// ── create body ──────────────────────────────────────────────────────────
// asset_type/asset_id + cadence + optional display_* + optional
// display_order. Strict — unknown fields rejected at every level.
//
// We build the create schema as a discriminated union ON `cadence_kind`,
// where each branch is a `.strict()` object carrying every field
// (asset_*, display_*, AND the cadence pair). zod's
// `discriminatedUnion` preserves the strictness of each branch, so an
// unknown top-level OR payload-level key is rejected by whichever
// branch matches.
const baseShape = {
  asset_type: z.enum(ASSET_TYPES),
  asset_id: z.string().min(1),
  asset_revision_id: z.string().min(1).nullable().optional(),
  display_order: z.number().int().min(0).optional(),
  display_title: z.string().max(200).nullable().optional(),
  display_caption: z.string().max(2000).nullable().optional(),
} as const;

export const CreateContentSchema = z.discriminatedUnion('cadence_kind', [
  z
    .object({
      ...baseShape,
      cadence_kind: z.literal('immediate'),
      cadence_payload: ImmediatePayload,
    })
    .strict(),
  z
    .object({
      ...baseShape,
      cadence_kind: z.literal('relative_to_purchase'),
      cadence_payload: RelativeToPurchasePayload,
    })
    .strict(),
  z
    .object({
      ...baseShape,
      cadence_kind: z.literal('fixed_calendar'),
      cadence_payload: FixedCalendarPayload,
    })
    .strict(),
  z
    .object({
      ...baseShape,
      cadence_kind: z.literal('on_completion'),
      cadence_payload: OnCompletionPayload,
    })
    .strict(),
  z
    .object({
      ...baseShape,
      cadence_kind: z.literal('on_milestone'),
      cadence_payload: OnMilestonePayload,
    })
    .strict(),
]);

export type CreateContentInput = z.infer<typeof CreateContentSchema>;

// ── patch body ───────────────────────────────────────────────────────────
// All fields optional. Cadence is all-or-nothing: if cadence_kind is
// provided, cadence_payload MUST be provided and match. We validate by
// special-casing in the service rather than expressing it in zod — partial
// discriminated unions are awkward.
export const PatchContentSchema = z
  .object({
    display_order: z.number().int().min(0).optional(),
    display_title: z.string().max(200).nullable().optional(),
    display_caption: z.string().max(2000).nullable().optional(),
    asset_revision_id: z.string().min(1).nullable().optional(),
    cadence_kind: z.enum(CADENCE_KINDS as [CadenceKind, ...CadenceKind[]]).optional(),
    cadence_payload: z.unknown().optional(),
  })
  .strict();

export type PatchContentInput = z.infer<typeof PatchContentSchema>;

// ── reorder body ─────────────────────────────────────────────────────────
// PUT .../contents/reorder takes an ordered list of contentIds. The service
// sets display_order = index for each. The list must contain every
// non-removed content_id for the package and no extras (the service
// enforces this; the schema just validates shape).
export const ReorderContentSchema = z
  .object({
    content_ids: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ReorderContentInput = z.infer<typeof ReorderContentSchema>;

// ── PR-17 B2 — push / backfill schemas ───────────────────────────────────
//
// These describe the two FROZEN endpoints the mobile M1 client already
// targets (PR17_EXPANSION_PLAN.md §2.1):
//   POST   v1/coach/packages/:id/contents/:contentId/push
//   GET    v1/coach/packages/:id/contents/:contentId/push/preview
//
// The service feeds the raw HTTP body through PushRequestSchema and the
// query string through PushPreviewQuerySchema, exactly like the PR-8
// authoring schemas above (zod in the service, raw `unknown` in the
// controller). `.strict()` rejects unknown keys with a clean 400.

// Audience scoping (#1). 'active' is the SAFE DEFAULT (Hick's Law) — the
// mobile confirm modal preselects it. 'cohort' requires an explicit
// purchase-id list (re-filtered by package_id in the service for IDOR).
export const PUSH_AUDIENCES = ['all', 'active', 'cohort'] as const;
export type PushAudience = (typeof PUSH_AUDIENCES)[number];

// Mode (#5). 'push_existing' backfills the missing first delivery for a
// pair (push_seq=0); 'resend' issues a FRESH delivery of an already-
// shipped pair (push_seq=max+1, resolver-key bypass).
export const PUSH_MODES = ['push_existing', 'resend'] as const;
export type PushMode = (typeof PUSH_MODES)[number];

// POST body. `cohort_purchase_ids` is required iff audience==='cohort'
// (enforced via superRefine so the discriminant stays a flat object the
// way the mobile client serialises it). `fire_at` is validated to parse
// as ISO 8601 here; the today-or-later guard is re-checked server-side in
// the service (#2/#6 defense-in-depth). `notify` defaults to true (#9).
export const PushRequestSchema = z
  .object({
    audience: z.enum(PUSH_AUDIENCES),
    cohort_purchase_ids: z.array(z.string().min(1)).optional(),
    fire_at: z
      .string()
      .refine(
        (v) => !Number.isNaN(Date.parse(v)),
        'fire_at must be an ISO 8601 datetime',
      ),
    mode: z.enum(PUSH_MODES),
    notify: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.audience === 'cohort') {
      if (!val.cohort_purchase_ids || val.cohort_purchase_ids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cohort_purchase_ids'],
          message:
            'cohort_purchase_ids is required and non-empty when audience is cohort',
        });
      }
    } else if (val.cohort_purchase_ids != null) {
      // Reject a stray cohort list on a non-cohort push so a client bug
      // can't silently narrow the audience.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cohort_purchase_ids'],
        message: 'cohort_purchase_ids is only valid when audience is cohort',
      });
    }
  });

export type PushRequestInput = z.infer<typeof PushRequestSchema>;

// GET .../push/preview?audience=&mode= — pure read. Only the discriminant
// fields are needed to compute the buyer count for the confirm modal.
export const PushPreviewQuerySchema = z
  .object({
    audience: z.enum(PUSH_AUDIENCES),
    mode: z.enum(PUSH_MODES),
    // Optional cohort list so the preview count matches the eventual push
    // for a cohort audience. Same IDOR re-filter applies in the service.
    cohort_purchase_ids: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type PushPreviewQueryInput = z.infer<typeof PushPreviewQuerySchema>;
