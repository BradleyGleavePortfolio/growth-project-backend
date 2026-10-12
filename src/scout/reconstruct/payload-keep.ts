import { Prisma } from '@prisma/client';
import type { FieldRule, SourceMappingSpec } from './mapping-spec';
import type { NativeRule, NativeRuleSet, Paths } from './native/native-rules';

/**
 * PRIV-04 — data minimization at ingest. A staged payload is only ever read
 * through the declared paths of its platform's mapping spec and native rule set,
 * so it is cut to exactly those paths before persistence: other platforms'
 * client emails, phones, notes, raw HTML and anything undeclared are never
 * stored. A platform with no spec keeps nothing (it is `unsupported_platform`).
 *
 * The cut is read-equivalent: a scalar is kept as is; an object or array at a
 * value path becomes `{}` / `[]` (still unusable, still not nullish, so path
 * fallback is unchanged); a `count` path keeps the array length only; the
 * exercises path keeps each item cut to the item rules.
 */
type Shape = 'value' | 'count' | 'items';
interface KeepPath {
  readonly path: readonly string[];
  readonly shape: Shape;
  readonly item: readonly KeepPath[];
}

/** `source_platform` → the paths its payload may keep. */
export type PayloadKeepPlan = ReadonlyMap<string, readonly KeepPath[]>;
type JsonOut = Prisma.InputJsonValue | null;
type JsonObjectOut = Record<string, JsonOut>;

const SHAPE_ORDER: Readonly<Record<Shape, number>> = { value: 0, count: 1, items: 2 };
const keep = (paths: Paths, shape: Shape, item: readonly KeepPath[] = []): KeepPath[] =>
  paths.map((path) => ({ path, shape, item }));
const nativeKeeps = (rules: Readonly<Record<string, NativeRule | undefined>>): KeepPath[] =>
  Object.values(rules).flatMap((r) =>
    r === undefined ? [] : keep(r.paths, r.kind === 'count' ? 'count' : 'value'),
  );
/** Wider shapes last, so an `items` or `count` keep wins over a `value` keep on one path. */
const ordered = (keeps: KeepPath[]): KeepPath[] =>
  keeps.sort((a, b) => SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape]);

export function buildPayloadKeepPlan(
  specs: readonly SourceMappingSpec[],
  nativeRuleSets: readonly NativeRuleSet[],
): PayloadKeepPlan {
  const plan = new Map<string, KeepPath[]>();
  const add = (platform: string, keeps: KeepPath[]): void => {
    plan.set(platform, [...(plan.get(platform) ?? []), ...keeps]);
  };
  for (const spec of specs) {
    for (const rules of Object.values(spec.families)) {
      const fieldRules = Object.values(rules ?? {}) as FieldRule[];
      add(
        spec.sourcePlatform,
        fieldRules.flatMap((rule) => keep(rule.paths, 'value')),
      );
    }
  }
  for (const set of nativeRuleSets) {
    const { programs, workouts } = set.families;
    if (programs !== undefined) add(set.sourcePlatform, nativeKeeps({ ...programs }));
    if (workouts === undefined) continue;
    const { exercises, ...scalar } = workouts;
    add(set.sourcePlatform, nativeKeeps(scalar));
    if (exercises !== undefined) {
      const item = ordered(nativeKeeps({ ...exercises.item }));
      add(set.sourcePlatform, keep(exercises.paths, 'items', item));
    }
  }
  for (const [platform, keeps] of plan) plan.set(platform, ordered(keeps));
  return plan;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const emptyObject = (): JsonObjectOut => Object.create(null) as JsonObjectOut;

/** Same walk as the readers: own keys only; a non-object level is absent. */
function readPath(source: unknown, path: readonly string[]): unknown {
  let cursor = source;
  for (const key of path) {
    const obj = asObject(cursor);
    if (obj === null || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
    cursor = obj[key];
  }
  return cursor;
}

function shaped(value: unknown, keepPath: KeepPath): JsonOut {
  if (Array.isArray(value)) {
    if (keepPath.shape === 'count') return value.map(() => null);
    if (keepPath.shape === 'value') return [];
    return value.map((item) => (asObject(item) === null ? null : project(item, keepPath.item)));
  }
  return asObject(value) !== null ? emptyObject() : (value as JsonOut);
}

function project(source: unknown, keeps: readonly KeepPath[]): JsonObjectOut {
  const out = emptyObject();
  for (const keepPath of keeps) {
    const value = readPath(source, keepPath.path);
    // null and absent read the same (path fallback continues), so neither is kept.
    if (value === null || value === undefined) continue;
    let cursor = out;
    const last = keepPath.path.length - 1;
    for (const key of keepPath.path.slice(0, last)) {
      cursor = (asObject(cursor[key]) ?? (cursor[key] = emptyObject())) as JsonObjectOut;
    }
    const kept = shaped(value, keepPath);
    // An object placeholder never replaces keys a deeper declared path already kept.
    if (asObject(kept) !== null && asObject(cursor[keepPath.path[last]]) !== null) continue;
    cursor[keepPath.path[last]] = kept;
  }
  return out;
}

/** The payload cut to the paths its platform declares; `{}` for a platform with no spec. */
export function keepDeclaredPayload(
  plan: PayloadKeepPlan,
  sourcePlatform: string,
  payload: Prisma.InputJsonObject,
): JsonObjectOut {
  return project(payload, plan.get(sourcePlatform) ?? []);
}
