import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { InductionManifestV1 } from '../induction/contract';
import { canonicalJson, sha256Hex } from '../induction/digest';
import {
  buildInductionRegistry,
  loadInductionManifests,
  type InductionRegistry,
} from '../induction/manifest-registry';
import type { SourceMappingSpec } from './mapping-spec';
import {
  buildNativeRuleRegistry,
  loadNativeRuleSets,
  type NativeRuleRegistry,
} from './native/native-rule-registry';
import type { NativeRuleSet } from './native/native-rules';
import {
  buildSourceMapperRegistry,
  loadSourceMappingSpecs,
  type SourceMapper,
} from './source-mapper-registry';

/**
 * L2a — the ONE source registry provider (docs/decisions/2026-09-27-learn-and-remember.md
 * D-L0-5 "Runtime loading: one registry provider, CORE DIFF = 0 for a new site").
 *
 * Until this slice, seven sites each built their own registry from the repository files at
 * construction (`families.ts`, the reconstruct engine, the roster and entities readers, the
 * observation service and the reconciliation facts service). That plurality is the seam that
 * failed S11-D leg B three times. Every family resolution now goes through this provider:
 *
 *  - {@link SourceRegistryProvider.files}: the three data-only file registries (mapping specs,
 *    native rule sets, induction manifests), loaded ONCE per process by the unchanged loaders and
 *    cross-checked by the unchanged S10-C builder. A run with no pin sees exactly this — the
 *    same maps, built from the same files, in the same order as before this slice.
 *  - {@link SourceRegistryProvider.forRun}: the registries ONE run's rows are interpreted
 *    through. It asks the {@link RunPackageSource} for the run's pinned learned package and, when
 *    there is one, composes it with the file registries. A slug present in both a file spec and
 *    the run package is a load-time error: "file wins" is never silent.
 *
 * Today the only {@link RunPackageSource} is {@link NO_RUN_PACKAGE}, which returns `null` for
 * every run; L2b plugs in the pinned package read from PostgreSQL (`ScoutRunLearnedPackage` →
 * `ScoutLearnedPlatform`, one query, no cache). Nothing here names a source: a new site adds
 * rows, not files, and `src/**` does not change.
 *
 * r2 (R588-A-B1, R588-B-1, R588-B-2):
 *  - the {@link RUN_PACKAGE_SOURCE} binding is REQUIRED and provided inside
 *    `SourceRegistryModule` (explicitly {@link NO_RUN_PACKAGE} until L2b), so an override reaches
 *    this provider and a missing binding fails Nest boot instead of silently reading no pin;
 *  - `forRun` takes the database handle the caller holds (the settle transaction, a reader's
 *    snapshot) so L2b's pin read happens on it, never on a side connection;
 *  - every {@link RunRegistries} carries the {@link RunRegistries.pinDigest} it was built from,
 *    and {@link SourceRegistryProvider.verifyPin} re-reads the pin on a transaction and refuses
 *    ({@link RunRegistryPinChangedError}) when it no longer matches — the settle resolves ONCE
 *    and verifies under the run-row lock, so one settle can never observe two pins.
 */

/** The three data-only artifact kinds, as the unchanged loaders parse them. */
export interface SourceArtifacts {
  readonly specs: readonly SourceMappingSpec[];
  readonly nativeRuleSets: readonly NativeRuleSet[];
  readonly manifests: readonly InductionManifestV1[];
}

/** The registries every reader and writer resolves families through. */
export interface SourceRegistries {
  readonly sourceMappers: ReadonlyMap<string, SourceMapper>;
  readonly nativeRules: NativeRuleRegistry;
  readonly induction: InductionRegistry;
}

/**
 * One run's pinned learned package, already parsed by the SAME strict parsers the file loaders
 * use (`parseSourceMappingSpec`, `parseNativeRuleSet`, `parseInductionManifest`). The rule set
 * and manifest are optional: a learned source may declare no native rules and, before L3, its
 * derived manifest may be absent (never provable).
 */
export interface RunPackage {
  readonly spec: SourceMappingSpec;
  readonly nativeRuleSet: NativeRuleSet | null;
  readonly manifest: InductionManifestV1 | null;
}

/** What {@link SourceRegistryProvider.forRun} resolves: the registries plus the pin they came from. */
export interface RunRegistries extends SourceRegistries {
  /** The run's pinned package, or `null`: the run sees exactly {@link SourceRegistryProvider.files}. */
  readonly pinned: RunPackage | null;
  /**
   * The identity of {@link pinned}: `null` for no pin, else the sha256 of the package's
   * canonical JSON ({@link runPackageDigest}). Two resolutions interpret a run identically iff
   * their digests are equal; {@link SourceRegistryProvider.verifyPin} compares exactly this.
   */
  readonly pinDigest: string | null;
}

/**
 * The database handle a pin is read on: the caller's transaction (the settle's REPEATABLE READ
 * tx under the run-row lock, a reader's snapshot) or the root client outside one.
 */
export type RegistryDb = Prisma.TransactionClient;

/**
 * The typed extension point for the run's memory (D-L0-5). `null` = this run has no pin. The
 * source must never throw for "no pin"; it may throw for a corrupt pin, which fails the caller
 * loudly rather than silently falling back to the files. It reads ON `db` (the caller's
 * transaction), never on a connection of its own, and is keyed by BOTH `coachId` and `intentId`.
 */
export interface RunPackageSource {
  forRun(db: RegistryDb, coachId: string, intentId: string): Promise<RunPackage | null>;
}

/**
 * DI token for the {@link RunPackageSource}. REQUIRED: `SourceRegistryModule` provides it
 * ({@link NO_RUN_PACKAGE} until L2b); tests and L2b override THIS token.
 */
export const RUN_PACKAGE_SOURCE = Symbol('RUN_PACKAGE_SOURCE');

/** One settle saw two different pins (R588-B-1): the settle fails closed, nothing terminal is written. */
export class RunRegistryPinChangedError extends Error {
  constructor(
    readonly coachId: string,
    readonly intentId: string,
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(
      `run ${intentId}: the pinned source package changed within one settle ` +
        `(resolved ${expected ?? 'none'}, now ${actual ?? 'none'}); refusing to settle`,
    );
    this.name = 'RunRegistryPinChangedError';
  }
}

/**
 * The content identity of one run package: sha256 over the canonical JSON of its three parts
 * (`null` parts included). Parsed packages are plain JSON data, so the canonical form exists;
 * if it ever did not, the digest falls back to the (deterministic) insertion-order JSON.
 */
export function runPackageDigest(pkg: RunPackage | null): string | null {
  if (pkg === null) return null;
  const parts = { spec: pkg.spec, nativeRuleSet: pkg.nativeRuleSet, manifest: pkg.manifest };
  return sha256Hex(canonicalJson(parts) ?? JSON.stringify(parts));
}

/** The V1 source: no run is pinned, every run sees the file registries. */
export const NO_RUN_PACKAGE: RunPackageSource = Object.freeze({
  forRun: (): Promise<RunPackage | null> => Promise.resolve(null),
});

/** The repository files through the unchanged loaders (byte-sorted filename order, fail loud). */
export function loadSourceArtifacts(): SourceArtifacts {
  return Object.freeze({
    specs: loadSourceMappingSpecs(),
    nativeRuleSets: loadNativeRuleSets(),
    manifests: loadInductionManifests(),
  });
}

/**
 * Build the three registries from one artifact set with the unchanged builders. The S10-C
 * cross-check (`buildInductionRegistry`: a rule set or manifest needs exactly one spec, families
 * agree, `nativeRules` declaration agrees) runs over the whole set, so a composed package is
 * held to the same rules as the files.
 */
export function buildSourceRegistries(artifacts: SourceArtifacts): SourceRegistries {
  return Object.freeze({
    sourceMappers: buildSourceMapperRegistry(artifacts.specs),
    nativeRules: buildNativeRuleRegistry(artifacts.nativeRuleSets),
    induction: buildInductionRegistry({
      manifests: artifacts.manifests,
      specs: artifacts.specs,
      nativeRuleSets: artifacts.nativeRuleSets,
    }),
  });
}

/**
 * Compose the file artifacts with one run package. Throws (load-time, before any row is read)
 * when the package's slug is already a file spec, rule set or manifest — a source defined in
 * both places has no silent winner — or when the package's parts disagree on their slug.
 */
export function composeRunArtifacts(files: SourceArtifacts, pkg: RunPackage): SourceArtifacts {
  const slug = pkg.spec.sourcePlatform;
  const kinds: readonly [string, readonly { readonly sourcePlatform: string }[]][] = [
    ['mapping spec', files.specs],
    ['native rule set', files.nativeRuleSets],
    ['induction manifest', files.manifests],
  ];
  for (const [kind, list] of kinds) {
    if (list.some((item) => item.sourcePlatform === slug)) {
      throw new Error(
        `source platform ${slug} is defined by both a repository ${kind} and the run's learned package`,
      );
    }
  }
  if (pkg.nativeRuleSet !== null && pkg.nativeRuleSet.sourcePlatform !== slug) {
    throw new Error(
      `learned package for ${slug}: native rule set names ${pkg.nativeRuleSet.sourcePlatform}`,
    );
  }
  if (pkg.manifest !== null && pkg.manifest.sourcePlatform !== slug) {
    throw new Error(`learned package for ${slug}: manifest names ${pkg.manifest.sourcePlatform}`);
  }
  return Object.freeze({
    specs: [...files.specs, pkg.spec],
    nativeRuleSets:
      pkg.nativeRuleSet === null
        ? files.nativeRuleSets
        : [...files.nativeRuleSets, pkg.nativeRuleSet],
    manifests: pkg.manifest === null ? files.manifests : [...files.manifests, pkg.manifest],
  });
}

interface LoadedFiles {
  readonly artifacts: SourceArtifacts;
  readonly registries: SourceRegistries;
  readonly unpinned: RunRegistries;
}

function loadFiles(artifacts: SourceArtifacts): LoadedFiles {
  const registries = buildSourceRegistries(artifacts);
  return Object.freeze({
    artifacts,
    registries,
    unpinned: Object.freeze({ ...registries, pinned: null, pinDigest: null }),
  });
}

/** The repository files, loaded once per process and shared by every provider built without explicit artifacts. */
let repositoryFiles: LoadedFiles | undefined;
function sharedRepositoryFiles(): LoadedFiles {
  repositoryFiles ??= loadFiles(loadSourceArtifacts());
  return repositoryFiles;
}

@Injectable()
export class SourceRegistryProvider {
  constructor(@Inject(RUN_PACKAGE_SOURCE) private readonly runPackages: RunPackageSource) {}

  private get loadedFiles(): LoadedFiles {
    return sharedRepositoryFiles();
  }

  /** The file artifacts this provider composes over (loaded once per process). */
  get artifacts(): SourceArtifacts {
    return this.loadedFiles.artifacts;
  }

  /** The file registries alone: what every run without a pin resolves to. Built once. */
  get files(): SourceRegistries {
    return this.loadedFiles.registries;
  }

  /**
   * The registries ONE run's rows are interpreted through, with the pin read on `db`. No pin →
   * the file registries, the identical objects every time (byte-identical to the pre-L2a
   * construction). A pin → the files composed with the pinned package, built afresh per call
   * (PostgreSQL is the only authority, D-S11-1: no cache of a run's interpretation lives in a
   * machine). A caller that must interpret one run in several steps (the settle) resolves ONCE
   * and threads the result; see {@link verifyPin}.
   */
  async forRun(db: RegistryDb, coachId: string, intentId: string): Promise<RunRegistries> {
    const pinned = await this.runPackages.forRun(db, coachId, intentId);
    if (pinned === null) return this.loadedFiles.unpinned;
    const composed = buildSourceRegistries(composeRunArtifacts(this.artifacts, pinned));
    return Object.freeze({ ...composed, pinned, pinDigest: runPackageDigest(pinned) });
  }

  /**
   * R588-B-1: re-read the run's pin on `db` (the settle transaction, under the run-row lock) and
   * refuse unless it is the pin `resolved` was built from. A run with no pin before and after
   * passes without composing anything.
   */
  async verifyPin(
    db: RegistryDb,
    coachId: string,
    intentId: string,
    resolved: RunRegistries,
  ): Promise<void> {
    const actual = runPackageDigest(await this.runPackages.forRun(db, coachId, intentId));
    if (actual !== resolved.pinDigest) {
      throw new RunRegistryPinChangedError(coachId, intentId, resolved.pinDigest, actual);
    }
  }
}

/**
 * The process-wide provider over the repository files with {@link NO_RUN_PACKAGE}. It is NEVER
 * a Nest fallback: every Nest-built consumer requires the module-provided
 * {@link SourceRegistryProvider} (a missing binding fails boot). This factory exists only for
 * code that constructs services by hand — unit tests and the PG proof workers — and for the
 * option-less `buildFamilyRegistry()` over the repository files.
 */
let fileOnlyProvider: SourceRegistryProvider | undefined;
export function defaultSourceRegistryProvider(): SourceRegistryProvider {
  fileOnlyProvider ??= new SourceRegistryProvider(NO_RUN_PACKAGE);
  return fileOnlyProvider;
}
