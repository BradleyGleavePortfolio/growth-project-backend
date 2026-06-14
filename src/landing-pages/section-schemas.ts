/**
 * Zod schemas for CoachLandingPageSection payload validation.
 *
 * Each section kind has a locked payload shape (spec §6). The service layer
 * validates inbound payloads against these schemas before writing to the DB.
 * Rejected payloads → 400 with Zod's formatted error.
 *
 * Kept in a dedicated file so tests can import the schemas without booting NestJS.
 */

import { z } from 'zod';

// ─── Shared primitives ───────────────────────────────────────────────────────

const httpUrl = z
  .string()
  .url()
  .refine((s) => s.startsWith('http://') || s.startsWith('https://'), {
    message: 'URL must be http or https',
  });

// ─── Per-kind schemas ────────────────────────────────────────────────────────

/**
 * hero — page header with image + copy.
 * The hero_image_url should be an S3 object key or HTTPS URL (EXIF-stripped
 * by MediaService before it gets here).
 */
export const HeroPayloadSchema = z.object({
  headline: z.string().min(1).max(120),
  subheadline: z.string().max(280).optional(),
  hero_image_url: httpUrl,
  accent_color: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .optional(),
});

/**
 * before_after — social proof photo pairs with date labels.
 * Max 6 pairs per spec §6.
 */
export const BeforeAfterPayloadSchema = z.object({
  pairs: z
    .array(
      z.object({
        before_url: httpUrl,
        after_url: httpUrl,
        date_label: z.string().min(1).max(80),
        caption: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(6),
});

/**
 * testimonials — named social proof with result metric.
 * Max 8 items per spec §6.
 */
export const TestimonialsPayloadSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        photo_url: httpUrl.optional(),
        quote: z.string().min(1).max(500),
        result_metric: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(8),
});

/**
 * pricing — CoachPackage references.
 * Max 3 packages; only one may be highlighted.
 * package_ids are validated against the DB in the service layer.
 */
export const PricingPayloadSchema = z
  .object({
    package_ids: z.array(z.string().cuid()).min(1).max(3),
    highlighted_id: z.string().cuid().optional(),
  })
  .refine(
    (data) =>
      !data.highlighted_id || data.package_ids.includes(data.highlighted_id),
    { message: 'highlighted_id must be one of the package_ids' },
  );

/**
 * faq — accordion Q&A.
 * Max 5 items per spec §6.
 */
export const FaqPayloadSchema = z.object({
  items: z
    .array(
      z.object({
        question: z.string().min(1).max(200),
        answer: z.string().min(1).max(800),
      }),
    )
    .min(1)
    .max(5),
});

/**
 * lead_form — configurable capture form.
 * email is always required per spec §6.
 */
export const LeadFormPayloadSchema = z
  .object({
    fields: z
      .array(z.enum(['name', 'email', 'phone', 'goal']))
      .min(1)
      .refine((f) => f.includes('email'), {
        message: 'email field is always required',
      }),
    cta_label: z.string().min(1).max(40),
  });

/**
 * offer_stack — bullet list of what's included.
 * Max 8 items per spec §6.
 */
export const OfferStackPayloadSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        value_line: z.string().min(1).max(200),
        value_dollars: z.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(8),
});

/**
 * guarantee — trust-builder.
 */
export const GuaranteePayloadSchema = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
  days: z.number().int().positive().max(365).optional(),
});

// ─── R52 renderer-v2 — three persuasion-arc kinds ────────────────────────────

/**
 * problem_solution — split layout showing "what's broken" beside "what
 * changes" after working with the coach. The doctrine doc's arc step 2
 * (problem acknowledgment) collapses with step 3 (mechanism reveal) into
 * a single 2-column block on the page so a visitor can compare states
 * side-by-side without scrolling between sections.
 */
export const ProblemSolutionPayloadSchema = z.object({
  problem_title: z.string().min(1).max(120),
  problem_body: z.string().min(1).max(500),
  solution_title: z.string().min(1).max(120),
  solution_body: z.string().min(1).max(500),
});

/**
 * mechanism — 3-step "how it works" block.  Each step has a small icon
 * key (mapped to a Lucide-style inline SVG in the renderer; free-text
 * icon names are accepted but unknown values fall back to a neutral dot),
 * a title, and a one-line body. Three steps total — Miller's three rule.
 */
export const MechanismPayloadSchema = z.object({
  steps: z
    .array(
      z.object({
        icon: z.string().min(1).max(40).optional(),
        title: z.string().min(1).max(60),
        body: z.string().min(1).max(200),
      }),
    )
    .min(3)
    .max(3),
});

/**
 * trust — credentials + numeric proof grid.
 * `numbers` is a small set of headline metrics (years coaching, clients,
 * etc.); `credentials` is a free-form list of accreditations / press
 * mentions. Either list may be empty as long as one of them has content.
 */
export const TrustPayloadSchema = z
  .object({
    numbers: z
      .array(
        z.object({
          value: z.string().min(1).max(20),
          label: z.string().min(1).max(40),
        }),
      )
      .max(4)
      .default([]),
    credentials: z
      .array(z.string().min(1).max(120))
      .max(8)
      .default([]),
  })
  .refine(
    (d) => d.numbers.length + d.credentials.length > 0,
    { message: 'trust section needs at least one number or credential' },
  );

// ─── Dispatch map ────────────────────────────────────────────────────────────

export type SectionKind =
  | 'hero'
  | 'before_after'
  | 'testimonials'
  | 'pricing'
  | 'faq'
  | 'lead_form'
  | 'offer_stack'
  | 'guarantee'
  | 'problem_solution'
  | 'mechanism'
  | 'trust';

export const SECTION_SCHEMAS: Record<SectionKind, z.ZodTypeAny> = {
  hero: HeroPayloadSchema,
  before_after: BeforeAfterPayloadSchema,
  testimonials: TestimonialsPayloadSchema,
  pricing: PricingPayloadSchema,
  faq: FaqPayloadSchema,
  lead_form: LeadFormPayloadSchema,
  offer_stack: OfferStackPayloadSchema,
  guarantee: GuaranteePayloadSchema,
  problem_solution: ProblemSolutionPayloadSchema,
  mechanism: MechanismPayloadSchema,
  trust: TrustPayloadSchema,
};

/**
 * Validate a section payload against its kind-specific schema.
 * Returns `{ ok: true, data }` or `{ ok: false, message }`.
 */
export function validateSectionPayload(
  kind: string,
  payload: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  const schema = SECTION_SCHEMAS[kind as SectionKind];
  if (!schema) {
    return { ok: false, message: `Unknown section kind: ${kind}` };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    const msg = result.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    return { ok: false, message: msg };
  }
  return { ok: true, data: result.data };
}
