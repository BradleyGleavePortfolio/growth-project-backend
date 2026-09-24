import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  interpretClient,
  interpretEntity,
  parseSourceMappingSpec,
  resolveStep,
  unsupportedPlatformReason,
  type MapClientResult,
  type MapEntityResult,
  type SourceMappingSpec,
  type StagedSourceRow,
  type StepResolution,
} from './mapping-spec';

/**
 * One source adapter: the per-platform view of the ONE generic interpreter over
 * that platform's data-only `SourceMappingSpec`, keyed by `source_platform`.
 * `clients` maps to a roster Person via `mapClient`; every non-person family
 * (`workouts`, `client_history`) maps to the generic canonical entity via
 * `mapEntity`; `resolveStep` maps a source step token to its canonical family or
 * an explicit `unresolved_family:<token>`. All are pure and total — they return
 * an explicit skip reason rather than throwing — so the engine's accounting stays
 * exhaustive. There is no per-source TypeScript: a new source is one JSON file in
 * `./sources/`, with no change to the interpreter, engine, DTOs, contract, or
 * schema (NEW SOURCE → CORE DIFF = 0 for mapping).
 */
export interface SourceMapper {
  readonly sourcePlatform: string;
  readonly spec: SourceMappingSpec;
  mapClient(row: StagedSourceRow): MapClientResult;
  mapEntity(family: string, row: StagedSourceRow): MapEntityResult;
  resolveStep(step: string): StepResolution;
}

/**
 * The repository-resident spec directory. Resolved beside this module, so the
 * specs must ship with the compiled output (the build copies
 * `scout/reconstruct/sources/*.json` as assets). A missing or empty directory is
 * a loud load-time error, never a silent "every platform unsupported" mapping.
 */
export const SOURCE_SPECS_DIR = join(__dirname, 'sources');

/**
 * Load and strictly validate every `*.json` spec in a directory, in byte-sorted
 * filename order (deterministic across hosts). Fails closed: an unreadable or
 * empty directory, a malformed spec, or two specs claiming one `sourcePlatform`
 * all throw with the offending file.
 */
export function loadSourceMappingSpecs(dir: string = SOURCE_SPECS_DIR): SourceMappingSpec[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0) throw new Error(`no source mapping specs found in ${dir}`);
  const seen = new Set<string>();
  return files.map((name) => {
    const spec = parseSourceMappingSpec(
      JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown,
      name,
    );
    if (seen.has(spec.sourcePlatform)) {
      throw new Error(`duplicate source mapping spec for ${spec.sourcePlatform} (${name})`);
    }
    seen.add(spec.sourcePlatform);
    return spec;
  });
}

/** Bind the generic interpreter to one validated spec. */
export function sourceMapperFor(spec: SourceMappingSpec): SourceMapper {
  return {
    sourcePlatform: spec.sourcePlatform,
    spec,
    mapClient: (row) => interpretClient(spec, row),
    mapEntity: (family, row) => interpretEntity(spec, family, row),
    resolveStep: (step) => resolveStep(spec, step),
  };
}

/**
 * Build the `source_platform` → mapper registry from the data-only specs. An
 * unregistered platform is NOT found and the family layer fails it closed with
 * the exact `unsupported_platform:<token>` skip reason — byte-identical to the
 * guard the interpreter applies internally. Registration is a dispatch entry, not
 * an authorization boundary: tenant/RLS scoping and the existing (default-off)
 * scout flags remain the boundaries. Returns a fresh map per call.
 */
export function buildSourceMapperRegistry(
  specs: readonly SourceMappingSpec[] = loadSourceMappingSpecs(),
): ReadonlyMap<string, SourceMapper> {
  return new Map(specs.map((spec) => [spec.sourcePlatform, sourceMapperFor(spec)]));
}

/**
 * Resolve a staged row's (platform, step token) to a canonical family. An
 * unregistered platform is `unsupported_platform:<platform>`; a step the
 * platform's spec does not map (e.g. TrueCoach `notes`) is
 * `unresolved_family:<token>` — explicit accounting input for the terminal
 * arbiter instead of a silent absence.
 */
export function resolveStagedFamily(
  registry: ReadonlyMap<string, SourceMapper>,
  sourcePlatform: string,
  step: string,
): StepResolution {
  const mapper = registry.get(sourcePlatform);
  if (mapper === undefined) return { ok: false, reason: unsupportedPlatformReason(sourcePlatform) };
  return mapper.resolveStep(step);
}
