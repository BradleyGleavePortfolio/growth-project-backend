import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CapabilityMaterializer } from './capability-materialiser.interface';

/**
 * Multi-provider injection token. All `CapabilityMaterializer` implementations
 * are bound to this token in `AiGatewayModule` (`provide:
 * CAPABILITY_MATERIALIZERS, useExisting: CoachMessageMaterializer`, etc.) so
 * the registry can resolve them at runtime without each materialiser being
 * imported here directly. Keeps the registry decoupled from individual
 * capabilities and avoids circular module dependencies.
 */
export const CAPABILITY_MATERIALIZERS = Symbol('CAPABILITY_MATERIALIZERS');

/**
 * Resolves the right `CapabilityMaterializer` for a given capability string.
 *
 * Capabilities WITHOUT a registered materialiser intentionally resolve to
 * `null` — `AiApprovalService.decide` treats that as "no side-effect to
 * emit, just flip status to approved" so we preserve the pre-PR-AI-3
 * behaviour for capabilities that already materialise inline elsewhere
 * (WORKOUT_PROGRAM / MEAL_PLAN go through `coach-ai.service.ts`).
 */
@Injectable()
export class CapabilityMaterializerRegistry {
  private readonly logger = new Logger(CapabilityMaterializerRegistry.name);
  private readonly materialisers: CapabilityMaterializer[];

  constructor(
    @Optional()
    @Inject(CAPABILITY_MATERIALIZERS)
    materialisers: CapabilityMaterializer[] | CapabilityMaterializer | null = null,
  ) {
    // Nest's multi-provider injection delivers an array; in unit tests we may
    // pass a single instance or omit altogether. Normalise to an array so
    // `resolve()` only has one shape to consider.
    if (Array.isArray(materialisers)) {
      this.materialisers = materialisers.filter(Boolean);
    } else if (materialisers) {
      this.materialisers = [materialisers];
    } else {
      this.materialisers = [];
    }
    // Defensive: warn if two materialisers claim the same capability. The
    // registry will return the FIRST registered one, but a duplicate almost
    // always indicates a wiring mistake.
    const seen = new Set<string>();
    for (const m of this.materialisers) {
      if (seen.has(m.capability)) {
        this.logger.warn(
          `Duplicate CapabilityMaterializer registered for capability=${m.capability}; first one wins.`,
        );
      }
      seen.add(m.capability);
    }
  }

  /**
   * Resolve the materialiser for a capability string. Returns `null` when
   * no materialiser is registered — callers MUST treat that as a no-op and
   * proceed with the approval (preserving behaviour for capabilities that
   * materialise inline elsewhere).
   */
  resolve(capability: string): CapabilityMaterializer | null {
    if (!capability) return null;
    for (const m of this.materialisers) {
      if (m.canHandle(capability)) return m;
    }
    return null;
  }

  /** Exposed for tests + ops diagnostics. */
  list(): ReadonlyArray<CapabilityMaterializer> {
    return this.materialisers;
  }
}
