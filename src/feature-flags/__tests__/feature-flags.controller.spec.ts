import 'reflect-metadata';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';
import { FeatureFlagsController } from '../feature-flags.controller';
import { FeatureFlagsService } from '../feature-flags.service';
import { FeatureFlagsTelemetry } from '../feature-flags.telemetry';
import {
  FEATURE_FLAG_KEYS,
  FeatureFlagsResponseSchema,
} from '../feature-flags.dto';

// @Throttle stores per-bucket metadata under `THROTTLER:LIMIT<name>` /
// `THROTTLER:TTL<name>`; the unnamed `default` bucket uses the `default`
// suffix (same convention as test/billing-throttle-metadata.spec.ts).
const THROTTLE_LIMIT_DEFAULT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_DEFAULT_KEY = 'THROTTLER:TTLdefault';

function makeReq(userId: string, role: 'coach' | 'owner' | 'student'): AuthedRequest {
  return { user: { id: userId, role } as AuthedRequest['user'] };
}

describe('FeatureFlagsController', () => {
  let service: FeatureFlagsService;
  let telemetry: { evaluated: jest.Mock };
  let controller: FeatureFlagsController;

  const ALL_ON = {
    community_search: true,
    coach_community_wearable_prompts: true,
    community_classroom: true,
    community_events: true,
  };

  beforeEach(() => {
    service = { evaluate: jest.fn(() => ({ ...ALL_ON })) } as never;
    telemetry = { evaluated: jest.fn() };
    controller = new FeatureFlagsController(
      service,
      telemetry as unknown as FeatureFlagsTelemetry,
    );
  });

  describe('GET /me/feature-flags', () => {
    it('returns a strict envelope: { flags, evaluated_at } and nothing else', () => {
      const res = controller.getFeatureFlags(makeReq('u1', 'coach'));
      expect(Object.keys(res).sort()).toEqual(['evaluated_at', 'flags']);
      expect(res.flags).toEqual(ALL_ON);
      // evaluated_at is a valid ISO-8601 datetime the schema accepts.
      expect(() => FeatureFlagsResponseSchema.parse(res)).not.toThrow();
      expect(new Date(res.evaluated_at).toISOString()).toBe(res.evaluated_at);
    });

    it('passes the caller userId + role into the service', () => {
      controller.getFeatureFlags(makeReq('user-42', 'student'));
      expect(service.evaluate).toHaveBeenCalledWith({
        userId: 'user-42',
        role: 'student',
      });
    });

    it('emits feature_flags_evaluated telemetry with role + flag count', () => {
      controller.getFeatureFlags(makeReq('user-7', 'owner'));
      expect(telemetry.evaluated).toHaveBeenCalledWith('user-7', {
        role: 'owner',
        flag_count: FEATURE_FLAG_KEYS.length,
      });
    });
  });

  describe('route + throttle metadata (regression)', () => {
    it('mounts at me/feature-flags', () => {
      expect(Reflect.getMetadata(PATH_METADATA, FeatureFlagsController)).toBe(
        'me/feature-flags',
      );
    });

    it('GET handler with a 60/min throttle bucket', () => {
      const h = controller.getFeatureFlags;
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(THROTTLE_LIMIT_DEFAULT_KEY, h)).toBe(60);
      expect(Reflect.getMetadata(THROTTLE_TTL_DEFAULT_KEY, h)).toBe(60_000);
    });

    it('does not pin an explicit non-200 HTTP code (default 200 GET)', () => {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, controller.getFeatureFlags),
      ).toBeUndefined();
    });
  });

  describe('Zod strict response envelope', () => {
    it('rejects an extra top-level key', () => {
      expect(() =>
        FeatureFlagsResponseSchema.parse({
          flags: { community_search: true },
          evaluated_at: new Date().toISOString(),
          extra: 'nope',
        }),
      ).toThrow();
    });

    it('rejects a non-datetime evaluated_at', () => {
      expect(() =>
        FeatureFlagsResponseSchema.parse({
          flags: {},
          evaluated_at: 'not-a-date',
        }),
      ).toThrow();
    });

    it('rejects a non-boolean flag value', () => {
      expect(() =>
        FeatureFlagsResponseSchema.parse({
          flags: { community_search: 'yes' },
          evaluated_at: new Date().toISOString(),
        }),
      ).toThrow();
    });
  });
});
