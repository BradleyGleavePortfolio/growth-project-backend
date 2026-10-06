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

type FakeLesson = { id: string; coach_id: string };

const LESSONS: FakeLesson[] = [
  { id: 'lesson-a1', coach_id: 'coach-a' },
  { id: 'lesson-b1', coach_id: 'coach-b' },
];

function makeLessonsPrisma(users: FakeUser[]) {
  type LessonWhere = { id?: string | { notIn: string[] }; coach_id?: string };
  const idMatches = (id: LessonWhere['id'], lessonId: string) =>
    id === undefined ||
    (typeof id === 'string' ? id === lessonId : !id.notIn.includes(lessonId));
  const byWhere = (where: LessonWhere | undefined) =>
    LESSONS.filter(
      (l) =>
        (where?.coach_id === undefined || l.coach_id === where.coach_id) &&
        idMatches(where?.id, l.id),
    );
  return {
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          users.find((u) => u.id === where.id) ?? null,
      ),
    },
    lesson: {
      findMany: jest.fn(
        async ({ where }: { where?: LessonWhere }) => byWhere(where),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: LessonWhere }) => byWhere(where)[0] ?? null,
      ),
    },
    lessonCompletion: {
      findFirst: jest.fn(async () => null),
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

const COACHLESS: FakeUser = {
  id: 'client-coachless',
  role: 'student',
  coach_id: null,
  profile: { goal_type: null },
  lesson_completions: [],
};
const COACHED: FakeUser = {
  id: 'client-of-a',
  role: 'student',
  coach_id: 'coach-a',
  profile: { goal_type: null },
  lesson_completions: [],
};

describe('B2 — Learn only ever shows the client\'s own coach\'s lessons', () => {
  it('a coachless client gets no lessons, not every coach\'s', async () => {
    const { service, prisma } = await lessonsServiceWith([COACHLESS]);
    await expect(service.getLessons(COACHLESS.id)).resolves.toEqual([]);
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
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
    for (const [args] of prisma.lesson.findMany.mock.calls) {
      expect(args.where?.coach_id).toBe('coach-a');
    }
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
      where: { id: 'lesson-a1', coach_id: 'coach-a' },
      select: { id: true },
    });
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
