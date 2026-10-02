import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CoachWelcomeService,
  __coachWelcomeConsts,
} from '../../src/engagement/coach-welcome.service';
import { DEFAULT_WELCOME_TEMPLATE, WELCOME_DELAY_MS } from '../../src/engagement/welcome-template';
import type { PrismaService } from '../../src/prisma.service';
import type { MessagingService } from '../../src/messaging/messaging.service';
import type { MessagesSafetyService } from '../../src/messages-safety/messages-safety.service';
import { cast, FakeTable, matches } from './_fake-db';

// C05 item 6 — durable, idempotent coach welcome message.

const COACH = 'coach-1';
const CLIENT = 'client-1';
const T0 = new Date('2026-10-05T17:00:00.000Z'); // onboarding completed_at
const MIN = 60_000;

function harness() {
  const users = new FakeTable([['id']]);
  const intakes = new FakeTable([['client_id']]);
  const settings = new FakeTable([['coach_id']], () => ({
    enabled: false,
    template: null,
    enabled_at: null,
  }));
  const jobs = new FakeTable([['client_id'], ['message_id']], () => ({
    status: 'pending',
    reason: null,
    rendered_body: null,
    message_id: null,
    attempt_count: 0,
    next_retry_at: null,
    locked_at: null,
    lease_token: null,
    sent_at: null,
  }));
  // CoachMessage.welcome_job_id is @unique (B-609-3), like the real table.
  const messages = new FakeTable([['welcome_job_id']]);
  const userMatches = (id: unknown, filter: unknown): boolean => {
    const u = users.rows.find((x) => x.id === id);
    return !!u && matches(u, filter as Record<string, unknown>);
  };
  intakes.relations.client = (row, f) => {
    const { coach_welcome_job, ...userFilter } = f as {
      coach_welcome_job?: { is: null };
    } & Record<string, unknown>;
    if (coach_welcome_job && jobs.rows.some((j) => j.client_id === row.client_id)) return false;
    return userMatches(row.client_id, userFilter);
  };
  jobs.relations.client = (row, f) => userMatches(row.client_id, f);
  jobs.relations.coach = (row, f) => userMatches(row.coach_id, f);
  settings.relations.coach = (row, f) => userMatches(row.coach_id, f);
  const blocks = new Set<string>();
  const prisma = {
    user: users,
    clientOnboardingIntake: intakes,
    coachWelcomeMessageSetting: settings,
    coachWelcomeMessageJob: jobs,
    coachMessage: messages,
  };
  // Mirrors MessagingService.sendAsCoach: the welcome_job_id key is written
  // with the row; a duplicate key returns the existing row and produces no
  // side effects (sideEffects counts the ping/push/audit fan-out).
  const sideEffects = { count: 0 };
  const sendAsCoach = jest.fn(
    async (
      coachId: string,
      clientId: string,
      payload: { body: string },
      options: { welcomeJobId?: string } = {},
    ) => {
      const client = users.rows.find((u) => u.id === clientId);
      if (!client || client.coach_id !== coachId) throw new NotFoundException('Client not found');
      if (blocks.has(`${coachId}:${clientId}`)) throw new ForbiddenException({ error: 'BLOCKED' });
      try {
        const row = await messages.create({
          data: {
            coach_id: coachId,
            client_id: clientId,
            sender_id: coachId,
            body: payload.body,
            welcome_job_id: options.welcomeJobId ?? null,
          },
        });
        sideEffects.count += 1;
        return row;
      } catch (err) {
        const existing = options.welcomeJobId
          ? await messages.findUnique({ where: { welcome_job_id: options.welcomeJobId } })
          : null;
        if (existing) return existing;
        throw err;
      }
    },
  );
  const safety = {
    isEitherSideBlocked: jest.fn(
      async (a: string, b: string) => blocks.has(`${a}:${b}`) || blocks.has(`${b}:${a}`),
    ),
  };
  const make = () =>
    new CoachWelcomeService(
      cast<PrismaService>(prisma),
      cast<MessagingService>({ sendAsCoach }),
      cast<MessagesSafetyService>(safety),
    );
  return { users, intakes, settings, jobs, messages, blocks, sendAsCoach, safety, make, sideEffects };
}

async function seed(
  h: ReturnType<typeof harness>,
  opts: { enabled?: boolean; template?: string | null; enabledAt?: Date } = {},
) {
  await h.users.create({
    data: {
      id: COACH,
      name: 'Morgan Reyes',
      role: 'coach',
      coach_id: null,
      deleted_at: null,
      deletion_scheduled_at: null,
    },
  });
  await h.users.create({
    data: {
      id: CLIENT,
      name: 'Dana Lee',
      role: 'student',
      coach_id: COACH,
      deleted_at: null,
      deletion_scheduled_at: null,
    },
  });
  await h.intakes.create({ data: { client_id: CLIENT, completed_at: T0 } });
  if (opts.enabled !== false) {
    await h.settings.create({
      data: {
        coach_id: COACH,
        enabled: true,
        template: opts.template ?? null,
        enabled_at: opts.enabledAt ?? new Date(T0.getTime() - 24 * 60 * MIN),
      },
    });
  }
}

describe('CoachWelcomeService — scheduling', () => {
  it('schedules exactly one job at completed_at + 13 minutes and sends nothing early', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    const s1 = await svc.runOnce(new Date(T0.getTime() + MIN));
    expect(s1.scheduled).toBe(1);
    expect(h.jobs.rows).toHaveLength(1);
    expect((h.jobs.rows[0].fire_at as Date).getTime()).toBe(T0.getTime() + WELCOME_DELAY_MS);
    expect(WELCOME_DELAY_MS).toBe(13 * MIN);
    await svc.runOnce(new Date(T0.getTime() + 12 * MIN + 59_000));
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('sends one message from the coach into the thread at +13 minutes', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    const s = await svc.runOnce(new Date(T0.getTime() + 13 * MIN));
    expect(s.sent).toBe(1);
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1);
    expect(h.sendAsCoach).toHaveBeenCalledWith(
      COACH,
      CLIENT,
      {
        body: "Hi Dana, it's Morgan. Welcome in. Your plan and targets are ready. Message me here anytime.",
      },
      { welcomeJobId: h.jobs.rows[0].id },
    );
    expect(h.messages.rows).toHaveLength(1);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'sent', message_id: h.messages.rows[0].id });
  });

  it('never sends twice: repeated ticks, double scheduling and a restarted instance', async () => {
    const h = harness();
    await seed(h);
    const a = h.make();
    const b = h.make(); // second replica / process after restart
    await a.runOnce(new Date(T0.getTime() + MIN));
    await b.runOnce(new Date(T0.getTime() + 2 * MIN));
    expect(h.jobs.rows).toHaveLength(1);
    // a direct second schedule (e.g. replayed complete) hits the unique key
    expect(await a.scheduleOne(CLIENT, T0)).toBe('exists');
    await a.runOnce(new Date(T0.getTime() + 14 * MIN));
    await b.runOnce(new Date(T0.getTime() + 15 * MIN));
    await a.runOnce(new Date(T0.getTime() + 60 * MIN));
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1);
    expect(h.messages.rows).toHaveLength(1);
  });

  it('job state survives a restart: scheduled by one instance, delivered by a fresh one', async () => {
    const h = harness();
    await seed(h);
    await h.make().runOnce(new Date(T0.getTime() + MIN));
    const fresh = h.make();
    const s = await fresh.runOnce(new Date(T0.getTime() + 20 * MIN));
    expect(s.sent).toBe(1);
  });

  it('coach flag off (default) -> job recorded as skipped, nothing sent', async () => {
    const h = harness();
    await seed(h, { enabled: false });
    const svc = h.make();
    const s = await svc.runOnce(new Date(T0.getTime() + MIN));
    expect(s.skipped).toBe(1);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'skipped', reason: 'coach_disabled' });
    await svc.runOnce(new Date(T0.getTime() + 30 * MIN));
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('a client who completed before the flag was turned on is not welcomed retroactively', async () => {
    const h = harness();
    await seed(h, { enabledAt: new Date(T0.getTime() + 5 * MIN) });
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + 6 * MIN));
    expect(h.jobs.rows[0].status).toBe('skipped');
    await svc.runOnce(new Date(T0.getTime() + 30 * MIN));
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('intakes completed outside the lookback window are not scheduled', async () => {
    const h = harness();
    await seed(h);
    const late = new Date(T0.getTime() + __coachWelcomeConsts.SCHEDULE_LOOKBACK_MS + MIN);
    await h.make().runOnce(late);
    expect(h.jobs.rows).toHaveLength(0);
  });

  it('C-609-3: a full batch of older coachless intakes never starves a newer coached completion', async () => {
    const h = harness();
    await seed(h);
    const { TICK_BATCH_SIZE } = __coachWelcomeConsts;
    for (let i = 0; i < TICK_BATCH_SIZE + 5; i += 1) {
      const id = `coachless-${i}`;
      await h.users.create({
        data: {
          id,
          name: `Member ${i}`,
          role: 'student',
          coach_id: null,
          deleted_at: null,
          deletion_scheduled_at: null,
        },
      });
      // Completed before CLIENT, so oldest-first ordering puts them first.
      await h.intakes.create({
        data: { client_id: id, completed_at: new Date(T0.getTime() - (i + 1) * MIN) },
      });
    }
    const s = await h.make().runOnce(new Date(T0.getTime() + MIN));
    expect(s.scheduled).toBe(1);
    expect(h.jobs.rows.map((j) => j.client_id)).toEqual([CLIENT]);
  });

  it('uses the per-coach template with both placeholders', async () => {
    const h = harness();
    await seed(h, { template: 'Hello {first_name}. {coach_first_name} here.' });
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    await svc.runOnce(new Date(T0.getTime() + 13 * MIN));
    expect(h.messages.rows[0].body).toBe('Hello Dana. Morgan here.');
  });

  it('the shipped default template names no clinic and no coach', () => {
    expect(DEFAULT_WELCOME_TEMPLATE).toBe(
      "Hi {first_name}, it's {coach_first_name}. Welcome in. Your plan and targets are ready. Message me here anytime.",
    );
  });
});

describe('CoachWelcomeService — cancellation', () => {
  async function scheduled() {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    return { h, svc };
  }
  const FIRE = new Date(T0.getTime() + 13 * MIN);

  it('client deleted (account tombstoned) -> the job is erased before dispatch and nothing is sent', async () => {
    const { h, svc } = await scheduled();
    h.users.rows[1].deleted_at = new Date(T0.getTime() + 5 * MIN);
    const s = await svc.runOnce(FIRE);
    expect(s.sent).toBe(0);
    expect(h.jobs.rows).toHaveLength(0);
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('client deleted while the erasure sweep is down -> the send-time check still cancels (and clears the body)', async () => {
    const { h, svc } = await scheduled();
    h.users.rows[1].deleted_at = new Date(T0.getTime() + 5 * MIN);
    jest.spyOn(h.jobs, 'deleteMany').mockRejectedValue(new Error('db unavailable'));
    const s = await svc.runOnce(FIRE);
    expect(s.cancelled).toBe(1);
    expect(h.jobs.rows[0]).toMatchObject({
      status: 'cancelled',
      reason: 'client_deleted',
      rendered_body: null,
    });
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('client scheduled for deletion -> cancelled', async () => {
    const { h, svc } = await scheduled();
    h.users.rows[1].deletion_scheduled_at = new Date(T0.getTime() + 5 * MIN);
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0].reason).toBe('client_deleted');
  });

  it('client row gone (hard delete) -> cancelled', async () => {
    const { h, svc } = await scheduled();
    h.users.rows.splice(1, 1);
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'cancelled', reason: 'client_deleted' });
  });

  it('client detached from the coach -> cancelled', async () => {
    const { h, svc } = await scheduled();
    h.users.rows[1].coach_id = null;
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'cancelled', reason: 'detached' });
  });

  it('client moved to another coach -> cancelled', async () => {
    const { h, svc } = await scheduled();
    h.users.rows[1].coach_id = 'coach-2';
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0].reason).toBe('detached');
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('client blocked the coach -> cancelled (checked before send)', async () => {
    const { h, svc } = await scheduled();
    h.blocks.add(`${CLIENT}:${COACH}`);
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'cancelled', reason: 'blocked' });
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('block that lands between the check and the send (403 from messaging) -> cancelled, not retried', async () => {
    const { h, svc } = await scheduled();
    h.safety.isEitherSideBlocked.mockResolvedValueOnce(false);
    h.blocks.add(`${COACH}:${CLIENT}`);
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'cancelled', reason: 'blocked' });
  });

  it('coach flag turned off after scheduling -> cancelled', async () => {
    const { h, svc } = await scheduled();
    h.settings.rows[0].enabled = false;
    await svc.runOnce(FIRE);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'cancelled', reason: 'coach_disabled' });
  });

  it('more than 24h late (long outage) -> cancelled as expired, never sent late', async () => {
    const { h, svc } = await scheduled();
    await svc.runOnce(new Date(FIRE.getTime() + __coachWelcomeConsts.MAX_LATENESS_MS + MIN));
    expect(h.jobs.rows[0]).toMatchObject({ status: 'cancelled', reason: 'expired' });
  });
});

describe('CoachWelcomeService — retries without duplicates', () => {
  it('transient send failure -> retried with backoff, then delivered once', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    h.sendAsCoach.mockRejectedValueOnce(new Error('db blip'));
    const s1 = await svc.runOnce(new Date(T0.getTime() + 13 * MIN));
    expect(s1.retried).toBe(1);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'pending', attempt_count: 1 });
    // within backoff: nothing
    await svc.runOnce(new Date(T0.getTime() + 13 * MIN + 30_000));
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1);
    const s2 = await svc.runOnce(new Date(T0.getTime() + 15 * MIN));
    expect(s2.sent).toBe(1);
    expect(h.messages.rows).toHaveLength(1);
  });

  it('send that wrote the message and then threw is not re-sent on retry', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    h.sendAsCoach.mockImplementationOnce(
      async (
        coachId: string,
        clientId: string,
        payload: { body: string },
        options: { welcomeJobId?: string } = {},
      ) => {
        await h.messages.create({
          data: {
            coach_id: coachId,
            client_id: clientId,
            sender_id: coachId,
            body: payload.body,
            welcome_job_id: options.welcomeJobId,
          },
        });
        throw new Error('post-write failure');
      },
    );
    await svc.runOnce(new Date(T0.getTime() + 13 * MIN));
    await svc.runOnce(new Date(T0.getTime() + 20 * MIN));
    expect(h.messages.rows).toHaveLength(1);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'sent', message_id: h.messages.rows[0].id });
  });

  it('worker died mid-send (stale sending claim, message already written) -> reconciled, not re-sent', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    const body =
      "Hi Dana, it's Morgan. Welcome in. Your plan and targets are ready. Message me here anytime.";
    const job = h.jobs.rows[0];
    Object.assign(job, {
      status: 'sending',
      locked_at: new Date(T0.getTime() + 13 * MIN),
      rendered_body: body,
    });
    await h.messages.create({
      data: { coach_id: COACH, client_id: CLIENT, sender_id: COACH, body, welcome_job_id: job.id },
    });
    // not stale yet: left alone
    await svc.runOnce(new Date(T0.getTime() + 14 * MIN));
    expect(job.status).toBe('sending');
    await svc.runOnce(
      new Date(T0.getTime() + 13 * MIN + __coachWelcomeConsts.STALE_CLAIM_MS + MIN),
    );
    expect(h.sendAsCoach).not.toHaveBeenCalled();
    expect(job).toMatchObject({ status: 'sent', message_id: h.messages.rows[0].id });
  });

  it('worker died before the message was written -> reclaimed and sent once', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    Object.assign(h.jobs.rows[0], {
      status: 'sending',
      locked_at: new Date(T0.getTime() + 13 * MIN),
    });
    await svc.runOnce(
      new Date(T0.getTime() + 13 * MIN + __coachWelcomeConsts.STALE_CLAIM_MS + MIN),
    );
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1);
    expect(h.jobs.rows[0].status).toBe('sent');
  });

  it('gives up after MAX_ATTEMPTS and marks failed', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    h.sendAsCoach.mockRejectedValue(new Error('down'));
    let t = T0.getTime() + 13 * MIN;
    for (let i = 0; i < __coachWelcomeConsts.MAX_ATTEMPTS; i += 1) {
      await svc.runOnce(new Date(t));
      t += 2 * 60 * MIN;
    }
    expect(h.jobs.rows[0]).toMatchObject({
      status: 'failed',
      attempt_count: __coachWelcomeConsts.MAX_ATTEMPTS,
    });
  });

  it('the 1-minute cron is a no-op under NODE_ENV=test (tests drive runOnce)', async () => {
    const h = harness();
    await seed(h);
    await h.make().tick();
    expect(h.jobs.rows).toHaveLength(0);
  });
});

describe('CoachWelcomeService — data minimisation and erasure (B-JOURNEY fix round)', () => {
  const DUE = () => new Date(T0.getTime() + 13 * MIN);

  it('clears rendered_body once the job is sent', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    await svc.runOnce(DUE());
    expect(h.jobs.rows[0]).toMatchObject({ status: 'sent', rendered_body: null });
    // the delivered message itself is untouched
    expect(h.messages.rows[0].body).toContain('Dana');
  });

  it('clears rendered_body when a stamped job is cancelled (403 block race after the stamp)', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    h.sendAsCoach.mockRejectedValueOnce(new ForbiddenException({ error: 'BLOCKED' }));
    await svc.runOnce(DUE());
    expect(h.jobs.rows[0]).toMatchObject({
      status: 'cancelled',
      reason: 'blocked',
      rendered_body: null,
    });
  });

  it('keeps rendered_body while a retry is pending, clears it when the job fails for good', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    h.sendAsCoach.mockRejectedValue(new Error('down'));
    await svc.runOnce(DUE());
    expect(h.jobs.rows[0].status).toBe('pending');
    expect(h.jobs.rows[0].rendered_body).toEqual(expect.stringContaining('Dana'));
    let t = DUE().getTime() + 2 * 60 * MIN;
    for (let i = 1; i < __coachWelcomeConsts.MAX_ATTEMPTS; i += 1) {
      await svc.runOnce(new Date(t));
      t += 2 * 60 * MIN;
    }
    expect(h.jobs.rows[0]).toMatchObject({ status: 'failed', rendered_body: null });
  });

  it('erasure: a tombstoned client loses its welcome job and is never scheduled again', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    expect(h.jobs.rows).toHaveLength(1);
    // account deletion finalised: the User row is tombstoned, not deleted
    Object.assign(h.users.rows.find((u) => u.id === CLIENT) ?? {}, {
      deleted_at: new Date(T0.getTime() + 2 * MIN),
      name: 'Deleted user',
    });
    const s = await svc.runOnce(new Date(T0.getTime() + 3 * MIN));
    expect(h.jobs.rows).toHaveLength(0);
    expect(s.scheduled + s.skipped).toBe(0);
    await svc.runOnce(DUE());
    await svc.runOnce(new Date(T0.getTime() + 60 * MIN));
    expect(h.jobs.rows).toHaveLength(0);
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it("erasure: a tombstoned coach loses its welcome setting (the coach's welcome text) and its jobs", async () => {
    const h = harness();
    await seed(h, { template: 'Hi {first_name}. {coach_first_name} here.' });
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    expect(h.settings.rows).toHaveLength(1);
    Object.assign(h.users.rows.find((u) => u.id === COACH) ?? {}, {
      deleted_at: new Date(T0.getTime() + 2 * MIN),
    });
    expect(await svc.purgeErased()).toBe(2);
    expect(h.settings.rows).toHaveLength(0);
    expect(h.jobs.rows).toHaveLength(0);
  });

  it('erasure: live users keep their rows', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    expect(await svc.purgeErased()).toBe(0);
    expect(h.jobs.rows).toHaveLength(1);
    expect(h.settings.rows).toHaveLength(1);
  });

  it('kill switch off (COACH_WELCOME_SCHEDULER_ENABLED=false): the cron still runs the erasure sweep and nothing else', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    // a second, live client with a pending job must be left untouched
    await h.users.create({
      data: {
        id: 'client-2',
        name: 'Sam Park',
        role: 'student',
        coach_id: COACH,
        deleted_at: null,
      },
    });
    await h.intakes.create({ data: { client_id: 'client-2', completed_at: T0 } });
    await svc.runOnce(new Date(T0.getTime() + 2 * MIN));
    expect(h.jobs.rows).toHaveLength(2);
    Object.assign(h.users.rows.find((u) => u.id === CLIENT) ?? {}, {
      deleted_at: new Date(T0.getTime() + 3 * MIN),
    });
    const schedule = jest.spyOn(svc, 'schedule');
    const dispatch = jest.spyOn(svc, 'dispatch');
    const prev = { env: process.env.NODE_ENV, flag: process.env.COACH_WELCOME_SCHEDULER_ENABLED };
    process.env.NODE_ENV = 'production';
    process.env.COACH_WELCOME_SCHEDULER_ENABLED = 'false';
    try {
      await svc.tick();
    } finally {
      process.env.NODE_ENV = prev.env;
      if (prev.flag === undefined) delete process.env.COACH_WELCOME_SCHEDULER_ENABLED;
      else process.env.COACH_WELCOME_SCHEDULER_ENABLED = prev.flag;
    }
    expect(h.jobs.rows.map((j) => j.client_id)).toEqual(['client-2']);
    expect(h.jobs.rows[0].status).toBe('pending');
    expect(schedule).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });

  it('a failed erasure sweep is logged and never blocks scheduling or sending', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    jest.spyOn(h.jobs, 'deleteMany').mockRejectedValue(new Error('db unavailable'));
    expect(await svc.purgeErasedSafely()).toBe(0);
    await svc.runOnce(new Date(T0.getTime() + MIN));
    const s = await svc.runOnce(DUE());
    expect(s.sent).toBe(1);
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1);
  });

  it('consent: an intake that is saved but not completed (box-1 consent not yet on file) is never scheduled', async () => {
    const h = harness();
    await seed(h);
    h.intakes.rows[0].completed_at = null;
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    await svc.runOnce(DUE());
    expect(h.jobs.rows).toHaveLength(0);
    expect(h.sendAsCoach).not.toHaveBeenCalled();
  });
});

describe('CoachWelcomeService — B-609-3: a still-live stale lease-holder never sends a second welcome', () => {
  const DUE_AT = new Date(T0.getTime() + 13 * MIN);
  const RECLAIM_AT = new Date(DUE_AT.getTime() + __coachWelcomeConsts.STALE_CLAIM_MS + MIN);

  function deferred() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    return { gate, release };
  }

  /**
   * Worker A claims the job and is paused inside sendAsCoach (before or after
   * its INSERT). Its lease goes stale, worker B (a second replica) reclaims
   * and finishes, then A resumes. Returns once A has resumed and finished.
   */
  async function overlap(
    h: ReturnType<typeof harness>,
    a: 'before-insert' | 'after-insert',
    aResult: 'ok' | 'throws' = 'ok',
  ) {
    const workerA = h.make();
    const workerB = h.make();
    await workerA.runOnce(new Date(T0.getTime() + MIN)); // schedules
    const entered = deferred();
    const resume = deferred();
    const real = h.sendAsCoach.getMockImplementation();
    if (!real) throw new Error('harness sendAsCoach has no implementation');
    h.sendAsCoach.mockImplementationOnce(async (coachId, clientId, payload, options) => {
      if (a === 'after-insert') {
        const row = await real(coachId, clientId, payload, options);
        entered.release();
        await resume.gate;
        if (aResult === 'throws') throw new Error('socket hang up');
        return row;
      }
      entered.release();
      await resume.gate;
      if (aResult === 'throws') throw new Error('socket hang up');
      return real(coachId, clientId, payload, options);
    });
    const aRun = workerA.runOnce(DUE_AT);
    await entered.gate; // A holds the lease and is mid-send
    const bStats = await workerB.runOnce(RECLAIM_AT); // A's lease is stale now
    resume.release();
    const aStats = await aRun;
    return { aStats, bStats };
  }

  it('A paused before its INSERT, B reclaims and sends, A resumes: one message, one fan-out, A superseded', async () => {
    const h = harness();
    await seed(h);
    const { aStats, bStats } = await overlap(h, 'before-insert');
    expect(h.messages.rows).toHaveLength(1);
    expect(h.sideEffects.count).toBe(1);
    expect(bStats.sent).toBe(1);
    expect(aStats).toMatchObject({ sent: 0, superseded: 1 });
    expect(h.jobs.rows[0]).toMatchObject({
      status: 'sent',
      message_id: h.messages.rows[0].id,
      lease_token: null,
      rendered_body: null,
    });
    expect(h.messages.rows[0].welcome_job_id).toBe(h.jobs.rows[0].id);
  });

  it('A paused after its INSERT, B reclaims: B reconciles by welcome_job_id without sending, A cannot overwrite', async () => {
    const h = harness();
    await seed(h);
    const { aStats, bStats } = await overlap(h, 'after-insert');
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1); // only A ever sent
    expect(h.messages.rows).toHaveLength(1);
    expect(h.sideEffects.count).toBe(1);
    expect(bStats.sent).toBe(1);
    expect(aStats.superseded).toBe(1);
    expect(h.jobs.rows[0]).toMatchObject({ status: 'sent', message_id: h.messages.rows[0].id });
  });

  it("A's late failure cannot reset B's lease to pending (fenced): still exactly one message after more ticks", async () => {
    const h = harness();
    await seed(h);
    const { aStats } = await overlap(h, 'before-insert', 'throws');
    expect(aStats).toMatchObject({ retried: 0, superseded: 1 });
    expect(h.jobs.rows[0]).toMatchObject({ status: 'sent', attempt_count: 1 });
    const later = h.make();
    await later.runOnce(new Date(RECLAIM_AT.getTime() + 60 * MIN));
    await later.runOnce(new Date(RECLAIM_AT.getTime() + 120 * MIN));
    expect(h.messages.rows).toHaveLength(1);
    expect(h.sideEffects.count).toBe(1);
  });

  it('two reclaimers of the same stale lease: only one wins the claim', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    Object.assign(h.jobs.rows[0], { status: 'sending', locked_at: DUE_AT, lease_token: 'lease-a' });
    const [b, c] = await Promise.all([h.make().runOnce(RECLAIM_AT), h.make().runOnce(RECLAIM_AT)]);
    expect(b.sent + c.sent).toBe(1);
    expect(h.messages.rows).toHaveLength(1);
    expect(h.sendAsCoach).toHaveBeenCalledTimes(1);
  });

  it('every claim writes a fresh lease token', async () => {
    const h = harness();
    await seed(h);
    const svc = h.make();
    await svc.runOnce(new Date(T0.getTime() + MIN));
    const tokens: unknown[] = [];
    h.sendAsCoach.mockImplementation(async () => {
      tokens.push(h.jobs.rows[0].lease_token);
      throw new Error('transient');
    });
    await svc.runOnce(DUE_AT);
    await svc.runOnce(new Date(DUE_AT.getTime() + 2 * MIN));
    expect(tokens).toHaveLength(2);
    expect(typeof tokens[0]).toBe('string');
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(h.jobs.rows[0].lease_token).toBeNull();
  });
});
