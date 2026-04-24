import { HabitsService } from '../src/habits/habits.service';
import { NotFoundException } from '@nestjs/common';

describe('HabitsService.logHabit', () => {
  let prismaMock: any;
  let service: HabitsService;

  beforeEach(() => {
    prismaMock = {
      habit: {
        findFirst: jest.fn().mockResolvedValue({ id: 'habit-1' }),
        findUnique: jest.fn(),
      },
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
    expect(prismaMock.habit.findFirst).toHaveBeenCalledWith({
      where: { id: 'habit-1', user_id: 'user-1' },
      select: { id: true },
    });
    expect(prismaMock.habitLog.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ habit_id: 'habit-1', completed: true });
  });

  // Round-1 ownership check — verifies IDOR fix. When the habit isn't owned by
  // the caller, habit.findFirst returns null and logHabit throws without ever
  // writing a HabitLog.
  it('rejects logging a habit the user does not own', async () => {
    prismaMock.habit.findFirst = jest.fn().mockResolvedValue(null);
    await expect(
      service.logHabit('user-1', 'habit-belonging-to-other', { completed: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prismaMock.habitLog.create).not.toHaveBeenCalled();
  });
});
