// B-DELIV-125 — two launch fixes on paid and private content.
//
// B2: a client with no coach (coachless sign-up) opened Learn and got every
// coach's lessons, because a missing coach meant "no coach filter".
// Recommended lessons had the same gap, and any client could mark any
// coach's lesson complete.
//
// B3: a client who bought a package with a PDF or video could not open it:
// the grant-scoped signer (CoachMediaService.getBuyerSignedUrl) had no route.
// GET /v1/client/media/:id/signed-url now calls it with the caller's own id.

import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { User } from '@prisma/client';
import type { AuthedRequest } from '../src/auth/auth-request';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { ClientMediaController } from '../src/coach-media/client-media.controller';
import { CoachMediaModule } from '../src/coach-media/coach-media.module';
import { CoachMediaService } from '../src/coach-media/coach-media.service';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { LessonsService } from '../src/lessons/lessons.service';
import { PrismaService } from '../src/prisma.service';

type FakeUser = {
  id: string;
  role: string;
  coach_id: string | null;
  profile: { goal_type: string | null } | null;
  lesson_completions: Array<{ lesson_id: string }>;
};

// coach_deleted: the lesson's coach deleted their account (User.deleted_at).
type FakeLesson = {
  id: string;
  coach_id: string;
  coach_deleted: boolean;
  completed_by: string[];
  goal_tags: string[];
};

const lesson = (id: string, coach_id: string, completed_by: string[] = [], goal_tags: string[] = []) =>
  ({ id, coach_id, coach_deleted: coach_id === 'coach-gone', completed_by, goal_tags });
const LESSONS: FakeLesson[] = [
  lesson('lesson-a1', 'coach-a'),
  lesson('lesson-b1', 'coach-b', ['client-moved']),
  lesson('lesson-gone1', 'coach-gone', ['client-kept', 'client-recoached'], ['fat_loss']),
  lesson('lesson-gone2', 'coach-gone'),
];

// The where shapes LessonsService sends; any other key fails the test.
type LessonWhere = {
  AND?: LessonWhere[];
  OR?: LessonWhere[];
  id?: string | { notIn: string[] };
  coach_id?: string;
  module_id?: null;
  coach?: { deleted_at: { not: null } };
  completions?: { some: { user_id: string } };
  goal_tags?: { has: string } | { isEmpty: true };
};
const WHERE_KEYS = ['AND', 'OR', 'id', 'coach_id', 'module_id', 'coach', 'completions', 'goal_tags'];

function matches(l: FakeLesson, w: LessonWhere = {}): boolean {
  const unhandled = Object.keys(w).find((k) => !WHERE_KEYS.includes(k));
  if (unhandled) throw new Error(`fake prisma: unhandled where key ${unhandled}`);
  if (w.module_id !== undefined && w.module_id !== null) throw new Error('fake prisma: course lesson');
  if (w.coach && w.coach.deleted_at.not !== null) throw new Error('fake prisma: coach filter');
  const id = w.id;
  const goal = w.goal_tags;
  return (
    (w.AND ?? []).every((x) => matches(l, x)) &&
    (w.OR === undefined || w.OR.some((x) => matches(l, x))) &&
    (id === undefined || (typeof id === 'string' ? id === l.id : !id.notIn.includes(l.id))) &&
    (w.coach_id === undefined || w.coach_id === l.coach_id) &&
    (w.coach === undefined || l.coach_deleted) &&
    (w.completions === undefined || l.completed_by.includes(w.completions.some.user_id)) &&
    (goal === undefined ||
      ('has' in goal ? l.goal_tags.includes(goal.has) : l.goal_tags.length === 0))
  );
}

function makeLessonsPrisma(users: FakeUser[]) {
  const byWhere = (where: LessonWhere | undefined) => LESSONS.filter((l) => matches(l, where));
  return {
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          users.find((u) => u.id === where.id) ?? null,
      ),
    },
    lesson: {
      findMany: jest.fn(
        async ({ where }: { where?: LessonWhere; include?: unknown }) => byWhere(where),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: LessonWhere }) => byWhere(where)[0] ?? null,
      ),
    },
    // LEARN-BE2: completeLesson's course fallback; no one here is in a course.
    courseEnrolment: { findFirst: jest.fn(async () => null) },
    lessonCompletion: {
      findFirst: jest.fn(
        async ({ where }: { where: { user_id: string; lesson_id: string } }) =>
          LESSONS.find((l) => l.id === where.lesson_id)?.completed_by.includes(where.user_id)
            ? { id: `done-${where.lesson_id}`, ...where }
            : null,
      ),
      create: jest.fn(
        async ({ data }: { data: { user_id: string; lesson_id: string } }) => ({
          id: 'completion-1',
          ...data,
        }),
      ),
    },
  };
}

async function lessonsServiceWith(users: FakeUser[]) {
  const prisma = makeLessonsPrisma(users);
  const moduleRef = await Test.createTestingModule({
    providers: [LessonsService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return { service: moduleRef.get(LessonsService), prisma };
}

const client = (id: string, coach_id: string | null, done: string[] = []): FakeUser => ({
  id,
  role: 'student',
  coach_id,
  profile: { goal_type: null },
  lesson_completions: done.map((lesson_id) => ({ lesson_id })),
});
const COACHLESS = client('client-coachless', null);
const COACHED = client('client-of-a', 'coach-a');
/** The kept-lesson branch of the read scope, for `userId`. */
const kept = (userId: string) => ({
  module_id: null,
  coach: { deleted_at: { not: null } },
  completions: { some: { user_id: userId } },
});
const ids = (rows: Array<{ id: string }>) => rows.map((l) => l.id);

describe('B2 — Learn only ever shows the client\'s own coach\'s lessons', () => {
  it('a coachless client gets no lessons, not every coach\'s', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHLESS]);
    await expect(service.getLessons(COACHLESS.id)).resolves.toEqual([]);
    // The only read is the kept-lesson scope (LEARN-FROZEN-SINGLE-READS), never unscoped.
    expect(prisma.lesson.findMany.mock.calls.map(([args]) => args.where)).toEqual([
      { AND: [kept(COACHLESS.id)] },
    ]);
  });

  it('a coachless client gets no recommended lessons', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHLESS]);
    await expect(service.getRecommended(COACHLESS.id)).resolves.toEqual([]);
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it('an unknown user gets no lessons', async () => {
    const { service, prisma } = await lessonsServiceWith([]);
    await expect(service.getLessons('nobody')).resolves.toEqual([]);
    await expect(service.getRecommended('nobody')).resolves.toEqual([]);
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it('a coached client sees only their coach\'s lessons (list and recommended)', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHED]);
    const list = await service.getLessons(COACHED.id);
    expect(list.map((l) => l.id)).toEqual(['lesson-a1']);
    const recommended = await service.getRecommended(COACHED.id);
    expect(recommended.map((l) => l.id)).toEqual(['lesson-a1']);
    const [[listArgs], [recommendedArgs]] = prisma.lesson.findMany.mock.calls;
    expect(listArgs.where).toEqual({
      AND: [{ OR: [{ coach_id: 'coach-a', module_id: null }, kept(COACHED.id)] }],
    });
    expect(recommendedArgs.where?.coach_id).toBe('coach-a');
  });

  it('a client cannot mark another coach\'s lesson complete', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHED]);
    await expect(service.completeLesson(COACHED.id, 'lesson-b1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.lessonCompletion.create).not.toHaveBeenCalled();
  });

  it('a coachless client cannot mark any lesson complete', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHLESS]);
    await expect(service.completeLesson(COACHLESS.id, 'lesson-a1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.lessonCompletion.create).not.toHaveBeenCalled();
  });

  it('a client can still complete their own coach\'s lesson', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHED]);
    await expect(service.completeLesson(COACHED.id, 'lesson-a1')).resolves.toMatchObject({
      user_id: COACHED.id,
      lesson_id: 'lesson-a1',
    });
    expect(prisma.lesson.findFirst).toHaveBeenCalledWith({
      where: { id: 'lesson-a1', OR: [{ coach_id: 'coach-a', module_id: null }, kept(COACHED.id)] },
      select: { id: true },
    });
  });
});

// LEARN-FROZEN-SINGLE-READS: coach-gone deleted their account. client-kept
// (now coachless) and client-recoached (now coach-a's) completed lesson-gone1,
// so they kept it; nobody completed lesson-gone2. client-moved completed
// lesson-b1 and moved from coach-b (still has an account) to coach-a.
describe('LEARN-FROZEN-SINGLE-READS — a client reads the single lessons they kept', () => {
  const KEPT = client('client-kept', null, ['lesson-gone1']);
  const RECOACHED = client('client-recoached', 'coach-a', ['lesson-gone1']);
  const MOVED = client('client-moved', 'coach-a', ['lesson-b1']);
  const COACH_A: FakeUser = { ...client('coach-a', null), role: 'coach' };

  it('a detached client lists exactly the lesson they kept, done, and recommends nothing', async () => {
    const { service, prisma } = await lessonsServiceWith([KEPT]);
    expect(ids(await service.getLessons(KEPT.id))).toEqual(['lesson-gone1']);
    expect(prisma.lesson.findMany.mock.calls[0][0].include).toEqual({
      completions: { where: { user_id: KEPT.id } },
    });
    await expect(service.getRecommended(KEPT.id)).resolves.toEqual([]);
  });

  it('marking a kept lesson complete returns the completion they have, never a new one', async () => {
    const { service, prisma } = await lessonsServiceWith([KEPT]);
    await expect(service.completeLesson(KEPT.id, 'lesson-gone1')).resolves.toEqual({
      id: 'done-lesson-gone1',
      user_id: KEPT.id,
      lesson_id: 'lesson-gone1',
    });
    await expect(service.completeLesson(KEPT.id, 'lesson-gone2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.lessonCompletion.create).not.toHaveBeenCalled();
  });

  it('a client with a new coach reads the new coach\'s lessons and the one they kept', async () => {
    const { service } = await lessonsServiceWith([RECOACHED]);
    expect(ids(await service.getLessons(RECOACHED.id))).toEqual(['lesson-a1', 'lesson-gone1']);
    expect(ids(await service.getRecommended(RECOACHED.id))).toEqual(['lesson-a1']);
  });

  it('the goal filter narrows the scope and never replaces it', async () => {
    const withGoal = { ...RECOACHED, profile: { goal_type: 'fat_loss' } };
    const { service, prisma } = await lessonsServiceWith([withGoal]);
    expect(ids(await service.getLessons(withGoal.id))).toEqual(['lesson-a1', 'lesson-gone1']);
    expect(prisma.lesson.findMany.mock.calls[0][0].where).toEqual({
      AND: [{ OR: [{ coach_id: 'coach-a', module_id: null }, kept(withGoal.id)] }],
      OR: [{ goal_tags: { has: 'fat_loss' } }, { goal_tags: { isEmpty: true } }],
    });
  });

  it('nobody else reads or completes a kept lesson', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHED, COACHLESS, COACH_A]);
    expect(ids(await service.getLessons(COACHED.id))).toEqual(['lesson-a1']);
    expect(ids(await service.getLessons(COACHLESS.id))).toEqual([]);
    expect(ids(await service.getLessons(COACH_A.id))).toEqual(['lesson-a1']);
    for (const who of [COACHED.id, COACHLESS.id, COACH_A.id]) {
      await expect(service.completeLesson(who, 'lesson-gone1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(prisma.lessonCompletion.create).not.toHaveBeenCalled();
  });

  it('a past coach who still has an account stays closed after a move', async () => {
    const { service, prisma } = await lessonsServiceWith([MOVED]);
    expect(ids(await service.getLessons(MOVED.id))).toEqual(['lesson-a1']);
    await expect(service.completeLesson(MOVED.id, 'lesson-b1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.lessonCompletion.create).not.toHaveBeenCalled();
  });
});

describe('B3 — a buyer can open a purchased PDF or video', () => {
  async function controllerWith(getBuyerSignedUrl: jest.Mock) {
    const moduleRef = await Test.createTestingModule({
      controllers: [ClientMediaController],
      providers: [{ provide: CoachMediaService, useValue: { getBuyerSignedUrl } }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    return moduleRef.get(ClientMediaController);
  }

  function reqFor(userId: string): AuthedRequest {
    return { user: { id: userId, role: 'student' } as User };
  }

  it('is mounted at GET /v1/client/media/:id/signed-url behind JWT for clients', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ClientMediaController)).toBe('v1/client/media');
    const handler = ClientMediaController.prototype.signedUrl;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/signed-url');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(GUARDS_METADATA, ClientMediaController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toContain('student');
  });

  it('is registered on CoachMediaModule', () => {
    const controllers: unknown[] = Reflect.getMetadata('controllers', CoachMediaModule);
    expect(controllers).toContain(ClientMediaController);
  });

  it('signs with the caller\'s own id and the default lifetime', async () => {
    const signed = { url: 'https://signed.example/doc.pdf', expires_in_seconds: 300, kind: 'pdf' };
    const getBuyerSignedUrl = jest.fn(async () => signed);
    const controller = await controllerWith(getBuyerSignedUrl);
    await expect(controller.signedUrl(reqFor('buyer-1'), 'asset-1')).resolves.toEqual(signed);
    expect(getBuyerSignedUrl).toHaveBeenCalledWith('buyer-1', 'asset-1');
  });

  it('a caller without a live grant gets the signer\'s 404', async () => {
    const getBuyerSignedUrl = jest.fn(async () => {
      throw new NotFoundException({ error: 'ASSET_NOT_FOUND' });
    });
    const controller = await controllerWith(getBuyerSignedUrl);
    await expect(controller.signedUrl(reqFor('not-a-buyer'), 'asset-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
