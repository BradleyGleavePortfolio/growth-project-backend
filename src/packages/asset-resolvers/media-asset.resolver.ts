import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { ResolverSubCoachScope } from './sub-coach-scope.helper';
import { MediaAssetNotFoundError } from './assignable-asset-resolver.errors';
import type {
  AssignableAssetMaterialiseInput,
  AssignableAssetMaterialiseResult,
  AssignableAssetResolver,
  AssignableAssetType,
} from './assignable-asset-resolver.interface';

// PR-7 — resolver for asset_type `pdf` and `video`.
//
// Both asset_types are CoachMediaAsset rows differentiated by
// `CoachMediaAsset.kind`. Materialising means minting a `ClientAssetGrant`
// for `(client_id, media_asset_id)` so the client app can fetch the asset.
//
// There is no pre-existing service that creates ClientAssetGrant rows
// (the model was added in PR-3 and the authoring/upload pipeline lands in
// PR-12) — so this resolver owns the write directly rather than delegating.
//
// Idempotency: ClientAssetGrant has `@@unique([client_id, media_asset_id])`
// (see prisma/schema.prisma:4717). We attempt the INSERT and treat P2002
// as the on-conflict-nothing path — re-query and return the existing grant
// id. Result: a PR-10 retry of the same drop always lands on the same
// grant row regardless of which call wins the race.
//
// tx-honoring: ALL writes here go through `input.tx ?? this.prisma`. The
// immediate-at-checkout caller passes a tx; cron path passes none. We
// never open a nested transaction.
//
// PR-12 gate: until the CoachMediaAsset upload pipeline ships, a drop may
// reference a media_asset_id that does not exist. We refuse with a typed
// `MediaAssetNotFoundError` so the caller (PR-9/PR-10) marks the drop
// failed with a clear `failure_reason` instead of crashing on FK violation.

@Injectable()
export class MediaAssetResolver implements AssignableAssetResolver {
  private readonly logger = new Logger(MediaAssetResolver.name);
  readonly assetType: AssignableAssetType = 'pdf';

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ResolverSubCoachScope,
  ) {}

  canHandle(assetType: string): boolean {
    return assetType === 'pdf' || assetType === 'video';
  }

  async materialise(
    input: AssignableAssetMaterialiseInput,
  ): Promise<AssignableAssetMaterialiseResult> {
    const acting = await this.scope.resolve(input.coachId, input.clientId);
    const db = input.tx ?? this.prisma;

    // PR-12 gate: assert the media asset exists AND belongs to the acting
    // tenant coach. Without the tenant check a malformed package could
    // grant access to another coach's asset.
    const asset = await db.coachMediaAsset.findUnique({
      where: { id: input.assetId },
      select: { id: true, coach_id: true, archived_at: true },
    });
    if (!asset || asset.archived_at) {
      throw new MediaAssetNotFoundError(input.assetId);
    }
    if (asset.coach_id !== acting.tenantCoachId) {
      // Tenant mismatch surfaces as the same not-found error from the
      // client's perspective — we deliberately do not leak the existence of
      // another coach's asset to a misconfigured package.
      this.logger.warn(
        `MediaAssetResolver: tenant mismatch — asset.coach_id=${asset.coach_id} acting.tenantCoachId=${acting.tenantCoachId}`,
      );
      throw new MediaAssetNotFoundError(input.assetId);
    }

    // On-conflict-nothing via the @@unique(client_id, media_asset_id):
    // optimistic INSERT, P2002 → look up the existing grant and return its
    // id. Mirrors AssignWorkoutMaterializer's P2002 race-recovery
    // (src/ai/gateway/materialisers/assign-workout.materialiser.ts:201-218).
    try {
      const created = await db.clientAssetGrant.create({
        data: {
          client_id: input.clientId,
          media_asset_id: input.assetId,
          granted_via_drop_id: input.scheduledDropId ?? null,
        },
        select: { id: true },
      });
      return { materialisedRef: created.id };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await db.clientAssetGrant.findUnique({
          where: {
            client_id_media_asset_id: {
              client_id: input.clientId,
              media_asset_id: input.assetId,
            },
          },
          select: { id: true },
        });
        if (existing) {
          return { materialisedRef: existing.id };
        }
        this.logger.error(
          `MediaAssetResolver: P2002 on grant insert for client=${input.clientId} asset=${input.assetId} but no row found`,
        );
      }
      throw err;
    }
  }
}
