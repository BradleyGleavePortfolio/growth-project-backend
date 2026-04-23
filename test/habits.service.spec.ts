import { HabitsService } from '../src/habits/habits.service';

/**
 * Round-1 fix target: logHabit must verify the habit is owned by the user
 * before updating/creating a HabitLog. Scaffolded here; activate once #1
 * merges. A characterization test pins the current (pre-fix) call shape.
 */
describe('HabitsService.logHabit', () => {
  let prismaMock: any;
  let service: HabitsService;

  beforeEach(() => {
    prismaMock = {
      habit: { findFirst: jest.fn(), findUnique: jest.fn() },
      habitLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'log-1', ...args.data })),
        update: jest.fn(),
      },
    };
    service = new HabitsService(prismaMock as any);
  });

  it('creates a new log when none exists for the date', async () => {
    const result = await service.logHabit('user-1', 'habit-1', { completed: true });
    expect(prismaMock.habitLog.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ habit_id: 'habit-1', completed: true });
  });

  // Post round-1 merge, logHabit should call prisma.habit.findFirst
  // ({ where: { id: habitId, user_id: userId } }) and throw ForbiddenException
  // if missing. Flip skip → run once #1 lands.
  it.skip('rejects logging a habit the user does not own (round-1 ownership check)', async () => {
    prismaMock.habit.findFirst = jest.fn().mockResolvedValue(null);
    await expect(
      service.logHabit('user-1', 'habit-belonging-to-other', { completed: true }),
    ).rejects.toThrow();
    expect(prismaMock.habitLog.create).not.toHaveBeenCalled();
  });
});
