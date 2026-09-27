import { FEATURE_GATED_ROUTES, type FeatureGatedRoute } from './feature-flag-not-found.middleware';

/**
 * S12-B1 pilot-coach allowlist (pure helpers; the guard lives next door in
 * pilot-coach-allowlist.guard.ts).
 *
 * Problem (S12 readiness finding B1): the importer feature flags are GLOBAL.
 * Turning FEATURE_SCOUT_INGEST / FEATURE_SCOUT_RECONSTRUCT /
 * FEATURE_EXTENSION_PAIRING on in production would light the importer for
 * every coach. The pilot needs "exactly the named coach(es)".
 *
 * Contract:
 *  - FEATURE_SCOUT_PILOT_COACH_IDS is a comma-separated list of `User.id`
 *    UUIDs (the same id every S8/S10 write is keyed by via `req.user.id`).
 *  - FAIL CLOSED. Absent, empty, or malformed ⇒ the list is EMPTY and nobody
 *    is admitted to the gated surface, even with every flag on. There is no
 *    "allow all" spelling: `*`, `true`, e-mails, wrong separators, brace or
 *    quote-wrapped ids, truncated or un-hyphenated ids are all junk, and ONE
 *    junk entry empties the WHOLE list (a typo can only shrink the audience).
 *  - Read at call time (memoised on the raw string) so ops can edit the list
 *    without a restart, exactly like the flags themselves.
 *  - A malformed value produces ONE warning per distinct raw value naming
 *    entry POSITIONS only — never the entry text, so a mis-pasted secret is
 *    not echoed into logs.
 *  - Gated surface = the R-DARK-1 registry (FEATURE_GATED_ROUTES). One
 *    registry ⇒ one invariant: flag-gated ≡ pilot-gated. Any future importer
 *    route outside `/api/scout` or `/api/extension/pair` must add a registry
 *    row to inherit BOTH gates (S8-D unlink / person-link routes, D5).
 */

export const PILOT_COACH_ALLOWLIST_ENV = 'FEATURE_SCOUT_PILOT_COACH_IDS';

/** Global prefix from main.ts (`app.setGlobalPrefix('api')`); the registry
 * patterns are written against it, so the controller-path belt below must
 * prepend the same prefix. */
const GLOBAL_API_PREFIX = '/api';

/** Canonical hyphenated UUID (8-4-4-4-12 hex). Version/variant nibbles are
 * not enforced: Prisma `@default(uuid())` mints v4, but a stricter pattern
 * would only ever reject a real id, never admit a fake one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PilotCoachAllowlist {
  /** Lower-cased, de-duplicated ids. EMPTY whenever any entry was rejected. */
  readonly ids: ReadonlySet<string>;
  /** 1-based positions (among trimmed, non-empty entries) that failed the
   * UUID check. Non-empty ⇒ `ids` is empty. */
  readonly rejectedPositions: readonly number[];
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Pure, never throws. See the file header for the contract. */
export function parsePilotCoachAllowlist(raw: string | undefined): PilotCoachAllowlist {
  const entries = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const ids = new Set<string>();
  const rejectedPositions: number[] = [];
  entries.forEach((entry, index) => {
    if (UUID_RE.test(entry)) {
      ids.add(entry.toLowerCase());
    } else {
      rejectedPositions.push(index + 1);
    }
  });
  if (rejectedPositions.length > 0) {
    return { ids: EMPTY_IDS, rejectedPositions };
  }
  return { ids, rejectedPositions: [] };
}

export type AllowlistWarnSink = (message: string) => void;

let memo: { raw: string | undefined; list: PilotCoachAllowlist } | undefined;
const warnedRawValues = new Set<string>();

/**
 * Reads FEATURE_SCOUT_PILOT_COACH_IDS from the environment at call time and
 * returns the parsed list. Memoised on the raw string, so a changed value is
 * honoured on the next call without a restart. When `warn` is given and the
 * value is malformed, warns ONCE per distinct raw value (positions only).
 */
export function resolvePilotCoachAllowlist(warn?: AllowlistWarnSink): PilotCoachAllowlist {
  const raw = process.env.FEATURE_SCOUT_PILOT_COACH_IDS;
  if (!memo || memo.raw !== raw) {
    memo = { raw, list: parsePilotCoachAllowlist(raw) };
  }
  const { list } = memo;
  if (warn && raw !== undefined && list.rejectedPositions.length > 0 && !warnedRawValues.has(raw)) {
    warnedRawValues.add(raw);
    warn(
      `${PILOT_COACH_ALLOWLIST_ENV} ignored: entry position(s) ${list.rejectedPositions.join(
        ', ',
      )} are not UUIDs. The pilot allowlist is treated as EMPTY (no coach is admitted).`,
    );
  }
  return list;
}

function prefixMatches(path: string, pattern: string): boolean {
  return path === pattern || path.startsWith(pattern + '/');
}

/**
 * Registry rows whose pattern prefixes `path` (segment-wise, case-folded so
 * `/API/Scout/ingest` is gated and `/api/scouting` is not). Mirrors the
 * middleware's matcher; both fold to lower case.
 */
export function matchedGatedRoutes(path: unknown): readonly FeatureGatedRoute[] {
  if (typeof path !== 'string' || path.length === 0) return [];
  const folded = path.toLowerCase();
  return FEATURE_GATED_ROUTES.filter((route) => prefixMatches(folded, route.pattern.toLowerCase()));
}

/**
 * URL-independent second signal: the `@Controller(path)` metadata of the
 * handler's class (string or string[]), resolved under the global prefix.
 * Lets the guard stay closed even if `req.path` were ever missing or odd.
 */
export function matchedGatedRoutesForController(
  controllerPath: unknown,
): readonly FeatureGatedRoute[] {
  const paths: unknown[] = Array.isArray(controllerPath) ? controllerPath : [controllerPath];
  const out = new Set<FeatureGatedRoute>();
  for (const candidate of paths) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.replace(/^\/+/, '').replace(/\/+$/, '');
    const full = trimmed.length > 0 ? `${GLOBAL_API_PREFIX}/${trimmed}` : GLOBAL_API_PREFIX;
    for (const route of matchedGatedRoutes(full)) out.add(route);
  }
  return Array.from(out);
}

/** Union of both signals, de-duplicated by registry row identity. */
export function unionGatedRoutes(
  ...groups: readonly (readonly FeatureGatedRoute[])[]
): readonly FeatureGatedRoute[] {
  const out = new Set<FeatureGatedRoute>();
  for (const group of groups) for (const route of group) out.add(route);
  return Array.from(out);
}

/** True when ANY matched row's flag is not literally 'true' (read at call
 * time, the same rule as the R-DARK-1 middleware). Empty ⇒ not dark. */
export function isFlagDark(routes: readonly FeatureGatedRoute[]): boolean {
  return routes.some((route) => process.env[route.envVar] !== 'true');
}
