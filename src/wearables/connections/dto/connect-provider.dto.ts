import { IsEnum } from 'class-validator';
import { WearableProvider } from '@prisma/client';

/**
 * PR-HK-1 — body for `POST /v1/wearables/connections/oauth/start`.
 *
 * Validated by the global ValidationPipe (whitelist + forbidNonWhitelisted),
 * so any extra field on the wire is rejected — a client cannot smuggle a
 * spoofed `userId`, `state`, or `redirectUri` (the server mints all three).
 * `@IsEnum` rejects any value outside the canonical {@link WearableProvider}
 * set (50-Failures #8 — phantom validation: the boundary is typed and
 * runtime-checked, not trusted).
 */
export class ConnectProviderDto {
  /** The wearable provider to begin a cloud-OAuth connect flow for. */
  @IsEnum(WearableProvider, {
    message: 'provider must be a supported WearableProvider value',
  })
  provider!: WearableProvider;
}
