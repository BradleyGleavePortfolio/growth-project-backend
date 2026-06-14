import { CommunitySearchKind } from '@prisma/client';
import { z } from 'zod';

/**
 * v3-4 community-search DTOs (Zod-first, mirroring the voice + classroom slices).
 *
 * The query string arrives untyped; the schema range-checks every field and
 * `.strict()` REJECTS unknown keys (50-Failures #8 — no silent fail-open
 * default). The response is validated on the way out so a future repository
 * change can never leak an unexpected shape (e.g. a body field) to the client.
 */

/** Max search-term length (brief §thresholds). */
export const SEARCH_QUERY_MAX_LEN = 200;
/** Default page size; overridable up to SEARCH_PAGE_SIZE_MAX (brief). */
export const SEARCH_PAGE_SIZE_DEFAULT = 20;
export const SEARCH_PAGE_SIZE_MAX = 50;
/** Server-side query timeout (brief §thresholds). */
export const SEARCH_QUERY_TIMEOUT_MS = 5_000;

/** Resolve the configured page size, clamped to [1, SEARCH_PAGE_SIZE_MAX]. */
export function resolveConfiguredPageSize(): number {
  const raw = Number(process.env.COMMUNITY_SEARCH_PAGE_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return SEARCH_PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(raw), SEARCH_PAGE_SIZE_MAX);
}

const KindEnum = z.enum(CommunitySearchKind);

export const SearchQuerySchema = z
  .object({
    // The user-entered term. Trimmed; empty after trim is a 400 (no
    // unbounded "match everything" scan).
    q: z
      .string()
      .trim()
      .min(1, 'q must not be empty')
      .max(SEARCH_QUERY_MAX_LEN, `q must be <= ${SEARCH_QUERY_MAX_LEN} chars`),
    // Optional kind filter — restrict to one object family.
    kind: KindEnum.optional(),
    // Optional cohort filter — restrict to a single cohort the caller can see.
    cohortId: z.guid({ message: 'cohortId must be a UUID' }).optional(),
    // Cursor pagination: opaque createdAt|id cursor from the previous page.
    cursor: z.string().max(200).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SEARCH_PAGE_SIZE_MAX)
      .optional(),
  })
  .strict();

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/**
 * A single search hit. Carries ONLY ids / kind / a PII-stripped, body-free
 * excerpt / timestamps — NEVER a post body, DM body, transcript body, or any
 * wearable metric value (brief §audit guarantees; PREFLIGHT §8).
 */
export const SearchResultRowSchema = z
  .object({
    id: z.string(),
    kind: KindEnum,
    targetId: z.string(),
    cohortId: z.string().nullable(),
    authorId: z.string().nullable(),
    excerpt: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type SearchResultRow = z.infer<typeof SearchResultRowSchema>;

export const SearchResponseSchema = z
  .object({
    version: z.literal(1),
    query: z.string(),
    results: z.array(SearchResultRowSchema),
    nextCursor: z.string().nullable(),
    tookMs: z.number(),
  })
  .strict();

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Admin reindex body — re-build (or refresh) the search row for a single
 * target from explicitly-allowlisted, body-free metadata. Idempotent at the
 * DB layer via @@unique([workspaceId, kind, targetId]). The caller supplies
 * ONLY title / tags / an optional consent transcript / cohort + author ids —
 * never a body. `remove: true` soft-deletes the row instead of rebuilding it.
 */
export const ReindexTargetSchema = z
  .object({
    kind: KindEnum,
    targetId: z.guid({ message: 'targetId must be a UUID' }),
    cohortId: z.guid({ message: 'cohortId must be a UUID' }).nullish(),
    authorId: z.guid({ message: 'authorId must be a UUID' }).nullish(),
    title: z.string().max(500).nullish(),
    tags: z.array(z.string().max(120)).max(50).optional(),
    transcript: z.string().max(20_000).nullish(),
    remove: z.boolean().optional(),
  })
  .strict();

export type ReindexTarget = z.infer<typeof ReindexTargetSchema>;
