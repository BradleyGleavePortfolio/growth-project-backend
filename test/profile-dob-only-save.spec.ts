import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ValidationPipe,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { AGE_CONFIRMATION_REQUIRED } from '../src/auth/client-age';
import type { JwksVerifierService } from '../src/auth/jwks.service';
import type { PtmService } from '../src/ptm/ptm.service';
import { ClientMacrosController } from '../src/macros/macros.controller';
import { ProfileController } from '../src/profile/profile.controller';
import { ProfileService, writeProfileWithTargets } from '../src/profile/profile.service';
import { UpdateProfileDto } from '../src/profile/profile.dto';
import { computeMacros, resolveMacroInputs, type RawMacroInputs } from '../src/macros/macro-calculator';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../src/prisma.service';
import type { AuthedRequest } from '../src/auth/auth-request';

// AGESAVE (owner #C8-UNDER18-B: "if they dont agree theyre over 16 they dont
// get in the app"). Every client the age gate refuses confirms with their
// date of birth alone through the open PUT /profile, whatever else their
// profile holds. Real controller, real service, real DTO validation; the
// stored targets always equal the calculator on the stored row and no body
// input is invented.

const ID = 'client-1';
const ADULT = '1990-05-20';
const COMPLETE = {
  sex: 'female',
  activity_level: 'moderate',
  goal_type: 'fat_loss',
  current_weight_lbs: 160,
  height_cm: 165,
};
const STALE = { macro_target_calories: 1500, macro_target_protein_g: 120 };
const without = (k: keyof typeof COMPLETE) =>
  Object.fromEntries(Object.entries({ ...COMPLETE, ...STALE }).filter(([key]) => key !== k));

const asPrisma = (m: object): PrismaService => m as PrismaService;
const asTx = (m: object): Prisma.TransactionClient => m as Prisma.TransactionClient;
const asReq = (m: object): AuthedRequest => m as AuthedRequest;
const stub = <T extends object>(m: object): T => m as T;

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = (body: unknown): Promise<UpdateProfileDto> =>
  pipe.transform(body, { type: 'body', metatype: UpdateProfileDto as new () => UpdateProfileDto });

function profileHarness(initial: Record<string, unknown> | null) {
  let row: Record<string, unknown> | null = initial ? { user_id: ID, ...initial } : null;
  const writes: Array<Record<string, unknown>> = [];
  const prisma: Record<string, unknown> = {
    userProfile: {
      findUnique: jest.fn(async () => (row ? { ...row } : null)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return (row = { ...(row ?? {}), ...data });
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return (row = { ...data });
      }),
    },
    macroTarget: { findFirst: jest.fn(async () => null) },
    clientOnboardingIntake: { findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const controller = new ProfileController(new ProfileService(asPrisma(prisma)));
  const put = async (body: unknown) => controller.updateProfile(asReq({ user: { id: ID } }), await validate(body));
  return { prisma, put, writes, row: () => row };
}

/** The refused client's profile states (Opus table + Sol class scope). */
const AGE_SAVE_ROWS: Array<[string, Record<string, unknown> | null]> = [
  ['no profile row', null],
  ['missing weight', without('current_weight_lbs')],
  ['missing height', without('height_cm')],
  ['missing sex', without('sex')],
  ['missing activity level', without('activity_level')],
  ['missing goal', without('goal_type')],
  ['complete except the date', { ...COMPLETE, ...STALE }],
];

describe('AGESAVE: PUT /profile stores a date of birth on its own', () => {
  it.each(AGE_SAVE_ROWS)('%s: the date saves; targets match the calculator on the stored row', async (label, initial) => {
    const h = profileHarness(initial);
    const res = (await h.put({ date_of_birth: ADULT })) as Record<string, unknown>;
    const row = h.row()!;
    expect(row.date_of_birth).toEqual(new Date(ADULT));
    expect(res).toEqual(row);
    // Nothing invented: the write carries the date and the targets only.
    for (const w of h.writes) {
      expect(Object.keys(w).filter((k) => !k.startsWith('macro_target_') && k !== 'user_id')).toEqual(['date_of_birth']);
    }
    const resolved = resolveMacroInputs(row as RawMacroInputs, new Date());
    expect(resolved.ok).toBe(label === 'complete except the date');
    expect(row.macro_target_calories).toBe(resolved.ok ? computeMacros(resolved.inputs).calories : null);
  });

  it('a body without a date, or with a date plus other fields, keeps the 409 and writes nothing', async () => {
    for (const body of [{}, { bio: 'hello' }, { date_of_birth: ADULT, bio: 'hello' }]) {
      const h = profileHarness(without('height_cm'));
      const err = await h.put(body).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'consultation_incomplete' });
      expect(h.writes).toHaveLength(0);
    }
  });

  it('a malformed date is refused by the DTO before anything is written', async () => {
    for (const date_of_birth of ['1990-13-45', 'not a date', '']) {
      const h = profileHarness(null);
      await expect(h.put({ date_of_birth })).rejects.toBeInstanceOf(BadRequestException);
      expect(h.row()).toBeNull();
    }
  });

  it("the consultation's own B2 writer still stores the date alone", async () => {
    const h = profileHarness(null);
    const out = await writeProfileWithTargets(asTx(h.prisma), ID, { date_of_birth: new Date(ADULT) }, new Date(), 'allow_incomplete');
    expect(out.row?.date_of_birth).toEqual(new Date(ADULT));
  });
});

describe('AGESAVE + AGEGATE16: the saved date is what lets a refused client in', () => {
  // The real guard reads the same stored row the real PUT /profile writes.
  const UNDER_16 = `${new Date().getUTCFullYear() - 14}-01-01`;
  const route = async (h: ReturnType<typeof profileHarness>) => {
    h.prisma.user = { findUnique: jest.fn(async () => ({ id: ID, role: 'student', deleted_at: null, deletion_scheduled_at: null })) };
    const deps = { verify: jest.fn(async () => ({ sub: ID })), emit: jest.fn() };
    const guard = new JwtAuthGuard(asPrisma(h.prisma), stub<JwksVerifierService>(deps), new Reflector(), stub<PtmService>(deps));
    const req = { headers: { authorization: 'Bearer t' } };
    const handler = ClientMacrosController.prototype.current;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => ClientMacrosController };
    const out = await guard.canActivate(stub<ExecutionContext>(ctx)).catch((e: unknown) => e);
    return out instanceof ForbiddenException && (out.getResponse() as { code?: string }).code === AGE_CONFIRMATION_REQUIRED ? 'refused' : out;
  };

  it.each(AGE_SAVE_ROWS)('%s: refused, saves an adult date alone, then gets in', async (_label, initial) => {
    const h = profileHarness(initial);
    expect(await route(h)).toBe('refused');
    await h.put({ date_of_birth: ADULT });
    expect(await route(h)).toBe(true);
  });

  it.each(AGE_SAVE_ROWS)('%s: under-16, malformed and missing dates never unlock', async (_label, initial) => {
    const h = profileHarness(initial);
    await h.put({ date_of_birth: UNDER_16 });
    expect(await route(h)).toBe('refused');
    for (const body of [{ date_of_birth: 'not a date' }, {}]) {
      await h.put(body).catch((e: unknown) => e);
      expect(await route(h)).toBe('refused');
    }
  });
});
