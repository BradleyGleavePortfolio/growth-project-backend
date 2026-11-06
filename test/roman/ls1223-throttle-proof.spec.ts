/** LS-1223 test-only evidence using the shipped global guard and route metadata. */
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { RomanMessageReportController } from '../../src/roman/roman-message-report.controller';
import { THROTTLER_LIMITS } from '../../src/throttler/throttler.config';
import { UserThrottlerGuard } from '../../src/throttler/user-throttler.guard';

describe('LS-1223 report throttle at the real guard boundary', () => {
  let storage: ThrottlerStorageService;
  let guard: UserThrottlerGuard;
  const header = jest.fn();

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    guard = new UserThrottlerGuard(
      { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) }, storage, new Reflector(),
    );
    await guard.onModuleInit();
    header.mockClear();
  });
  afterEach(() => storage.onApplicationShutdown());

  function context(user: string, message = 'reply-A'): ExecutionContext {
    const req = {
      route: { path: '/roman/messages/:id/report' },
      url: `/roman/messages/${message}/report`,
      params: { id: message },
      user: { id: user },
      ip: '192.0.2.1',
      headers: { 'fly-client-ip': '192.0.2.1' },
    };
    return new ExecutionContextHost(
      [req, { header, setHeader: header }, undefined],
      RomanMessageReportController,
      RomanMessageReportController.prototype.report,
    );
  }

  async function twenty(user: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await expect(guard.canActivate(context(user, `reply-${i}`))).resolves.toBe(true);
    }
  }

  it('permits 20 and returns 429 on 21 even when message ids rotate', async () => {
    await twenty('client-A');
    try {
      await guard.canActivate(context('client-A', 'a-new-reply'));
      throw new Error('The 21st report unexpectedly passed');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
    }
  });

  it('gives another signed-in user on the same IP an independent 20', async () => {
    await twenty('client-A');
    await twenty('client-B');
  });

  it('uses the full 3600-second report window rather than the global short window', async () => {
    await guard.canActivate(context('client-A'));
    const reset = header.mock.calls.find(([name]) => name === 'X-RateLimit-Reset');
    expect(reset).toBeDefined();
    expect(Number(reset![1])).toBeGreaterThanOrEqual(3599);
    expect(Number(reset![1])).toBeLessThanOrEqual(3600);
  });
});
