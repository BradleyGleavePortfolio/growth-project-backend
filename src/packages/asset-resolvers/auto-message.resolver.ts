import { Injectable, Logger } from '@nestjs/common';
import { MessagingService } from '../../messaging/messaging.service';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import {
  AutoMessageBodyMissingError,
} from './assignable-asset-resolver.errors';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
  AssignableAssetType,
} from './assignable-asset-resolver.interface';

// PR-7 — resolver for asset_type `auto_message`.
//
// Delegates to `MessagingService.sendAsCoach`
// (src/messaging/messaging.service.ts:396). `sendAsCoach` internally calls
// `assertClientOfCoach`, which already understands sub-coach scope (Phase 11
// SubCoachAssignment fallback at messaging.service.ts:287-314), so we still
// route through `ResolverSubCoachScope` first to apply the rule uniformly
// across every resolver — defence-in-depth and identical wiring.
//
// The body comes from `displayCaption` (preferred) or `displayTitle`
// (fallback). PR-12 introduces the auto-message template authoring surface;
// until then a drop without either field cannot produce a non-empty message
// and we fail loudly with a typed `AutoMessageBodyMissingError` rather than
// sending whitespace.
//
// Idempotency: `MessagingService.sendAsCoach` does NOT currently dedupe on
// a caller-supplied key (per the TODO in
// coach-message.materialiser.ts:78-81). For PR-7 we therefore document the
// at-least-once behaviour and rely on PR-10 to suppress retries once the
// ScheduledDrop has `materialised_ref` set. A duplicate send within a retry
// window will surface as a second CoachMessage row — preferable to silently
// dropping a paid-for delivery.
//
// tx-honoring: `sendAsCoach` opens no transaction and we cannot push `tx`
// into it without an out-of-scope signature change to MessagingService.

@Injectable()
export class AutoMessageAssetResolver implements AssignableAssetResolver {
  private readonly logger = new Logger(AutoMessageAssetResolver.name);
  readonly assetType: AssignableAssetType = 'auto_message';

  constructor(
    private readonly messaging: MessagingService,
    private readonly scope: ResolverSubCoachScope,
  ) {}

  canHandle(assetType: string): boolean {
    return assetType === 'auto_message';
  }

  async materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    const body = (input.displayCaption ?? input.displayTitle ?? '').trim();
    if (!body) {
      throw new AutoMessageBodyMissingError();
    }

    const acting = await this.scope.resolve(input.coachId, input.clientId);

    const sent = await this.messaging.sendAsCoach(
      acting.tenantCoachId,
      input.clientId,
      { body },
    );
    if (!sent?.id) {
      this.logger.error(
        `AutoMessageAssetResolver: sendAsCoach returned no id for client=${input.clientId}`,
      );
      throw new Error('AutoMessageAssetResolver: sendAsCoach returned no id');
    }
    return { materialisedRef: sent.id };
  }
}
