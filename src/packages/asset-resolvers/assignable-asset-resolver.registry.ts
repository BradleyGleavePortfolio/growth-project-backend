import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
} from './assignable-asset-resolver.interface';
import { UnknownAssignableAssetTypeError } from './assignable-asset-resolver.errors';

// PR-7 — registry for AssignableAssetResolver implementations.
//
// Mirrors the multi-provider injection pattern used by
// `CapabilityMaterializerRegistry`
// (src/ai/gateway/materialisers/capability-materialiser.registry.ts:23-75):
//   - Resolvers register themselves as concrete providers AND as entries in
//     the array bound to `ASSIGNABLE_ASSET_RESOLVERS` (multi-injection token).
//   - The registry dispatches by `asset_type` string via `canHandle`.
//   - Duplicate registrations log a warning; first registered resolver wins.
//
// Differs from CapabilityMaterializerRegistry in one place: `resolve()`
// throws `UnknownAssignableAssetTypeError` on unknown types (rather than
// returning null). The drip executor / immediate fan-out cannot meaningfully
// "no-op" on an unknown asset_type — a missing resolver is a wiring bug that
// MUST surface so the drop can be marked failed and operators paged.

export const ASSIGNABLE_ASSET_RESOLVERS = Symbol(
  'ASSIGNABLE_ASSET_RESOLVERS',
);

@Injectable()
export class AssignableAssetResolverRegistry {
  private readonly logger = new Logger(AssignableAssetResolverRegistry.name);
  private readonly resolvers: AssignableAssetResolver[];

  constructor(
    @Optional()
    @Inject(ASSIGNABLE_ASSET_RESOLVERS)
    resolvers:
      | AssignableAssetResolver[]
      | AssignableAssetResolver
      | null = null,
  ) {
    if (Array.isArray(resolvers)) {
      this.resolvers = resolvers.filter(Boolean);
    } else if (resolvers) {
      this.resolvers = [resolvers];
    } else {
      this.resolvers = [];
    }
    const seen = new Set<string>();
    for (const r of this.resolvers) {
      if (seen.has(r.assetType)) {
        this.logger.warn(
          `Duplicate AssignableAssetResolver registered for asset_type=${r.assetType}; first one wins.`,
        );
      }
      seen.add(r.assetType);
    }
  }

  /**
   * Resolve the resolver for an asset_type string. Throws
   * `UnknownAssignableAssetTypeError` when no resolver is registered — the
   * caller (drip executor / immediate fan-out) must treat this as a hard
   * failure and mark the ScheduledDrop failed.
   */
  resolve(assetType: string): AssignableAssetResolver {
    if (assetType) {
      for (const r of this.resolvers) {
        if (r.canHandle(assetType)) return r;
      }
    }
    throw new UnknownAssignableAssetTypeError(assetType);
  }

  /**
   * Convenience: look up the resolver and delegate in one call. Wraps
   * `resolve(asset_type).materialise(input)` so call sites stay tight.
   */
  async materialise(
    assetType: string,
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    return this.resolve(assetType).materialise(input);
  }

  /** Exposed for tests + ops diagnostics. */
  list(): ReadonlyArray<AssignableAssetResolver> {
    return this.resolvers;
  }
}
