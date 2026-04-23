import { LessonsService } from '../src/lessons/lessons.service';
import { ForbiddenException } from '@nestjs/common';

/**
 * Round-1 fix target: updateLesson currently only checks role=coach; fix
 * should also verify the lesson's coach_id matches userId.
 */
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

  it('rejects non-coaches from updating lessons (role gate present on main)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'u', role: 'student' });
    await expect(
      service.updateLesson('u', 'lesson-1', { title: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaMock.lesson.update).not.toHaveBeenCalled();
  });

  it('allows a coach to update lessons (current behavior)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'coach-1', role: 'coach' });
    await service.updateLesson('coach-1', 'lesson-1', { title: 'x' });
    expect(prismaMock.lesson.update).toHaveBeenCalled();
  });

  // Post round-1 merge: updateLesson must also verify that the lesson being
  // updated belongs to THIS coach (prevents cross-coach tampering).
  it.skip('rejects a coach updating another coach\'s lesson (round-1 ownership check)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'coach-1', role: 'coach' });
    prismaMock.lesson.findFirst = jest.fn().mockResolvedValue(null);
    await expect(
      service.updateLesson('coach-1', 'lesson-owned-by-coach-2', { title: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
