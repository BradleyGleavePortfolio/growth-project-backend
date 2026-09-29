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

export const VOCABULARY_VERSION = 1 as const;

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
}

export function contractVocabulary(): ContractVocabularyV1 {
  return Object.freeze({
    vocabularyVersion: VOCABULARY_VERSION,
    versionTokenPattern: VERSION_TOKEN_PATTERN.source,
    structuralPathWords: STRUCTURAL_PATH_VOCABULARY,
    statusVariantKeys: STATUS_VARIANT_VOCABULARY,
    statusProbeValues: STATUS_VALUE_VOCABULARY,
  });
}
