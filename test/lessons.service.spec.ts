import { LessonsService } from '../src/lessons/lessons.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('LessonsService.updateLesson', () => {
  let prismaMock: any;
  let service: LessonsService;

  beforeEach(() => {
    prismaMock = {
      user: { findUnique: jest.fn() },
      lesson: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'lesson-1' }),
      },
    };
    service = new LessonsService(prismaMock as any);
  });

  it('rejects non-coaches from updating lessons', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u', role: 'student' });
    await expect(
      service.updateLesson('u', 'lesson-1', { title: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaMock.lesson.update).not.toHaveBeenCalled();
  });

  it('allows a coach to update their own lesson', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'coach-1', role: 'coach' });
    prismaMock.lesson.findFirst.mockResolvedValue({ id: 'lesson-1' });
    await service.updateLesson('coach-1', 'lesson-1', { title: 'x' });
    expect(prismaMock.lesson.findFirst).toHaveBeenCalledWith({
      where: { id: 'lesson-1', coach_id: 'coach-1' },
      select: { id: true },
    });
    expect(prismaMock.lesson.update).toHaveBeenCalled();
  });

  // Round-1 ownership check — a coach updating another coach's lesson now 404s
  // because findFirst is scoped by { coach_id: userId }.
  it("rejects a coach updating another coach's lesson", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'coach-1', role: 'coach' });
    prismaMock.lesson.findFirst.mockResolvedValue(null);
    await expect(
      service.updateLesson('coach-1', 'lesson-owned-by-coach-2', { title: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prismaMock.lesson.update).not.toHaveBeenCalled();
  });
});
