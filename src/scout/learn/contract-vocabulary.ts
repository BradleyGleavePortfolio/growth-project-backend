/**
 * L1 (docs/decisions/2026-09-27-learn-and-remember.md D-L0-2 a, D-L0-6.1 i-d) — the closed,
 * versioned, vendor-neutral vocabularies that are CONTRACT DATA, never per-site data:
 *
 * - `STRUCTURAL_PATH_VOCABULARY`: generic API and resource words. A path literal reaches the
 *   model and the memory only when EVERY token of the segment is listed here (positive proof (a))
 *   or the segment hashes to a proven slot hash (proof (b), `digest-contract.ts`). Anything else
 *   is a typed session slot `:sN` on the device.
 * - `STATUS_VARIANT_VOCABULARY` / `STATUS_VALUE_VOCABULARY`: the query key names and the probe
 *   values of the archived-discovery obligation (D-L0-6.1 i-d). Held here for L1b's closure rule
 *   and for the extension mirror; no code in this slice probes anything.
 *
 * A change here is a reviewed contract change: bump `VOCABULARY_VERSION`, the `contractHash`
 * (D-L0-7.1) moves with it, the extension mirror (`E:shared/learn/`, fixture
 * `test/fixtures/scout/learn/contract-vocabulary.json`) is re-copied, and the §3.1 metamorphic
 * test must still pass. No given name, host, vendor or product name may ever enter this list.
 */

import { CANONICAL_FAMILIES } from '../reconstruct/mapping-spec';

export const VOCABULARY_VERSION = 2 as const;

/** `v1`, `v2`, … `v999`: an API version marker is structural without being listed. */
export const VERSION_TOKEN_PATTERN = /^v[0-9]{1,3}$/;

const PATH_WORDS: readonly string[] = [
  // transport and API structure
  'api',
  'rest',
  'graphql',
  'proxy',
  'internal',
  'public',
  'private',
  'web',
  'app',
  'mobile',
  'admin',
  'auth',
  'me',
  'my',
  'current',
  'self',
  'search',
  'list',
  'lists',
  'detail',
  'details',
  'all',
  'items',
  'item',
  'data',
  'index',
  'export',
  'exports',
  'import',
  'imports',
  'batch',
  'bulk',
  'sync',
  'feed',
  'timeline',
  'summary',
  'summaries',
  'stats',
  'overview',
  'count',
  'counts',
  'total',
  'totals',
  'page',
  'pages',
  'new',
  'edit',
  'show',
  'view',
  'views',
  'recent',
  'upcoming',
  'past',
  'today',
  'week',
  'weeks',
  'day',
  'days',
  'month',
  'months',
  'year',
  'years',
  // people
  'user',
  'users',
  'profile',
  'profiles',
  'coach',
  'coaches',
  'trainer',
  'trainers',
  'client',
  'clients',
  'member',
  'members',
  'athlete',
  'athletes',
  'trainee',
  'trainees',
  'customer',
  'customers',
  'contact',
  'contacts',
  'person',
  'people',
  'team',
  'teams',
  'group',
  'groups',
  'roster',
  'rosters',
  'staff',
  'organization',
  'organizations',
  'org',
  'orgs',
  'company',
  'companies',
  'business',
  'gym',
  'gyms',
  'studio',
  'studios',
  'location',
  'locations',
  'tenant',
  'tenants',
  'workspace',
  'workspaces',
  // training records
  'workout',
  'workouts',
  'program',
  'programs',
  'plan',
  'plans',
  'exercise',
  'exercises',
  'movement',
  'movements',
  'routine',
  'routines',
  'template',
  'templates',
  'library',
  'libraries',
  'block',
  'blocks',
  'cycle',
  'cycles',
  'phase',
  'phases',
  'set',
  'sets',
  'reps',
  'weight',
  'weights',
  'log',
  'logs',
  'history',
  'histories',
  'activity',
  'activities',
  'event',
  'events',
  'calendar',
  'schedule',
  'schedules',
  'appointment',
  'appointments',
  'booking',
  'bookings',
  'session',
  'sessions',
  'video',
  'videos',
  'assigned',
  'assignments',
  'scheduled',
  'completed',
  'progress',
  'goal',
  'goals',
  'metric',
  'metrics',
  'measurement',
  'measurements',
  'body',
  'photo',
  'photos',
  'media',
  'file',
  'files',
  'attachment',
  'attachments',
  'document',
  'documents',
  'checkin',
  'checkins',
  'check',
  'ins',
  'in',
  'assessment',
  'assessments',
  'form',
  'forms',
  'questionnaire',
  'questionnaires',
  'survey',
  'surveys',
  'intake',
  'habit',
  'habits',
  'task',
  'tasks',
  'dashboard',
  'report',
  'reports',
  // communication
  'message',
  'messages',
  'conversation',
  'conversations',
  'thread',
  'threads',
  'chat',
  'chats',
  'comment',
  'comments',
  'note',
  'notes',
  'notification',
  'notifications',
  'announcement',
  'announcements',
  // nutrition
  'nutrition',
  'meal',
  'meals',
  'food',
  'foods',
  'recipe',
  'recipes',
  'macro',
  'macros',
  'diet',
  'diets',
  'supplement',
  'supplements',
  // commerce (D-L0-6.1 P tokens for out_of_scope_billing)
  'billing',
  'invoice',
  'invoices',
  'payment',
  'payments',
  'subscription',
  'subscriptions',
  'charge',
  'charges',
  'refund',
  'refunds',
  'payout',
  'payouts',
  'pricing',
  'product',
  'products',
  'package',
  'packages',
  'order',
  'orders',
  // account settings (D-L0-6.1 P tokens for out_of_scope_account_settings)
  'settings',
  'preferences',
  'security',
  'integrations',
  'webhooks',
  'account',
  'accounts',
  // ui configuration (D-L0-6.1 P tokens for out_of_scope_ui_config)
  'ui',
  'layout',
  'theme',
  'widget',
  'widgets',
  'columns',
  'saved',
  'filters',
  'filter',
  'onboarding',
  'tour',
  'feature',
  'flags',
  // taxonomy and state
  'tag',
  'tags',
  'category',
  'categories',
  'type',
  'types',
  'status',
  'state',
  'archive',
  'archived',
  'active',
  'inactive',
  'pending',
  'draft',
  'drafts',
  'deleted',
  'trash',
  'favorites',
  'starred',
  'pinned',
];

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorted, de-duplicated, lower-case: the canonical form the fixture mirrors byte for byte. */
export const STRUCTURAL_PATH_VOCABULARY: readonly string[] = Object.freeze(
  [...new Set(PATH_WORDS.map((w) => w.toLowerCase()))].sort(compareText),
);

/** D-L0-6.1 i-d: query key NAMES whose `distinct = 1` triggers the archived discovery probe. */
export const STATUS_VARIANT_VOCABULARY: readonly string[] = Object.freeze([
  'active',
  'archived',
  'filter',
  'inactive',
  'include_archived',
  'show',
  'state',
  'status',
  'view',
]);

/** D-L0-6.1 i-d: the closed probe VALUES (GET only, by the crawl; never sent to the model). */
export const STATUS_VALUE_VOCABULARY: readonly string[] = Object.freeze([
  'all',
  'archived',
  'inactive',
  'past',
  'true',
]);

/**
 * PAGINATION SIGNALS (r5 D-L0-2, R591-B-A2, r2 direction 4): the closed set of device-computed
 * booleans a template may carry in `paginationSignals`. Each is the PRESENCE of a class of
 * top-level response key, query key or header — never a key the site chose, never a value, never
 * a token. `single_response` and `total_equals_count` are the only POSITIVE proofs; every other
 * signal is evidence that more pages may exist.
 */
export const PAGINATION_SIGNALS = [
  'cursor_key',
  'has_more_key',
  'limit_param',
  'link_header',
  'next_link_key',
  'offset_param',
  'page_count_key',
  'page_param',
  'single_response',
  'token_named_key',
  'total_count_key',
  'total_equals_count',
] as const;
export type PaginationSignal = (typeof PAGINATION_SIGNALS)[number];
export const PAGINATION_SIGNAL_DESCRIPTIONS: Readonly<Record<PaginationSignal, string>> =
  Object.freeze({
    cursor_key: 'a top-level response key or query key named for a cursor exists',
    has_more_key: 'a top-level boolean key saying whether more rows exist',
    limit_param: 'a page-size query parameter was observed',
    link_header: 'a Link response header with a next relation was observed',
    next_link_key: 'a top-level response key holding the next page link or cursor exists',
    offset_param: 'an offset or skip query parameter was observed',
    page_count_key: 'a top-level key holding the number of pages exists',
    page_param: 'a page-number query parameter was observed',
    single_response:
      'exactly one response was observed for this template, with no query-key variants',
    token_named_key:
      'a key whose name contains token was observed; its name and value never leave the device',
    total_count_key: 'a top-level key holding a total row count exists',
    total_equals_count:
      'the total count key was present and equal to the number of rows in the response',
  });
/** A `none` claim needs `single_response` and none of these (r2 direction 4). */
export const MORE_PAGES_SIGNALS: readonly PaginationSignal[] = Object.freeze([
  'cursor_key',
  'has_more_key',
  'link_header',
  'next_link_key',
  'offset_param',
  'page_param',
  'token_named_key',
]);

/**
 * FAMILY LABELS (FAM-0 r2 D-FAM-1; r2 direction 2): the closed catalogue the model classifies a
 * collection into. `unclassified` is the catch-all for a reachable coaching collection the model
 * cannot name. The destination (native | preserve) is NEVER proposed: it is derived later from the
 * native writer registry. Every canonical mapping family is a label.
 */
export const FAMILY_LABELS = [
  'billing_history',
  'body_measurements',
  'body_weights',
  'checkins',
  'client_history',
  'client_profile',
  'clients',
  'coaching_sessions',
  'exercises',
  'food_logs',
  'form_responses',
  'forms',
  'goals',
  'habits',
  'meal_plans',
  'media',
  'messages',
  'notes',
  'nutrition_targets',
  'programs',
  'unclassified',
  'water_logs',
  'workout_assignments',
  'workout_logs',
  'workouts',
] as const;
export type FamilyLabel = (typeof FAMILY_LABELS)[number];
const FAMILY_LABEL_SET: ReadonlySet<string> = new Set(FAMILY_LABELS);
if (!CANONICAL_FAMILIES.every((f) => FAMILY_LABEL_SET.has(f))) {
  throw new Error('FAMILY_LABELS must contain every canonical mapping family');
}
export function isFamilyLabel(value: unknown): value is FamilyLabel {
  return typeof value === 'string' && FAMILY_LABEL_SET.has(value);
}

const VOCABULARY_SET: ReadonlySet<string> = new Set(STRUCTURAL_PATH_VOCABULARY);

/**
 * Tokens of a path segment or key: split on `-`, `_`, `.` and camel-case boundaries, lower-cased.
 * `check-ins` → [check, ins]; `savedFilters` → [saved, filters]; `v2` → [v2]. Empty tokens are
 * dropped; an empty result means the segment is nothing but separators (never structural).
 */
export function tokenize(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

export function isVocabularyToken(token: string): boolean {
  return VOCABULARY_SET.has(token) || VERSION_TOKEN_PATTERN.test(token);
}

/** Positive structural proof (a): every token of the segment is vocabulary or a version marker. */
export function isVocabularySegment(segment: string): boolean {
  const tokens = tokenize(segment);
  return tokens.length > 0 && tokens.every(isVocabularyToken);
}

/** The vocabulary as contract data for the extension mirror and the prompt (D-L0-7.1 part 2). */
export interface ContractVocabularyV1 {
  readonly vocabularyVersion: typeof VOCABULARY_VERSION;
  readonly versionTokenPattern: string;
  readonly structuralPathWords: readonly string[];
  readonly statusVariantKeys: readonly string[];
  readonly statusProbeValues: readonly string[];
  readonly paginationSignals: readonly string[];
  readonly familyLabels: readonly string[];
}

export function contractVocabulary(): ContractVocabularyV1 {
  return Object.freeze({
    vocabularyVersion: VOCABULARY_VERSION,
    versionTokenPattern: VERSION_TOKEN_PATTERN.source,
    structuralPathWords: STRUCTURAL_PATH_VOCABULARY,
    statusVariantKeys: STATUS_VARIANT_VOCABULARY,
    statusProbeValues: STATUS_VALUE_VOCABULARY,
    paginationSignals: PAGINATION_SIGNALS,
    familyLabels: FAMILY_LABELS,
  });
}
