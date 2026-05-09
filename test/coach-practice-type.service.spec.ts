// Stage 3 — coach practice-type storage tests (gpb).
//
// The cross-pillar UI in the fitness app reads this value to decide
// whether to mount the cross-pillar nested navigator. Two failure modes
// the tests pin:
//
//   * Setting a practice type for a non-coach role must fail closed.
//   * Reading a never-set value returns `null` (not 404), so the
//     mobile practice-selection flow can detect "first-time coach".

import { ForbiddenException } from '@nestjs/common';
import { PracticeTypeService } from '../src/coach/practice-type/practice-type.service';

// Sprint A — federation client stub. These tests pre-date the dual-
// write addition; we keep them focused on tenancy logic by stubbing
// the federation client to "not configured" so set() does not try
// to mirror to the finance backend during this test run.
const fakeFinanceClient = {
  isConfigured: () => false,
  hasAuth: () => false,
  setCoachPracticeByEmail: jest.fn(),
};

function makePrisma(initial?: Partial<{ role: string; coach_practice_type: string | null }>) {
  const findUnique = jest.fn().mockResolvedValue(initial ?? null);
  const update = jest.fn().mockImplementation(async ({ data }) => ({
    coach_practice_type: data.coach_practice_type,
  }));
  return {
    findUnique,
    update,
    prisma: {
      user: { findUnique, update },
    } as any,
  };
}

describe('PracticeTypeService.get', () => {
  it('returns null practice_type for an unknown user (no 404, no throw)', async () => {
    const { prisma } = makePrisma(undefined);
    const svc = new PracticeTypeService(prisma, fakeFinanceClient as any);
    await expect(svc.get('missing')).resolves.toEqual({ practice_type: null });
  });

  it('returns the stored value for a coach who has selected', async () => {
    const { prisma } = makePrisma({ role: 'coach', coach_practice_type: 'both' });
    const svc = new PracticeTypeService(prisma, fakeFinanceClient as any);
    await expect(svc.get('coach-1')).resolves.toEqual({ practice_type: 'both' });
  });

  it('throws ForbiddenException when the user is a student', async () => {
    const { prisma } = makePrisma({ role: 'student', coach_practice_type: null });
    const svc = new PracticeTypeService(prisma, fakeFinanceClient as any);
    await expect(svc.get('student-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PracticeTypeService.set', () => {
  it('persists the new value for a coach', async () => {
    const { prisma, update } = makePrisma({ role: 'coach', coach_practice_type: null });
    const svc = new PracticeTypeService(prisma, fakeFinanceClient as any);
    const result = await svc.set('coach-1', 'both');
    expect(result).toMatchObject({ practice_type: 'both' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'coach-1' },
        data: { coach_practice_type: 'both' },
      }),
    );
  });

  it('refuses to set a practice type on a student', async () => {
    const { prisma, update } = makePrisma({ role: 'student', coach_practice_type: null });
    const svc = new PracticeTypeService(prisma, fakeFinanceClient as any);
    await expect(svc.set('student-1', 'fitness_only')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(update).not.toHaveBeenCalled();
  });
});
