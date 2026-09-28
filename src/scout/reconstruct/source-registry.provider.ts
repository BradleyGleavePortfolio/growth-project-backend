import { Inject, Injectable, Optional } from '@nestjs/common';
import type { InductionManifestV1 } from '../induction/contract';
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
}

/**
 * The typed extension point for the run's memory (D-L0-5). `null` = this run has no pin. The
 * source must never throw for "no pin"; it may throw for a corrupt pin, which fails the caller
 * loudly rather than silently falling back to the files.
 */
export interface RunPackageSource {
  forRun(coachId: string, intentId: string): Promise<RunPackage | null>;
}

/** DI token for the {@link RunPackageSource}; absent → {@link NO_RUN_PACKAGE}. */
export const RUN_PACKAGE_SOURCE = Symbol('RUN_PACKAGE_SOURCE');
/** DI token for the file artifacts; absent → the repository files, loaded once per process. */
export const SOURCE_ARTIFACTS = Symbol('SOURCE_ARTIFACTS');

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
    unpinned: Object.freeze({ ...registries, pinned: null }),
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
  private readonly runPackages: RunPackageSource;
  private readonly explicit: SourceArtifacts | undefined;
  private loaded: LoadedFiles | undefined;

  constructor(
    @Optional() @Inject(SOURCE_ARTIFACTS) artifacts?: SourceArtifacts,
    @Optional() @Inject(RUN_PACKAGE_SOURCE) runPackages?: RunPackageSource,
  ) {
    this.explicit = artifacts;
    this.runPackages = runPackages ?? NO_RUN_PACKAGE;
  }

  private get loadedFiles(): LoadedFiles {
    if (this.loaded === undefined) {
      this.loaded =
        this.explicit === undefined ? sharedRepositoryFiles() : loadFiles(this.explicit);
    }
    return this.loaded;
  }

  /** The file artifacts this provider composes over (loaded once). */
  get artifacts(): SourceArtifacts {
    return this.loadedFiles.artifacts;
  }

  /** The file registries alone: what every run without a pin resolves to. Built once. */
  get files(): SourceRegistries {
    return this.loadedFiles.registries;
  }

  /**
   * The registries ONE run's rows are interpreted through. No pin → the file registries, the
   * identical objects every time (byte-identical to the pre-L2a construction). A pin → the files
   * composed with the pinned package, built afresh per call (PostgreSQL is the only authority,
   * D-S11-1: no cache of a run's interpretation lives in a machine).
   */
  async forRun(coachId: string, intentId: string): Promise<RunRegistries> {
    const pinned = await this.runPackages.forRun(coachId, intentId);
    if (pinned === null) return this.loadedFiles.unpinned;
    const composed = buildSourceRegistries(composeRunArtifacts(this.artifacts, pinned));
    return Object.freeze({ ...composed, pinned });
  }
}

/** The process-wide provider over the repository files; the default of every seam not injected by Nest. */
let defaultProvider: SourceRegistryProvider | undefined;
export function defaultSourceRegistryProvider(): SourceRegistryProvider {
  defaultProvider ??= new SourceRegistryProvider();
  return defaultProvider;
}
