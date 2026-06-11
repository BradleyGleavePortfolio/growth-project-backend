/**
 * community-events-flag.spec.ts — FEATURE_COMMUNITY_EVENTS kill switch +
 * scheduler flag-off invariance (v2-3).
 *
 * Required tests: flag-off invariance (the kill switch freezes the lifecycle,
 * not just write endpoints) and the write guard's 503 disabled envelope.
 */

import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CommunityEventsEnabledGuard,
  FEATURE_COMMUNITY_EVENTS,
  resolveEventsFlag,
} from '../../../src/community/events/community-events-flag.guard';
import { CommunityEventsScheduler } from '../../../src/community/events/community-events.scheduler';

describe('FEATURE_COMMUNITY_EVENTS flag (v2-3)', () => {
  const ORIGINAL = process.env[FEATURE_COMMUNITY_EVENTS];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FEATURE_COMMUNITY_EVENTS];
    else process.env[FEATURE_COMMUNITY_EVENTS] = ORIGINAL;
  });

  it('defaults OFF (absent env → false)', () => {
    delete process.env[FEATURE_COMMUNITY_EVENTS];
    expect(resolveEventsFlag()).toBe(false);
  });

  it('is OFF for any value other than the exact string "true"', () => {
    for (const v of ['1', 'TRUE', 'yes', 'on', '']) {
      process.env[FEATURE_COMMUNITY_EVENTS] = v;
      expect(resolveEventsFlag()).toBe(false);
    }
  });

  it('is ON only for "true"', () => {
    process.env[FEATURE_COMMUNITY_EVENTS] = 'true';
    expect(resolveEventsFlag()).toBe(true);
  });

  describe('write guard', () => {
    const guard = new CommunityEventsEnabledGuard();
    const ctx = {} as never;

    it('allows the request when the flag is on', () => {
      process.env[FEATURE_COMMUNITY_EVENTS] = 'true';
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws the typed 503 disabled envelope when off', () => {
      delete process.env[FEATURE_COMMUNITY_EVENTS];
      try {
        guard.canActivate(ctx);
        fail('expected guard to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const http = err as HttpException;
        expect(http.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
        expect(http.getResponse()).toMatchObject({
          disabled: true,
          error: 'community.disabled',
        });
      }
    });
  });

  describe('scheduler flag-off invariance', () => {
    it('does not promote anything while the flag is off (cron tick is a no-op)', async () => {
      delete process.env[FEATURE_COMMUNITY_EVENTS];
      const events = {
        runLivePromotion: jest.fn(async () => 0),
        runTomorrowPromotion: jest.fn(async () => 0),
      };
      const scheduler = new CommunityEventsScheduler(events as never);
      const prevNodeEnv = process.env.NODE_ENV;
      // The @Cron tick short-circuits in NODE_ENV=test, so temporarily clear it
      // to prove the FLAG (not the test env) is what freezes the lifecycle.
      process.env.NODE_ENV = 'development';
      try {
        await scheduler.tick();
      } finally {
        process.env.NODE_ENV = prevNodeEnv;
      }
      expect(events.runLivePromotion).not.toHaveBeenCalled();
      expect(events.runTomorrowPromotion).not.toHaveBeenCalled();
    });

    it('runOnce runs the live sweep before the tomorrow sweep', async () => {
      const order: string[] = [];
      const events = {
        runLivePromotion: jest.fn(async () => {
          order.push('live');
          return 1;
        }),
        runTomorrowPromotion: jest.fn(async () => {
          order.push('tomorrow');
          return 2;
        }),
      };
      const scheduler = new CommunityEventsScheduler(events as never);
      const stats = await scheduler.runOnce(new Date());
      expect(order).toEqual(['live', 'tomorrow']);
      expect(stats).toEqual({ promotedLive: 1, promotedTomorrow: 2 });
    });
  });
});
