import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { HabitsService } from '../src/habits/habits.service';
import { UpdateHabitDto } from '../src/habits/habits.dto';

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

  it('accepts a reminder change and clearing the reminder time', async () => {
    await expect(run({ reminder_enabled: true, reminder_time: '21:05' })).resolves.toEqual({ reminder_enabled: true, reminder_time: '21:05' });
    await expect(run({ reminder_time: null })).resolves.toEqual({ reminder_time: null });
  });
});
