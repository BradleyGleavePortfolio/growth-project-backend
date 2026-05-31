import { IsEnum } from 'class-validator';
import { WearableProvider } from '@prisma/client';

/**
 * PR-HK-1 — path param for `DELETE /v1/wearables/connections/:provider`.
 *
 * The `:provider` route param is validated against the canonical
 * {@link WearableProvider} enum so a bad provider returns 400 (not a 500 deep
 * in the service). Used with a per-param ValidationPipe on the controller.
 * The owning user is taken from the JWT (never the path), so there is no IDOR
 * surface here — the service additionally scopes the mutation to
 * `req.user.id` (50-Failures #5).
 */
export class DisconnectProviderParamDto {
  /** The provider whose connection to soft-disconnect. */
  @IsEnum(WearableProvider, {
    message: 'provider must be a supported WearableProvider value',
  })
  provider!: WearableProvider;
}
