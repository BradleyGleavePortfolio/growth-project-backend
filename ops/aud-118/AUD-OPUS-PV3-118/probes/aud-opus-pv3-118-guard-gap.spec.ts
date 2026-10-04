/**
 * AUD-OPUS-PV3-118 probe (never merge). Run together with
 * test/privacy/no-pii-in-logs.spec.ts on a branch that adds
 * src/observability/aud-opus-pv3-118-probe-sink.ts.
 *  - This spec fails: both shapes put the exception message (here an
 *    address echoed by a provider) into the log line.
 *  - The guard spec still passes: neither shape is counted, so a new
 *    exception-text site can land without the baseline changing.
 *  - The checkout-recovery cases fail: three log lines in a file the PR lists
 *    as printing no exception text still print the Redis error message.
 */
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AudOpusPv3ProbeSink } from '../../src/observability/aud-opus-pv3-118-probe-sink';

const ECHO = 'Email address "pat.client+tgp@example.com" is invalid';
const LEVELS = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;

function spyLogs(proto: typeof Logger.prototype = Logger.prototype): () => string {
  const spies = LEVELS.map((level) =>
    jest.spyOn(proto, level).mockImplementation(() => undefined),
  );
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls.map((args: unknown[]) => args.map((a) => String(a)).join(' ')))
      .join('\n');
}

afterEach(() => jest.restoreAllMocks());

describe('AUD-OPUS-PV3-118 C-700-6: exception text through shapes the guard does not count', () => {
  it('shape 1: `${userId}: ${err}` prints the message', () => {
    const logs = spyLogs();
    new AudOpusPv3ProbeSink().bareAfterId('user-1', new Error(ECHO));
    expect(logs()).toContain('user=user-1');
    expect(logs()).not.toContain('@');
  });

  it('shape 2: `const detail = err.message` then `${detail}` prints the message', () => {
    const logs = spyLogs();
    new AudOpusPv3ProbeSink().aliased(new Error(ECHO));
    expect(logs()).toContain('probe redis unavailable');
    expect(logs()).not.toContain('@');
  });
});

describe('AUD-OPUS-PV3-118 C-700-6: checkout-recovery still logs the Redis error message', () => {
  const MARK = 'PROBE-REDIS-TEXT';
  function config(): ConfigService {
    return {
      get: jest.fn((k: string) => {
        if (k === 'CHECKOUT_RECOVERY_SECRET') return 'x'.repeat(64);
        if (k === 'REDIS_URL') return 'redis://unreachable:6379';
        if (k === 'NODE_ENV') return 'development';
        return undefined;
      }),
    } as unknown as ConfigService;
  }

  it('connect failure in development (checkout-recovery.service.ts:178)', async () => {
    let CRS!: new (p: unknown, c: ConfigService) => { onModuleInit(): Promise<void> };
    // The service is loaded in an isolated registry, so its Logger is that
    // registry's class: spy on that one (harness fix after run 37224534728).
    let IsoLogger!: typeof Logger;
    jest.isolateModules(() => {
      jest.doMock('ioredis', () => {
        class FakeRedis {
          async connect(): Promise<void> {
            throw new Error(`${MARK} connect ECONNREFUSED 10.0.0.1:6379`);
          }
          disconnect(): void {}
        }
        return { __esModule: true, default: FakeRedis };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      CRS = require('../../src/storefront/checkout-recovery.service').CheckoutRecoveryService;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      IsoLogger = require('@nestjs/common').Logger;
    });
    const logs = spyLogs(IsoLogger.prototype);
    await new CRS({ guestCheckout: { findUnique: jest.fn() } }, config()).onModuleInit();
    expect(logs()).toContain('falling back to in-memory');
    expect(logs()).not.toContain(MARK);
  });

  it('quit failure on shutdown (checkout-recovery.service.ts:511)', async () => {
    let CRS!: new (p: unknown, c: ConfigService) => {
      onModuleInit(): Promise<void>;
      onModuleDestroy(): Promise<void>;
    };
    let IsoLogger!: typeof Logger;
    jest.isolateModules(() => {
      jest.doMock('ioredis', () => {
        class FakeRedis {
          async connect(): Promise<void> {}
          async quit(): Promise<void> {
            throw new Error(`${MARK} quit failed`);
          }
          disconnect(): void {}
        }
        return { __esModule: true, default: FakeRedis };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      CRS = require('../../src/storefront/checkout-recovery.service').CheckoutRecoveryService;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      IsoLogger = require('@nestjs/common').Logger;
    });
    const svc = new CRS({ guestCheckout: { findUnique: jest.fn() } }, config());
    await svc.onModuleInit();
    const logs = spyLogs(IsoLogger.prototype);
    await svc.onModuleDestroy();
    expect(logs()).toContain('forcing disconnect');
    expect(logs()).not.toContain(MARK);
  });
});
