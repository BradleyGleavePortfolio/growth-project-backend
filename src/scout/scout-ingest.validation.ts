import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';

// Canonical namespaces are exact lowercase ASCII slugs, including auto:host.
// Reject aliases rather than silently merging two previously distinct identities.
export const SCOUT_PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
export const SCOUT_TIMESTAMP_PATTERN =
  /^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function supportedTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    SCOUT_TIMESTAMP_PATTERN.test(value) &&
    isISO8601(value, { strict: true, strictSeparator: true }) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).getUTCFullYear() >= 1 &&
    new Date(value).getUTCFullYear() <= 9999
  );
}

export function ingestDate(platform: string, timestamp: string): Date {
  if (!SCOUT_PLATFORM_PATTERN.test(platform) || !supportedTimestamp(timestamp)) {
    throw new BadRequestException(
      'sourcePlatform must be a canonical slug and capturedAt a supported timestamp',
    );
  }
  return new Date(timestamp);
}
