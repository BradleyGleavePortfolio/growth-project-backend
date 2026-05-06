import { NotFoundException } from '@nestjs/common';
import { CoachBuildWeekController } from '../src/build-week/coach-build-week.controller';

// Pins the tenancy contract: a coach can only see Build Week enrollments
// for their own clients. Other-coach hits return 404 (NOT 403) so an
// attacker cannot enumerate user IDs by probing.

function buildController() {
  const buildWeek = {
    getEnrollmentForCoach: jest.fn(async () => ({
      id: 'enr-1',
      user_id: 'student-1',
      started_at: new Date().toISOString(),
      current_day: 3,
      status: 'active',
      completed_at: null,
      completions: [],
    })),
  };
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id === 'student-1' && where.coach_id === 'coach-1') {
          return { id: 'student-1' };
        }
        return null;
      }),
    },
  };
  const ctrl = new CoachBuildWeekController(buildWeek as any, prisma as any);
  return { ctrl, buildWeek, prisma };
}

describe('CoachBuildWeekController', () => {
  it('returns the enrollment when the client belongs to the requesting coach', async () => {
    const { ctrl, buildWeek } = buildController();
    const result = await ctrl.getForClient(
      { user: { id: 'coach-1', email: 'c1@x.test', role: 'coach' } } as any,
      'student-1',
    );
    expect(result.enrollment?.id).toBe('enr-1');
    expect(buildWeek.getEnrollmentForCoach).toHaveBeenCalledWith('student-1');
  });

  it('throws NotFoundException when the client belongs to a different coach', async () => {
    const { ctrl, buildWeek } = buildController();
    await expect(
      ctrl.getForClient(
        { user: { id: 'coach-2', email: 'c2@x.test', role: 'coach' } } as any,
        'student-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The service must not even be hit — no leak via timing.
    expect(buildWeek.getEnrollmentForCoach).not.toHaveBeenCalled();
  });

  it('owners bypass the tenancy check', async () => {
    const { ctrl, buildWeek, prisma } = buildController();
    const result = await ctrl.getForClient(
      { user: { id: 'owner-1', email: 'o@x.test', role: 'owner' } } as any,
      'student-1',
    );
    expect(result.enrollment?.id).toBe('enr-1');
    // Owner short-circuits the prisma roster check.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(buildWeek.getEnrollmentForCoach).toHaveBeenCalledWith('student-1');
  });
});
