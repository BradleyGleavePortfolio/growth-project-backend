// test/coach-brief-enabled.guard.spec.ts
//
// P1-2 \u2014 prove the Coach Brief server-side kill switch works end-to-end:
// when COACH_BRIEF_ENABLED=off, the guard returns 404 for EVERY method of
// the controller (covering the contract \"every route while off\" from the
// finding). Also prove that on/absent/typo cases behave correctly.

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CoachBriefEnabledGuard,
  coachBriefEnabled,
} from '../src/coach/brief/coach-brief-enabled.guard';

function makeConfig(value: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'COACH_BRIEF_ENABLED' ? value : undefined,
    ),
  } as unknown as ConfigService;
}

function makeCtx(): import('@nestjs/common').ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({}),
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getType: () => 'http' as never,
  } as unknown as import('@nestjs/common').ExecutionContext;
}

describe('coachBriefEnabled helper', () => {
  it('returns true when the var is absent (default-on contract)', () => {
    expect(coachBriefEnabled(makeConfig(undefined))).toBe(true);
  });

  it('returns true when set to "on"', () => {
    expect(coachBriefEnabled(makeConfig('on'))).toBe(true);
  });

  it('returns false ONLY for the literal "off" value (case-insensitive)', () => {
    expect(coachBriefEnabled(makeConfig('off'))).toBe(false);
    expect(coachBriefEnabled(makeConfig('OFF'))).toBe(false);
    expect(coachBriefEnabled(makeConfig(' off '))).toBe(false);
  });

  it('treats unrecognised values as on so a typo does not silently disable', () => {
    // Note: the env-validation rule rejects non-on/off values at boot.
    // The helper itself fails open for runtime robustness so a hand-edited
    // var cannot accidentally take the feature down without a boot error.
    expect(coachBriefEnabled(makeConfig('false'))).toBe(true);
    expect(coachBriefEnabled(makeConfig('disabled'))).toBe(true);
  });
});

describe('CoachBriefEnabledGuard', () => {
  it('allows requests when the var is absent', () => {
    const guard = new CoachBriefEnabledGuard(makeConfig(undefined));
    expect(guard.canActivate(makeCtx())).toBe(true);
  });

  it('allows requests when the var is "on"', () => {
    const guard = new CoachBriefEnabledGuard(makeConfig('on'));
    expect(guard.canActivate(makeCtx())).toBe(true);
  });

  it('throws NotFoundException when COACH_BRIEF_ENABLED=off', () => {
    const guard = new CoachBriefEnabledGuard(makeConfig('off'));
    expect(() => guard.canActivate(makeCtx())).toThrow(NotFoundException);
  });

  it('uses a generic 404 message that does not leak feature state (R17)', () => {
    const guard = new CoachBriefEnabledGuard(makeConfig('off'));
    try {
      guard.canActivate(makeCtx());
      fail('expected guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      const msg = (err as NotFoundException).message;
      // Must not include the feature name or any env-var name.
      expect(msg.toLowerCase()).not.toContain('coach');
      expect(msg.toLowerCase()).not.toContain('brief');
      expect(msg.toLowerCase()).not.toContain('disabled');
      expect(msg).toBe('Not Found');
    }
  });
});

// Contract: every route on the controller is blocked when off. We assert
// this at the guard level (the guard is class-scoped, so a single 404
// covers every method) and then sanity-check by walking the prototype.
describe('CoachBriefEnabledGuard \u2014 every Coach Brief route is blocked while off', () => {
  it('the controller has the kill-switch guard at the class level so all 8 routes are gated', async () => {
    const { CoachBriefController } = await import(
      '../src/coach/brief/coach-brief.controller'
    );
    const { GUARDS_METADATA } = await import('@nestjs/common/constants');
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CoachBriefController,
    ) as unknown as Array<new (...args: unknown[]) => unknown>;
    expect(guards[0]).toBe(CoachBriefEnabledGuard);

    // Sanity-check: at least 8 handler methods exist on the prototype
    // (today, history, regenerate, log/today GET+PUT, log/history,
    // preferences GET+PUT) and all are class-scoped under the same guard.
    const proto = CoachBriefController.prototype as object;
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (k) => k !== 'constructor',
    );
    expect(handlers.length).toBeGreaterThanOrEqual(8);
  });
});
