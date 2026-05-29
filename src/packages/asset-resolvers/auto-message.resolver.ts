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
// (src/messaging/messaging.service.ts:396). `sendAsCoach` runs its OWN
// sub-coach split internally (Phase 11 fallback at messaging.service.ts:
// 285-314): given the acting coach id, it pins the thread's `coach_id` to
// the head coach but writes `sender_id` to the acting (sub-)coach so the
// thread is attributed correctly.
//
// IMPORTANT — what we pass as the first arg differs from workout/meal_plan.
// Those resolvers pass `acting.tenantCoachId` (head coach) because the
// downstream service enforces strict `plan.coach_id === coachId` ownership
// on a tenant column. `sendAsCoach` is the opposite: it expects the ACTING
// coach id and resolves the head-coach split internally. Passing the head
// coach id here would defeat that split and mis-attribute the sender to the
// head coach. We still call `ResolverSubCoachScope.resolve()` first so the
// out-of-scope refusal is uniform across every resolver (defence-in-depth)
// — we just don't substitute the tenant id in the call.
//
// The body comes from `displayCaption` (preferred) or `displayTitle`
// (fallback). PR-12 introduces the auto-message template authoring surface;
// until then a drop without either field cannot produce a non-empty message
// and we fail loudly with a typed `AutoMessageBodyMissingError` rather than
// sending whitespace.
//
// Idempotency: `MessagingService.sendAsCoach` does NOT today dedupe on a
// caller-supplied key (per the TODO in coach-message.materialiser.ts:78-81),
// so this resolver is AT-LEAST-ONCE — see the contract note on
// AssignableAssetResolver.materialise(). PR-10's drip executor MUST gate
// retries on `ScheduledDrop.materialised_ref` being NULL so a successful
// send is never replayed.
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

    // Run the resolver-wide scope check (uniform with the other resolvers)
    // but DELIBERATELY pass the acting coach id — not tenantCoachId — to
    // sendAsCoach. The service does its own Phase-11 sub-coach split using
    // exactly that id; passing the head coach would mis-attribute the
    // sender. See the file-level comment for the full rationale.
    const acting = await this.scope.resolve(input.coachId, input.clientId);

    const sent = await this.messaging.sendAsCoach(
      acting.actingCoachId,
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
