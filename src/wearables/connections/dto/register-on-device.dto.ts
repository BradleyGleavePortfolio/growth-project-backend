import { IsIn } from 'class-validator';
import { WearableProvider } from '@prisma/client';

/**
 * S14 — on-device providers that can be registered through
 * `POST /v1/wearables/connections/on-device`. Apple Health (iOS) and Health
 * Connect (Android) are the v1.0 sources; Samsung Health data reaches the app
 * through Health Connect on Android, so it is not a separate device source.
 */
export const ON_DEVICE_LANE_PROVIDERS = [
  WearableProvider.APPLE_HEALTHKIT,
  WearableProvider.HEALTH_CONNECT,
] as const;

export type OnDeviceLaneProvider = (typeof ON_DEVICE_LANE_PROVIDERS)[number];

/**
 * Body for `POST /v1/wearables/connections/on-device`. Validated by the global
 * ValidationPipe (whitelist + forbidNonWhitelisted), so a `userId` or any
 * other extra field is rejected; the owning user always comes from the JWT.
 */
export class RegisterOnDeviceDto {
  @IsIn(ON_DEVICE_LANE_PROVIDERS, {
    message: 'provider must be APPLE_HEALTHKIT or HEALTH_CONNECT',
  })
  provider!: OnDeviceLaneProvider;
}
