import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { HabitsService } from '../src/habits/habits.service';
import { HabitSummaryQuery, UpdateHabitDto } from '../src/habits/habits.dto';

// The client's habit routes (HB1). The row rules for coaches are proven live in
// test/rls/habits-rls.spec.ts.
describe('HabitsService', () => {
  let prismaMock: any;
  let service: HabitsService;
  const own = { id: 'habit-1', user_id: 'user-1', assigned_by_coach_id: null, schedule_kind: 'daily', schedule_days: [], times_per_week: null };
  const coachSet = { ...own, id: 'habit-2', assigned_by_coach_id: 'coach-1' };

  beforeEach(() => {
    prismaMock = {
      habit: {
        findFirst: jest.fn().mockResolvedValue(own),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _max: { sort_order: 2 } }),
        create: jest.fn().mockImplementation((args) => Promise.resolve(args.data)),
        update: jest.fn().mockImplementation((args) => Promise.resolve(args.data)),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        delete: jest.fn(),
      },
      habitLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'log-1', ...args.data })),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      // The client's zone (recipient-timezone.ts): none known unless a test sets one.
      notificationPreferences: { findUnique: jest.fn().mockResolvedValue(null) },
      coachProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn().mockResolvedValue({ coach_id: null }) },
    };
    service = new HabitsService(prismaMock as any);
  });

  // Every client route reaches only the caller's own habits, and none reaches a
  // removed (archived) one.
  const LIVE_OWN = { id: 'habit-1', user_id: 'user-1', archived_at: null };
  it.each<[string, () => Promise<unknown>, string, string, object]>([
    ['GET /habits', () => service.getHabits('user-1'), 'habit', 'findMany', { user_id: 'user-1', archived_at: null }],
    ['GET /habits/logs', () => service.getLogs('user-1', '2026-10-14'), 'habitLog', 'findMany', { habit: { user_id: 'user-1', archived_at: null } }],
    ['POST /habits/:id/log', () => service.logHabit('user-1', 'habit-1', { completed: true }), 'habit', 'findFirst', LIVE_OWN],
    ['PATCH /habits/:id', () => service.updateHabit('user-1', 'habit-1', { name: 'Walk' }), 'habit', 'findFirst', LIVE_OWN],
    ['DELETE /habits/:id', () => service.deleteHabit('user-1', 'habit-1'), 'habit', 'updateMany', LIVE_OWN],
  ])('%s reaches only the caller\'s habits that are not archived', async (_route, call, model, method, where) => {
    await call();
    expect(prismaMock[model][method]).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining(where) }));
  });

  it('GET /habits lists habits in the client\'s order', async () => {
    await service.getHabits('user-1');
    expect(prismaMock.habit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }),
    );
  });

  it('POST /habits adds the habit at the end of the list, with its schedule and reminder', async () => {
    const made = await service.createHabit('user-1', {
      name: 'Walk', schedule_kind: 'days', schedule_days: [1, 3], reminder_enabled: true, reminder_time: '07:30', starts_on: '2026-10-19',
    });
    expect(prismaMock.habit.aggregate).toHaveBeenCalledWith({ where: { user_id: 'user-1' }, _max: { sort_order: true } });
    expect(made).toMatchObject({
      user_id: 'user-1', name: 'Walk', category: 'custom', sort_order: 3, schedule_kind: 'days', schedule_days: [1, 3],
      reminder_enabled: true, reminder_time: '07:30', starts_on: new Date('2026-10-19'),
    });
  });

  it('creates a new log when none exists for the date', async () => {
    const result = await service.logHabit('user-1', 'habit-1', { completed: true });
    expect(prismaMock.habitLog.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ habit_id: 'habit-1', completed: true });
  });

  // Round-1 ownership check (IDOR fix): a habit the caller does not own, or one
  // they removed, is not found, and nothing is written.
  it('rejects logging a habit the user does not own or removed', async () => {
    prismaMock.habit.findFirst = jest.fn().mockResolvedValue(null);
    await expect(
      service.logHabit('user-1', 'habit-belonging-to-other', { completed: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prismaMock.habitLog.create).not.toHaveBeenCalled();
  });

  it('PATCH /habits/:id edits the client\'s own habit', async () => {
    await service.updateHabit('user-1', 'habit-1', { name: 'Run', schedule_kind: 'times_per_week', times_per_week: 3, sort_order: 4 });
    expect(prismaMock.habit.update).toHaveBeenCalledWith({
      where: { id: 'habit-1' },
      data: { name: 'Run', schedule_kind: 'times_per_week', times_per_week: 3, sort_order: 4 },
    });
  });

  // On a habit the coach set, the client changes only its reminder.
  it.each<[UpdateHabitDto, boolean]>([
    [{ reminder_enabled: true, reminder_time: '07:30' }, true],
    [{ reminder_time: null }, true],
    [{ name: 'Run' }, false],
    [{ schedule_kind: 'days', schedule_days: [1] }, false],
    [{ reminder_enabled: false, sort_order: 1 }, false],
    [{ starts_on: '2026-10-19' }, false],
  ])('PATCH on a coach-set habit with %j: allowed %s', async (body, allowed) => {
    prismaMock.habit.findFirst = jest.fn().mockResolvedValue(coachSet);
    const result = service.updateHabit('user-1', 'habit-2', body);
    if (allowed) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaMock.habit.update).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it.each<[UpdateHabitDto]>([[{ schedule_kind: 'days' }], [{ schedule_kind: 'times_per_week' }], [{ schedule_kind: 'days', schedule_days: [] }]])(
    'PATCH refuses an incomplete schedule %j', async (body) => {
      await expect(service.updateHabit('user-1', 'habit-1', body)).rejects.toBeInstanceOf(BadRequestException);
      expect(prismaMock.habit.update).not.toHaveBeenCalled();
    },
  );

  it('PATCH on a habit that is not the caller\'s, or was removed, is not found', async () => {
    prismaMock.habit.findFirst = jest.fn().mockResolvedValue(null);
    await expect(service.updateHabit('user-1', 'habit-9', { name: 'Run' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prismaMock.habit.update).not.toHaveBeenCalled();
  });

  it('DELETE /habits/:id archives the habit and keeps every log', async () => {
    await service.deleteHabit('user-1', 'habit-1');
    expect(prismaMock.habit.updateMany).toHaveBeenCalledWith({ where: LIVE_OWN, data: { archived_at: expect.any(Date) } });
    expect(prismaMock.habit.delete).not.toHaveBeenCalled();
    expect(prismaMock.habitLog.deleteMany).not.toHaveBeenCalled();
  });

  it('DELETE on a habit that is not the caller\'s, or was already removed, is not found', async () => {
    prismaMock.habit.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    await expect(service.deleteHabit('user-1', 'habit-9')).rejects.toBeInstanceOf(NotFoundException);
  });

  // HB3. 05:00 UTC on Thursday Oct 15 is still Wednesday Oct 14, 22:00, in Los Angeles.
  describe('HB3: runs, counts and the open days for a tick, in the client\'s calendar', () => {
    beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-15T05:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] }));
    afterEach(() => jest.useRealTimers());
    const inLosAngeles = () =>
      prismaMock.notificationPreferences.findUnique.mockResolvedValue({ timezone: 'America/Los_Angeles', timezone_updated_at: new Date() });

    // #WORDING-HB3: any day up to the client's today, even before the habit's start (Oct 3), which then moves back;
    // a future day is refused with a code and no words.
    it.each<[string, boolean, string[], string[]]>([
      ['their own zone', true, ['2026-10-14', '2026-10-13', '2026-10-05', '2026-10-01', '2026-10-14T00:00:00.000Z'], ['2026-10-15', '2026-11-02']],
      ['no zone known (a day of slack around UTC)', false, ['2026-10-16', '2026-10-15', '2026-10-01'], ['2026-10-17']],
    ])('POST /habits/:id/log in %s takes any day up to today, never a future day', async (_zone, known, open, closed) => {
      if (known) inLosAngeles();
      prismaMock.habit.findFirst.mockResolvedValue({ ...own, starts_on: new Date('2026-10-03') });
      for (const date of open) await expect(service.logHabit('user-1', 'habit-1', { date })).resolves.toBeDefined();
      for (const date of closed) {
        const refused = await service.logHabit('user-1', 'habit-1', { date }).then(() => null, (e: BadRequestException) => e.getResponse());
        expect(refused).toEqual({ code: 'HABIT_FUTURE_DAY' });
      }
      expect(prismaMock.habitLog.create).toHaveBeenCalledTimes(open.length);
    });

    it('a late tick heals the run on the next GET /habits', async () => {
      inLosAngeles();
      const habit = { ...own, schedule_days: [], starts_on: new Date('2026-10-01'), logs: [] };
      prismaMock.habit.findFirst.mockResolvedValue(habit);
      prismaMock.habit.findMany.mockResolvedValue([habit]);
      const stored = ['2026-10-10', '2026-10-12', '2026-10-13'].map((d) => ({ habit_id: 'habit-1', date: new Date(d) }));
      prismaMock.habitLog.findMany.mockImplementation(() => Promise.resolve(stored));
      prismaMock.habitLog.create.mockImplementation(({ data }: { data: { habit_id: string; date: Date } }) => {
        stored.push(data);
        return Promise.resolve(data);
      });
      await expect(service.getHabits('user-1')).resolves.toMatchObject([{ run_days: 2, best_run_days: 2 }]);
      await service.logHabit('user-1', 'habit-1', { date: '2026-10-11', completed: true });
      await expect(service.getHabits('user-1')).resolves.toMatchObject([{ run_days: 4, best_run_days: 4 }]);
    });

    it('a tick with no date is today in the client\'s calendar, not the server\'s', async () => {
      inLosAngeles();
      await service.logHabit('user-1', 'habit-1', {});
      expect(prismaMock.habitLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ date: new Date('2026-10-14T00:00:00Z') }) });
    });

    it('POST /habits starts the habit on the client\'s today unless they pick a day', async () => {
      inLosAngeles();
      await expect(service.createHabit('user-1', { name: 'Walk' })).resolves.toMatchObject({ starts_on: new Date('2026-10-14') });
    });

    const daily = { ...own, schedule_days: [], starts_on: new Date('2026-10-01'), logs: [] };
    const ticks = (...days: string[]) => days.map((d) => ({ habit_id: 'habit-1', date: new Date(d) }));

    it('GET /habits adds the run, the best run and this week to each habit', async () => {
      inLosAngeles();
      prismaMock.habit.findMany.mockResolvedValue([daily]);
      prismaMock.habitLog.findMany.mockResolvedValue(ticks('2026-10-11', '2026-10-12', '2026-10-13'));
      await expect(service.getHabits('user-1')).resolves.toEqual([
        { ...daily, run_days: 3, best_run_days: 3, week: { planned: 7, done: 2 } },
      ]);
    });

    // Another client's habits and ticks never count: both reads are the caller's live habits only
    // (the row rules are proven live in test/rls/habits-rls.spec.ts).
    it('GET /habits/summary reads only the caller\'s live habits and their ticks', async () => {
      prismaMock.habit.findMany.mockResolvedValue([daily]);
      prismaMock.habitLog.findMany.mockResolvedValue(ticks('2026-10-13'));
      const summary = await service.getSummary('user-1', { from: '2026-10-13', to: '2026-10-14' });
      const live = { user_id: 'user-1', archived_at: null };
      expect(prismaMock.habit.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: live }));
      // Ticks are read from two years back only (the maths never looks further).
      expect(prismaMock.habitLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { completed: true, date: { gte: new Date('2024-10-14T00:00:00Z') }, habit: live },
      }));
      expect(summary).toMatchObject({
        days: [{ date: '2026-10-13', planned: 1, done: 1 }, { date: '2026-10-14', planned: 1, done: 0 }],
        habits: [{ id: 'habit-1', planned: 2, done: 1 }],
      });
    });

    it.each<[HabitSummaryQuery]>([[{ from: '2026-10-14', to: '2026-10-13' }], [{ from: '2026-07-01', to: '2026-10-14' }]])(
      'GET /habits/summary refuses %j (backwards, or over 93 days)', async (query) => {
        await expect(service.getSummary('user-1', query)).rejects.toBeInstanceOf(BadRequestException);
        expect(prismaMock.habit.findMany).not.toHaveBeenCalled();
      },
    );
  });
});

describe('UpdateHabitDto (global ValidationPipe)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (value: object) => pipe.transform(value, { type: 'body', metatype: UpdateHabitDto });

  it.each<[object]>([
    [{ coach_note: 'x' }], [{ assigned_by_coach_id: 'coach-1' }], [{ user_id: 'user-2' }], [{ archived_at: null }],
    [{ name: null }], [{ reminder_enabled: null }], [{ schedule_days: [7] }], [{ schedule_days: [1, 1] }],
    [{ times_per_week: 8 }], [{ reminder_time: '25:00' }], [{ reminder_time: '7:30' }], [{ schedule_kind: 'monthly' }],
  ])('refuses %j', async (body) => {
    await expect(run(body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each<[object]>([[{}], [{ from: '2026-10-12' }], [{ from: '12-10-2026', to: '2026-10-18' }], [{ from: '2026-10-12', to: '2026-10-18', user_id: 'u' }]])(
    'GET /habits/summary refuses the query %j', async (query) => {
      await expect(pipe.transform(query, { type: 'query', metatype: HabitSummaryQuery })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('accepts a reminder change and clearing the reminder time', async () => {
    await expect(run({ reminder_enabled: true, reminder_time: '21:05' })).resolves.toEqual({ reminder_enabled: true, reminder_time: '21:05' });
    await expect(run({ reminder_time: null })).resolves.toEqual({ reminder_time: null });
  });
});
