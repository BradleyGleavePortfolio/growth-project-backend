import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { ProfileService, writeProfileWithTargets } from '../src/profile/profile.service';
import { profileClearsFromPatch } from '../src/onboarding/consultation-answers';
import { computeMacros, resolveMacroInputs } from '../src/macros/macro-calculator';
import type { PrismaService } from '../src/prisma.service';
import type { UpdateProfileDto } from '../src/profile/profile.dto';

// ONB-SWEEP-SOL-135 B3: a goal weight the client removed stayed on the
// profile, because the profile write dropped every null. Only an explicit
// clear of the nullable goal weight may now reach the row.

const NOW = new Date('2026-10-01T12:00:00.000Z');
type Row = Record<string, unknown>;

const STORED: Row = {
  user_id: 'u1',
  sex: 'female',
  date_of_birth: new Date('1988-04-01T00:00:00.000Z'),
  height_cm: 167.64,
  current_weight_lbs: 172,
  target_weight_lbs: 120,
  activity_level: 'moderate',
  goal_type: 'fat_loss',
};

function world() {
  const row: Row = { ...STORED };
  const tx = {
    $queryRaw: jest.fn(async () => []),
    userProfile: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: { data: Row }) => Object.assign(row, data)),
    },
  };
  return { row, tx: tx as object as Prisma.TransactionClient, rawTx: tx };
}

function protein(r: Row): number {
  const resolved = resolveMacroInputs(
    {
      current_weight_lbs: r.current_weight_lbs as number,
      target_weight_lbs: r.target_weight_lbs as number | null,
      height_cm: r.height_cm as number,
      date_of_birth: r.date_of_birth as Date,
      sex: r.sex as string,
      activity_level: r.activity_level as string,
      goal_type: r.goal_type as string,
    },
    NOW,
  );
  if (!resolved.ok) throw new Error('row not computable');
  return computeMacros(resolved.inputs).protein_g;
}

describe('profileClearsFromPatch', () => {
  it('clears the goal weight only for an explicit B4 null', () => {
    expect(profileClearsFromPatch({ B4: null })).toEqual(['target_weight_lbs']);
    expect(profileClearsFromPatch({ L1: 'active' })).toEqual([]);
    expect(profileClearsFromPatch({ B4: 150 })).toEqual([]);
    expect(profileClearsFromPatch({ B1: null, L1: null })).toEqual([]);
  });
});

describe('writeProfileWithTargets clears', () => {
  it('an explicit clear nulls target_weight_lbs and the targets follow the current weight', async () => {
    const w = world();
    const before = protein(w.row);
    await writeProfileWithTargets(w.tx, 'u1', {}, NOW, 'allow_incomplete', ['target_weight_lbs']);
    expect(w.row.target_weight_lbs).toBeNull();
    expect(w.row.macro_target_protein_g).toBe(protein(w.row));
    expect(w.row.macro_target_protein_g).not.toBe(before);
  });

  it('without a clear, nulls still never overwrite (goal weight and required inputs kept)', async () => {
    const w = world();
    await writeProfileWithTargets(
      w.tx,
      'u1',
      { target_weight_lbs: null, sex: null, activity_level: null },
      NOW,
      'allow_incomplete',
    );
    expect(w.row).toMatchObject({
      target_weight_lbs: 120,
      sex: 'female',
      activity_level: 'moderate',
    });
    expect(w.row.macro_target_protein_g).toBe(protein(w.row));
  });

  it('a goal weight value in the same patch wins over a clear', async () => {
    const w = world();
    await writeProfileWithTargets(w.tx, 'u1', { target_weight_lbs: 140 }, NOW, 'allow_incomplete', [
      'target_weight_lbs',
    ]);
    expect(w.row.target_weight_lbs).toBe(140);
  });

  it('PUT /profile is unchanged: target_weight_lbs null keeps the stored goal', async () => {
    const w = world();
    const prisma = { $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(w.rawTx) };
    const svc = new ProfileService(prisma as object as PrismaService);
    const dto: object = { target_weight_lbs: null, activity_level: 'active' };
    await svc.updateProfile('u1', dto as UpdateProfileDto, NOW);
    expect(w.row).toMatchObject({ target_weight_lbs: 120, activity_level: 'active' });
  });
});
