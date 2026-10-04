import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { effectiveLock } from '../src/checkout/dunning-v2/dunning-effective-access';
import {
  DispatchContext,
  DunningV2Dispatcher,
  dunningChannelsFor,
} from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { FakePrisma } from './support/dunning-v2-fake-prisma';

// B-D12-116 fix round on #687 (D1). Synthetic ids and sentinels only.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stub = (v: unknown): any => v;
const NOW = new Date('2026-10-04T02:30:00.000Z');
const ROOT = join(__dirname, '..');
const SENTINEL = 'person@tgp.invalid token=SYNTHETIC_SECRET body=SYNTHETIC_BODY';

function telemetry() {
  return {
    attemptFailed: jest.fn(),
    notifySent: jest.fn(),
    blockerShown: jest.fn(),
    coachNotified: jest.fn(),
  };
}

function ctx(over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    dunningStateId: 'ds-1',
    cycleKey: String(NOW.getTime()),
    stepIndex: 3,
    isLateReversalCycle: false,
    clientUserId: 'client-a',
    coachUserId: 'coach-a',
    clientEmail: 'client@tgp.invalid',
    coachEmail: 'coach@tgp.invalid',
    tokens: {
      firstName: 'Avery',
      clientName: 'Avery Client',
      coachName: 'Morgan Coach',
      amount: '$150.00',
      lockoutDate: 'October 14',
    },
    dunningDetailDeeplink: 'tgp://coach/clients/client-a',
    ...over,
  };
}

function dispatcher(notifications: unknown, email?: unknown, emitter?: unknown) {
  const t = telemetry();
  const d = new DunningV2Dispatcher(
    new DunningEscalationClassifier(),
    new DunningV2Renderer(),
    stub(t),
    stub(notifications),
    stub(email),
    stub(emitter ?? new CoachAlertEmitter(stub(notifications))),
  );
  return { d, t };
}

describe('B-687-1 (Sol): effective access is not decided from a truncated page', () => {
  function fixture(blocked: number, grantOwner = 'client-a') {
    const fake = new FakePrisma();
    fake.seed('clientPurchase', { id: 'debt', client_user_id: 'client-a' });
    fake.seed('dunningState', { id: 'ds-debt', purchase_id: 'debt', status: 'active', locked_out_at: NOW });
    for (let i = 0; i < blocked; i++) {
      fake.seed('clientPurchase', {
        id: `blocked-${i}`,
        client_user_id: 'client-a',
        entitlement_active: true,
        status: 'active',
        access_expires_at: null,
      });
      fake.seed('dunningState', {
        id: `ds-blocked-${i}`,
        purchase_id: `blocked-${i}`,
        status: 'active',
        locked_out_at: NOW,
      });
    }
    fake.seed('clientPurchase', {
      id: 'free-grant',
      client_user_id: grantOwner,
      entitlement_active: true,
      status: 'paid',
      access_expires_at: null,
      amount_cents: 0,
    });
    return fake.client();
  }

  it.each([19, 20, 21, 60])('a live $0 grant after %i locked alternatives waives the lock', async (n) => {
    expect(await effectiveLock(fixture(n), 'client-a', NOW)).toMatchObject({
      lockedPurchaseId: 'debt',
      waived: true,
      locked: false,
    });
  });

  it('control: only locked alternatives (or another client grant) never waive', async () => {
    expect(await effectiveLock(fixture(25, 'client-b'), 'client-a', NOW)).toMatchObject({
      waived: false,
      locked: true,
    });
  });
});

describe('B-687-2 (Sol), operator ruling OR-113-4: the pending prefix has no dependency-order defect', () => {
  // OR-113-4: pending migration prefixes keep their numbers unless a migration
  // references an object a later-sorting migration creates. This pins that the
  // dunning migration only references objects created before it, and that no
  // later-sorting migration touches the objects it creates.
  const dir = join(ROOT, 'prisma', 'migrations');
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
    .map((d) => d.name)
    .sort();
  const mine = dirs.find((d) => d.endsWith('_dunning_billing_actions')) as string;
  const sql = (d: string) => readFileSync(join(dir, d, 'migration.sql'), 'utf8');
  const creates = (d: string) =>
    [...sql(d).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"/g)].map((m) => m[1]);

  it('every referenced table is created by an earlier-sorting migration', () => {
    const refs = new Set(
      [...sql(mine).matchAll(/(?:REFERENCES|ALTER TABLE) "(\w+)"/g)].map((m) => m[1]),
    );
    const own = new Set(creates(mine));
    for (const t of refs) {
      if (own.has(t)) continue;
      const by = dirs.filter((d) => creates(d).includes(t));
      expect(by.length).toBeGreaterThan(0);
      expect(by.every((d) => d < mine)).toBe(true);
    }
  });

  it('no later-sorting migration touches a table it creates', () => {
    const own = creates(mine);
    expect(own.length).toBeGreaterThan(0);
    for (const d of dirs.filter((x) => x > mine)) {
      for (const t of own) expect(sql(d)).not.toContain(`"${t}"`);
    }
  });
});

describe('B-687-1 (Opus) / C-687-1 (Sol): dunning email copy has no first person', () => {
  it.each(['dunning-v2-client.hbs', 'dunning-v2-coach.hbs'])('%s', (file) => {
    const html = readFileSync(join(ROOT, 'src', 'email', 'templates', file), 'utf8');
    const text = html.replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');
    expect(text).not.toMatch(/\b(we|our|ours|us)\b/i);
    expect(text).not.toContain('!');
    // A real support path stays in the client email.
    if (file === 'dunning-v2-client.hbs') expect(text).toMatch(/Reply to this email/);
  });
});

describe('B-688-3 (Sol): coach delivery reports each transport honestly', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('the Day-7 step has separate coach in-app, push and email deliveries', () => {
    const decision = new DunningEscalationClassifier().resolve({
      stepIndex: 3,
      isLateReversalCycle: false,
    });
    expect(dunningChannelsFor(decision)).toEqual(
      expect.arrayContaining(['coach_alert', 'coach_push', 'coach_email']),
    );
  });

  it('a failed feed write and a failed push are failed (retryable), never sent', async () => {
    const notifications = {
      createNotification: jest.fn(async () => {
        throw new Error('synthetic DB failure');
      }),
      pushToCoach: jest.fn(async () => false),
    };
    const { d, t } = dispatcher(notifications);
    const { results } = await d.dispatchStepDetailed(
      ctx(),
      undefined,
      stub({ channels: ['coach_alert', 'coach_push'] }),
    );
    expect(results.coach_alert?.status).toBe('failed');
    expect(stub(results).coach_push?.status).toBe('failed');
    expect(t.coachNotified).not.toHaveBeenCalled();
  });

  it('a retry of the failed push does not write a second coach feed row', async () => {
    const notifications = {
      createNotification: jest.fn(async () => ({ id: 'n1' })),
      pushToCoach: jest.fn(async () => false),
    };
    const { d } = dispatcher(notifications);
    const first = await d.dispatchStepDetailed(
      ctx(),
      undefined,
      stub({ channels: ['coach_alert', 'coach_push'] }),
    );
    expect(first.results.coach_alert?.status).toBe('sent');
    expect(stub(first.results).coach_push?.status).toBe('failed');
    const inappWrites = () =>
      notifications.createNotification.mock.calls.filter(
        (c: unknown[]) => (c[0] as { channel?: string }).channel === 'inapp',
      ).length;
    expect(inappWrites()).toBe(1);
    notifications.pushToCoach.mockImplementation(async () => true);
    const retry = await d.dispatchStepDetailed(
      ctx(),
      undefined,
      stub({ channels: ['coach_push'], attempt: 1 }),
    );
    expect(stub(retry.results).coach_push?.status).toBe('sent');
    expect(retry.results.coach_alert).toBeUndefined();
    expect(inappWrites()).toBe(1);
    expect(notifications.pushToCoach).toHaveBeenCalledTimes(2);
  });

  it('control: a successful coach delivery is sent on both transports', async () => {
    const notifications = {
      createNotification: jest.fn(async () => ({ id: 'n1' })),
      pushToCoach: jest.fn(async () => true),
    };
    const { d, t } = dispatcher(notifications);
    const { results } = await d.dispatchStepDetailed(
      ctx(),
      undefined,
      stub({ channels: ['coach_alert', 'coach_push'] }),
    );
    expect(results.coach_alert?.status).toBe('sent');
    expect(stub(results).coach_push?.status).toBe('sent');
    expect(t.coachNotified).toHaveBeenCalledTimes(1);
  });
});

describe('B-688-4 (Sol): transport failures cross the log / outbox boundary as codes only', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a provider email error and a thrown push error never reach the result or the logs', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const notifications = {
      pushToUser: jest.fn(async () => {
        throw new Error(SENTINEL);
      }),
      createNotification: jest.fn(async () => ({ id: 'n1' })),
      pushToCoach: jest.fn(async () => true),
    };
    const email = { send: jest.fn(async () => ({ status: 'failed', error: SENTINEL })) };
    const { d } = dispatcher(notifications, email);
    const { results } = await d.dispatchStepDetailed(ctx({ stepIndex: 1 }), undefined, {
      channels: ['client_push', 'client_email'],
    });
    expect(results.client_push?.status).toBe('failed');
    expect(results.client_email?.status).toBe('failed');
    const seen = JSON.stringify([results, warn.mock.calls, error.mock.calls]);
    expect(seen).not.toContain('SYNTHETIC_SECRET');
    expect(seen).not.toContain('SYNTHETIC_BODY');
    expect(seen).not.toContain('person@tgp.invalid');
    for (const r of Object.values(results)) expect(r?.error).toMatch(/^[a-z0-9_]+$/);
  });
});
