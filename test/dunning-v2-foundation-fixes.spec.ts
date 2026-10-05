import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import Handlebars from 'handlebars';
import { effectiveLock } from '../src/checkout/dunning-v2/dunning-effective-access';
import {
  DispatchContext,
  DunningV2Dispatcher,
  dunningChannelsFor,
} from '../src/checkout/dunning-v2/dunning-v2.dispatcher';
import { DunningEscalationClassifier } from '../src/checkout/dunning-v2/dunning-escalation.classifier';
import { DunningV2Renderer } from '../src/checkout/dunning-v2/dunning-v2.renderer';
import { dunningErrorCode } from '../src/checkout/dunning-v2/dunning-v2.safe-error';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationsService } from '../src/notifications/notifications.service';
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
    fake.seed('dunningState', {
      id: 'ds-debt',
      purchase_id: 'debt',
      status: 'active',
      locked_out_at: NOW,
    });
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

  it.each([19, 20, 21, 60])(
    'a live $0 grant after %i locked alternatives waives the lock',
    async (n) => {
      expect(await effectiveLock(fixture(n), 'client-a', NOW)).toMatchObject({
        lockedPurchaseId: 'debt',
        waived: true,
        locked: false,
      });
    },
  );

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
      pushToUser: jest.fn(async () => ({ delivered: false, code: 'transport-error' })),
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
      createNotification: jest.fn(async (): Promise<unknown> => ({ id: 'n1' })),
      pushToUser: jest.fn(async (): Promise<unknown> => ({
        delivered: false,
        code: 'ticket-error',
      })),
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
    notifications.pushToUser.mockImplementation(async () => ({ delivered: true }));
    const retry = await d.dispatchStepDetailed(
      ctx(),
      undefined,
      stub({ channels: ['coach_push'], attempt: 1 }),
    );
    expect(stub(retry.results).coach_push?.status).toBe('sent');
    expect(retry.results.coach_alert).toBeUndefined();
    expect(inappWrites()).toBe(1);
    expect(notifications.pushToUser).toHaveBeenCalledTimes(2);
  });

  it('control: a successful coach delivery is sent on both transports', async () => {
    const notifications = {
      createNotification: jest.fn(async () => ({ id: 'n1' })),
      pushToUser: jest.fn(async () => ({ delivered: true })),
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

  it('a coach transport error whose class name is itself a secret is logged as a code', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const secretNamed = () => Object.assign(new Error(SENTINEL), { name: 'SYNTHETIC_SECRET_NAME' });
    const notifications = {
      createNotification: jest.fn(async () => {
        throw secretNamed();
      }),
      pushToUser: jest.fn(async () => {
        throw secretNamed();
      }),
    };
    const { d } = dispatcher(notifications);
    await d.dispatchStepDetailed(
      ctx(),
      undefined,
      stub({ channels: ['coach_alert', 'coach_push'] }),
    );
    const seen = JSON.stringify(warn.mock.calls);
    expect(warn).toHaveBeenCalled();
    expect(seen).not.toContain('SYNTHETIC_SECRET');
    expect(seen).not.toContain('person@tgp.invalid');
  });
});

describe('dunningErrorCode: a closed vocabulary, whatever the error carries', () => {
  class Custom extends Error {
    constructor() {
      super(SENTINEL);
      this.name = SENTINEL;
    }
  }
  it.each([
    [
      new StripeConnectApiError(SENTINEL, 402, 'card_declined', 'card_error'),
      'stripe_402_card_declined',
    ],
    [new StripeConnectApiError(SENTINEL, 500, SENTINEL, null), 'stripe_500'],
    [Object.assign(new Error(SENTINEL), { code: 'P2034' }), 'db_P2034'],
    [Object.assign(new Error(SENTINEL), { code: SENTINEL }), 'error'],
    [new TypeError(SENTINEL), 'error_typeerror'],
    [new Custom(), 'error_unknown'],
    [SENTINEL, 'error_unknown'],
    [null, 'error_unknown'],
  ])('%p -> %s', (err, code) => {
    expect(dunningErrorCode(err)).toBe(code);
  });
});

// B-DUNA-118 fix round (D1). Synthetic ids only; Expo is the only stub.
describe('B-687-3 (Sol) / C-687-7: the coach push receipt follows the Expo ticket', () => {
  afterEach(() => jest.restoreAllMocks());
  const run = async (token: string | null, ticket: object) => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const fake = new FakePrisma();
    fake.seed('user', { id: 'coach-a', expo_push_token: token });
    const notifications = new NotificationsService(stub(fake.client()));
    const expo = Reflect.get(notifications, 'expo');
    jest.spyOn(expo, 'chunkPushNotifications').mockImplementation((m) => [m]);
    const send = jest.spyOn(expo, 'sendPushNotificationsAsync').mockResolvedValue([ticket]);
    jest.spyOn(expo, 'chunkPushNotificationReceiptIds').mockReturnValue([]);
    const out = await dispatcher(notifications).d.dispatchStepDetailed(ctx(), undefined, {
      channels: ['coach_push'],
    });
    return { result: out.results.coach_push, msg: stub(send.mock.calls[0]?.[0])?.[0] };
  };
  it('a rejected ticket is failed (retried); no token is a coded skip', async () => {
    const error = await run('ExponentPushToken[a]', { status: 'error', message: 'x' });
    expect(error.result).toEqual({ status: 'failed', error: 'push_ticket-error' });
    expect((await run(null, {})).result).toEqual({ status: 'skipped', error: 'push_no_token' });
  });
  it('control: an accepted ticket is sent, with display copy, not the alert type', async () => {
    const { result, msg } = await run('ExponentPushToken[a]', { status: 'ok', id: 't' });
    expect(result?.status).toBe('sent');
    expect(msg.body).toContain('Avery Client');
    expect(JSON.stringify(msg)).not.toMatch(/"(title|body)":"[^"]*dunning_step/);
  });
});

/** Every client and coach surface of one step, as the user sees it. */
async function renderStep(over: Partial<DispatchContext>): Promise<string> {
  const seen: string[] = [];
  const hbs = (name: string) => readFileSync(join(ROOT, 'src/email/templates', `${name}.hbs`));
  const record = async (text: string, ret: unknown) => (seen.push(text), ret);
  const notifications = {
    pushToUser: (_u: string, _t: string, body: string) => record(body, { delivered: true }),
    createNotification: (n: { body?: string; payload?: object }) =>
      record(`${n.body} ${JSON.stringify(n.payload ?? {})}`, { id: 'n1' }),
  };
  const email = {
    send: (m: { template: string; data: { subject?: string } }) =>
      record(
        // The subject is part of what the client sees (B-687-8).
        `${m.data.subject ?? ''}\n${Handlebars.compile(String(hbs(m.template)))(m.data).replace(/<[^>]*>/g, ' ')}`,
        { status: 'sent' },
      ),
  };
  const channels = ['client_push', 'client_email', 'client_blocker', 'coach_alert'];
  const all = stub({ channels: [...channels, 'coach_push', 'coach_email'] });
  await dispatcher(notifications, email).d.dispatchStepDetailed(ctx(over), undefined, all);
  return seen.join('\n');
}

describe('B-687-4 (Sol) / B-687-5 (Opus) / C-687-6: copy claims nothing before it is true', () => {
  it.each([0, 1, 2, 3])('dispute cycle step %i: no card or cancel promise', async (stepIndex) => {
    const text = await renderStep({ stepIndex, isLateReversalCycle: true });
    expect(text).toMatch(/dispute/);
    // R-DISPUTE-PAUSE: access has ended, billing is paused, the coach decides.
    expect(text).toMatch(/Access has ended and billing (for the plan )?is paused/);
    expect(text).toMatch(/Restarting it is up to Morgan Coach/);
    // Step 3 adds the coach channels: the coach is told the restart is theirs.
    if (stepIndex === 3) expect(text).toMatch(/Restarting is your decision/);
    expect(text).not.toMatch(
      /stays on|restore|keep everything|will settle it|paid with it|End my plan|Update card|pauses on|locks/i,
    );
    expect(text).not.toMatch(/attempt|declined|failed/i);
  });
  it('payment cycle: a card update is a charge; access follows once it goes through', async () => {
    const text = await renderStep({ stepIndex: 3 });
    expect(text).not.toMatch(/amount owed is paid with it|four times|attempted it|three times/);
    expect(text).toMatch(/once that payment goes through, your access stays on/);
    expect(text).toMatch(/nothing more is charged, and access ends right away/);
  });
});

describe('B-687-8 (Opus) / C-687-9: dispute copy is true for an inquiry too', () => {
  it.each([0, 1, 2, 3])(
    'dispute cycle step %i: no reversal claim, names a dispute or inquiry',
    async (stepIndex) => {
      // Owner ruling 6 (10-05): an inquiry pauses the plan, and an inquiry moves no money.
      const text = await renderStep({ stepIndex, isLateReversalCycle: true });
      expect(text).not.toMatch(/revers/i);
      expect(text).toMatch(/dispute or inquiry/);
    },
  );
  it('the dispute email subject makes no reversal claim', async () => {
    const texts = await Promise.all(
      [0, 1, 2, 3].map((stepIndex) => renderStep({ stepIndex, isLateReversalCycle: true })),
    );
    expect(texts.join('\n')).toMatch(/Your plan is paused after a payment dispute or inquiry/);
  });
  it.each([0, 1, 2, 3])(
    'step %i: the lower-case coach fallback never starts a sentence',
    async (stepIndex) => {
      const tokens = { firstName: 'Avery', clientName: 'Avery Client', coachName: 'your coach' };
      const text = await renderStep({ stepIndex, isLateReversalCycle: true, tokens });
      expect(text).toMatch(/up to your coach/);
      expect(text).not.toMatch(/(^|[.?]\s+)your coach/m);
    },
  );
});

describe('B-688-7 (Opus): no surface shows a raw token', () => {
  afterEach(() => jest.restoreAllMocks());
  const tokens = { firstName: 'Avery', clientName: 'Avery Client', coachName: 'Morgan Coach' };
  it.each([0, 1, 2, 3])('step %i, both kinds and variants, no card / amount', async (stepIndex) => {
    for (const lr of [false, true]) {
      for (const quip of [0, 1]) {
        jest.spyOn(Math, 'random').mockReturnValue(quip);
        const text = await renderStep({ stepIndex, isLateReversalCycle: lr, tokens });
        expect(text).not.toMatch(/\{\w+\}|ends \.|of {2}/);
        expect(text).not.toMatch(/so far: *$/m);
      }
    }
  });
});

describe('Sol B-688-7 support: the fake sorts like PostgreSQL', () => {
  it('plain desc puts nulls first, asc puts them last, `nulls` overrides', async () => {
    const fake = new FakePrisma();
    fake.seed('dunningState', { id: 'a', locked_out_at: null });
    fake.seed('dunningState', { id: 'b', locked_out_at: NOW });
    const rows = (orderBy: object) => stub(fake.client()).dunningState.findMany({ orderBy });
    const ids = async (orderBy: object) => (await rows(orderBy)).map((r: { id: string }) => r.id);
    expect(await ids({ locked_out_at: 'desc' })).toEqual(['a', 'b']);
    expect(await ids({ locked_out_at: { sort: 'desc', nulls: 'last' } })).toEqual(['b', 'a']);
  });
});
