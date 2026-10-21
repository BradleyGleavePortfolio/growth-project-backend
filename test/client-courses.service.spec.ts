import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import type { CoachMediaService } from '../src/coach-media/coach-media.service';
import { ClientCoursesController } from '../src/courses/client-courses.controller';
import { LessonPositionDto } from '../src/courses/client-courses.dto';
import { ClientCoursesService } from '../src/courses/client-courses.service';
import { LessonsService } from '../src/lessons/lessons.service';
import type { PrismaService } from '../src/prisma.service';

// Two clients (A, B) in two coaches' courses, and a draft. The fake database
// answers only for the user_id the service asks about, so a read that forgot
// its tenant filter would hand one client the other's course.
const lesson = (id: string) => ({ id, title: `Title ${id}`, kind: 'both', media_asset: id === 'l2' ? { duration_sec: 420 } : null });
const module_ = (id: string, position: number, opens: number, ...ids: string[]) => ({
  id,
  position,
  title: `Week ${position}`,
  note: `Note ${position}`,
  opens_after_days: opens,
  lessons: ids.map(lesson),
});
const course = (id: string, status: string, week_rule: string, modules: ReturnType<typeof module_>[]) => ({
  id,
  status,
  title: `Course ${id}`,
  week_rule,
  coach: { name: 'Sam Rivera' },
  modules,
});
const C1 = course('c1', 'published', 'one_at_a_time', [
  module_('m1', 1, 0, 'l1', 'l1b'),
  module_('m2', 2, 7, 'l2', 'l3'),
  module_('m3', 3, 14, 'l4'),
]);
const C2 = course('c2', 'published', 'all_at_once', [module_('mb', 1, 0, 'lb')]);
const C3 = course('c3', 'draft', 'all_at_once', [module_('md', 1, 0, 'ld')]);
const enrol = (user_id: string, c: ReturnType<typeof course>, extra: object = {}) => ({
  user_id,
  starts_on: new Date('2026-10-05T00:00:00Z'), // a Monday
  ended_at: null,
  opened_all_at: null,
  created_at: new Date('2026-10-05T00:00:00Z'),
  course: c,
  ...extra,
});
const page = (body: string, video: string | null, media: string | null) => ({ body_markdown: body, video_url: video, article_url: null, media_asset_id: media });
const CONTENT: Record<string, { coach_id: string; description: string | null } & ReturnType<typeof page>> = {
  l1: { coach_id: 'K', description: 'Read me first', ...page('OPEN-BODY-1', null, null) },
  l1b: { coach_id: 'K', description: null, ...page('OPEN-BODY-1B', null, null) },
  l2: { coach_id: 'K', description: null, ...page('OPEN-BODY-2', 'https://cdn.example/open.mp4', 'asset-open') },
  l3: { coach_id: 'K', description: null, ...page('OPEN-BODY-3', 'https://cdn.example/link.mp4', null) },
  l4: { coach_id: 'K', description: 'LOCKED-NOTE', ...page('LOCKED-BODY', 'https://cdn.example/locked.mp4', 'asset-locked') },
  lb: { coach_id: 'L', description: null, ...page('B-BODY', null, 'asset-b') },
};

interface EnrolmentQuery {
  where: { user_id: string; course_id?: string; course: { modules?: { some: { lessons: { some: { id: string } } } } } };
}
interface UserLessonsQuery {
  where: { user_id: string; lesson_id: { in: string[] } };
}
interface LessonsQuery {
  where: { id: { in: string[] } };
  select: Record<string, boolean>;
}

function setup(enrolments: ReturnType<typeof enrol>[], marks: [string, string][] = [], progress: [string, string, number][] = []) {
  const published = (e: ReturnType<typeof enrol>) => e.course.status === 'published';
  const holds = (e: ReturnType<typeof enrol>, id: string) => e.course.modules.some((m) => m.lessons.some((l) => l.id === id));
  const db = {
    // app.client_today: the client's own day, from the database.
    $queryRaw: jest.fn(async (..._args: unknown[]) => [{ today: '2026-10-12' }]),
    courseEnrolment: {
      findMany: jest.fn(async ({ where }: EnrolmentQuery) => enrolments.filter((e) => e.user_id === where.user_id && published(e))),
      findFirst: jest.fn(
        async ({ where }: EnrolmentQuery) =>
          enrolments.find(
            (e) =>
              e.user_id === where.user_id &&
              published(e) &&
              (where.course_id === undefined || e.course.id === where.course_id) &&
              (where.course.modules === undefined || holds(e, where.course.modules.some.lessons.some.id)),
          ) ?? null,
      ),
    },
    lessonCompletion: {
      findMany: jest.fn(async ({ where }: UserLessonsQuery) =>
        marks.filter(([u, l]) => u === where.user_id && where.lesson_id.in.includes(l)).map(([, l]) => ({ lesson_id: l })),
      ),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'done-1', ...data })),
    },
    lesson: {
      // Like Prisma: only the selected columns come back.
      findMany: jest.fn(async ({ where, select }: LessonsQuery) =>
        where.id.in.map((id) => Object.fromEntries(Object.entries({ id, ...CONTENT[id] }).filter(([k]) => select[k]))),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => CONTENT[where.id] ?? null),
      // LessonsService's single-lesson scope: no course lesson is in it.
      findFirst: jest.fn(async () => null),
    },
    lessonProgress: {
      findMany: jest.fn(async ({ where }: UserLessonsQuery) =>
        progress
          .filter(([u, l]) => u === where.user_id && where.lesson_id.in.includes(l))
          .map(([, l, s]) => ({ lesson_id: l, position_seconds: s })),
      ),
      upsert: jest.fn(async () => ({})),
    },
    user: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, role: 'student', coach_id: 'K' })) },
  };
  const signer = { signLessonVideo: jest.fn(async (id: string) => (id === 'asset-open' ? { url: 'https://stream.example/signed', expires_in_seconds: 3600 } : null)) };
  // @ts-expect-error partial PrismaService double: the services read only these delegates
  const prisma: PrismaService = db;
  // @ts-expect-error partial CoachMediaService double: the course routes call only signLessonVideo
  const media: CoachMediaService = signer;
  return { db, signer, service: new ClientCoursesService(prisma, media), lessons: new LessonsService(prisma) };
}

describe('ClientCoursesService (LEARN-BE2)', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-12T20:00:00Z') }));
  afterEach(() => jest.useRealTimers());
  const all = () => [enrol('A', C1), enrol('A', C3), enrol('B', C2)];

  it('detail: the mobile course row, field by field (m#816 courseData.ts)', async () => {
    const { service } = setup(all(), [['A', 'l1']], [['A', 'l2', 95], ['B', 'l2', 12]]);
    const detail = await service.detail('A', 'c1');
    expect(detail).toEqual({
      id: 'c1',
      title: 'Course c1',
      coach_name: 'Sam Rivera',
      starts_on: '2026-10-05',
      modules: [
        {
          id: 'm1', position: 1, title: 'Week 1', note: 'Note 1', open: true, opens_on: '2026-10-05', finish_by: '2026-10-11',
          lessons: [
            { id: 'l1', title: 'Title l1', kind: 'both', duration_sec: null, description: 'Read me first', done: true, ...page('OPEN-BODY-1', null, null), position_seconds: 0 },
            { id: 'l1b', title: 'Title l1b', kind: 'both', duration_sec: null, description: null, done: false, ...page('OPEN-BODY-1B', null, null), position_seconds: 0 },
          ],
        },
        {
          id: 'm2', position: 2, title: 'Week 2', note: 'Note 2', open: true, opens_on: '2026-10-12', finish_by: '2026-10-18',
          lessons: [
            { id: 'l2', title: 'Title l2', kind: 'both', duration_sec: 420, description: null, done: false, ...page('OPEN-BODY-2', 'https://cdn.example/open.mp4', 'asset-open'), position_seconds: 95 },
            { id: 'l3', title: 'Title l3', kind: 'both', duration_sec: null, description: null, done: false, ...page('OPEN-BODY-3', 'https://cdn.example/link.mp4', null), position_seconds: 0 },
          ],
        },
        // A locked week: titles and kinds only, its finish-by still given.
        {
          id: 'm3', position: 3, title: 'Week 3', note: 'Note 3', open: false, opens_on: '2026-10-19', finish_by: '2026-10-25',
          lessons: [{ id: 'l4', title: 'Title l4', kind: 'both', duration_sec: null, description: null, done: false }],
        },
      ],
    });
  });

  it('list: the same row shape for each of the caller\'s published courses, with no pages or links', async () => {
    const { service, db } = setup(all(), [['A', 'l1']]);
    const [row, ...rest] = await service.list('A');
    expect(rest).toEqual([]);
    expect(Object.keys(row)).toEqual(['id', 'title', 'coach_name', 'starts_on', 'modules']);
    expect(row.modules.map((m) => [m.id, m.position, m.open, m.opens_on, m.finish_by])).toEqual([
      ['m1', 1, true, '2026-10-05', '2026-10-11'],
      ['m2', 2, true, '2026-10-12', '2026-10-18'],
      ['m3', 3, false, '2026-10-19', '2026-10-25'],
    ]);
    expect(row.modules[0].lessons[0]).toEqual({ id: 'l1', title: 'Title l1', kind: 'both', duration_sec: null, description: 'Read me first', done: true });
    expect(JSON.stringify(row)).not.toMatch(/BODY|mp4|asset-/);
    expect(db.lesson.findMany.mock.calls[0][0].select).toEqual({
      id: true, description: true, body_markdown: false, video_url: false, article_url: false, media_asset_id: false,
    });
    // Reads by enrolment alone: a deleted coach's course is kept, so no coach filter.
    expect(db.courseEnrolment.findMany.mock.calls[0][0].where).toEqual({ user_id: 'A', course: { status: 'published' } });
  });

  it('asks the database for the client\'s day once per read, the day the row rule uses', async () => {
    const { service, db } = setup(all());
    db.$queryRaw.mockResolvedValue([{ today: '2026-10-11' }]);
    const detail = await service.detail('A', 'c1');
    expect(detail.modules.map((m) => m.open)).toEqual([true, false, false]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw.mock.calls[0]).toEqual([expect.arrayContaining([expect.stringContaining('app.client_today(')]), 'A', null]);
  });

  describe('the day an enrolment ended is the client\'s own day, not the UTC date (round 3, Sol B2)', () => {
    // The fake database answers app.client_today(user, at): today for no instant,
    // and the client's local day for the ended_at instant it is given.
    const ended = (endedAt: string, localEndDay: string) => {
      const t = setup([enrol('A', C1, { ended_at: new Date(endedAt) })]);
      t.db.$queryRaw.mockImplementation(async (...args: unknown[]) => [{ today: args[2] === endedAt ? localEndDay : '2026-11-30' }]);
      return t;
    };

    it('Tokyo: a plan that lapsed at 01:00 on Oct 12 local (Oct 11 UTC) keeps week 2, opened that day', async () => {
      const { service, db } = ended('2026-10-11T16:00:00.000Z', '2026-10-12');
      expect((await service.detail('A', 'c1')).modules.map((m) => m.open)).toEqual([true, true, false]);
      expect(db.$queryRaw.mock.calls.map((c) => c[2])).toEqual([null, '2026-10-11T16:00:00.000Z']);
      await service.savePosition('A', 'l2', 30);
      expect(await service.video('A', 'l2')).toMatchObject({ url: 'https://stream.example/signed' });
    });

    it('Los Angeles: a plan that lapsed at 20:00 on Oct 11 local (Oct 12 UTC) never opens week 2', async () => {
      const { service, db, lessons } = ended('2026-10-12T03:00:00.000Z', '2026-10-11');
      expect((await service.detail('A', 'c1')).modules.map((m) => m.open)).toEqual([true, false, false]);
      await expect(service.savePosition('A', 'l2', 30)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.video('A', 'l2')).rejects.toBeInstanceOf(NotFoundException);
      await expect(lessons.completeLesson('A', 'l2')).rejects.toBeInstanceOf(NotFoundException);
      expect(db.lessonProgress.upsert).not.toHaveBeenCalled();
      expect(db.lessonCompletion.create).not.toHaveBeenCalled();
    });
  });

  it('shows each client only their own course', async () => {
    const { service } = setup(all());
    expect((await service.list('B')).map((c) => c.id)).toEqual(['c2']);
    expect(await service.list('stranger')).toEqual([]);
  });

  it('answers 404 for another client\'s course, a draft and a missing id', async () => {
    const { service } = setup(all());
    await expect(service.detail('B', 'c1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.detail('A', 'c3')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.detail('A', 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never sends a locked week\'s note, body, link or media, and never reads them', async () => {
    const { service, db } = setup(all());
    const text = JSON.stringify(await service.detail('A', 'c1'));
    for (const secret of ['LOCKED-NOTE', 'LOCKED-BODY', 'locked.mp4', 'asset-locked']) expect(text).not.toContain(secret);
    expect(db.lesson.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['l1', 'l1b', 'l2', 'l3'] } });
  });

  it('opens a locked week for a client the coach opened all weeks for', async () => {
    const { service } = setup([enrol('A', C1, { opened_all_at: new Date('2026-10-06T00:00:00Z') })]);
    const detail = await service.detail('A', 'c1');
    expect(detail.modules.every((m) => m.open)).toBe(true);
    expect(detail.modules[2].lessons[0]).toMatchObject({ body_markdown: 'LOCKED-BODY', media_asset_id: 'asset-locked' });
  });

  describe('savePosition', () => {
    it('saves seconds for an open lesson of the caller\'s course, never changing the lesson', async () => {
      const { service, db } = setup(all());
      await service.savePosition('A', 'l2', 40);
      expect(db.lessonProgress.upsert).toHaveBeenCalledWith({
        where: { user_id_lesson_id: { user_id: 'A', lesson_id: 'l2' } },
        create: { user_id: 'A', lesson_id: 'l2', position_seconds: 40 },
        update: { position_seconds: 40 },
      });
    });

    it.each([
      ['another client\'s lesson', 'B', 'l2'],
      ['a lesson in a locked week', 'A', 'l4'],
      ['a lesson of a draft course', 'A', 'ld'],
      ['a missing lesson', 'A', 'nope'],
    ])('answers 404 and writes nothing for %s', async (_name, user, lessonId) => {
      const { service, db } = setup(all());
      await expect(service.savePosition(user, lessonId, 40)).rejects.toBeInstanceOf(NotFoundException);
      expect(db.lessonProgress.upsert).not.toHaveBeenCalled();
    });
  });

  describe('video', () => {
    it('signs an uploaded video with the media signer, for the lesson\'s own coach', async () => {
      const { service, signer } = setup(all());
      expect(await service.video('A', 'l2')).toEqual({ url: 'https://stream.example/signed', expires_at: '2026-10-12T21:00:00.000Z' });
      expect(signer.signLessonVideo).toHaveBeenCalledWith('asset-open', 'K');
    });

    it('returns a coach\'s own https video link with no expiry', async () => {
      const { service } = setup(all());
      expect(await service.video('A', 'l3')).toEqual({ url: 'https://cdn.example/link.mp4', expires_at: null });
    });

    it.each([
      ['another client\'s lesson', 'B', 'l2'],
      ['a lesson in a locked week', 'A', 'l4'],
      ['a lesson of a draft course', 'A', 'ld'],
      ['a lesson with no video', 'A', 'l1'],
      ['a missing lesson', 'A', 'nope'],
    ])('answers 404 for %s', async (_name, user, lessonId) => {
      const { service } = setup(all());
      await expect(service.video(user, lessonId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404, not the link, when the uploaded video cannot be signed', async () => {
      const { service, signer } = setup([enrol('A', C1, { opened_all_at: new Date('2026-10-06T00:00:00Z') })]);
      await expect(service.video('A', 'l4')).rejects.toBeInstanceOf(NotFoundException);
      expect(signer.signLessonVideo).toHaveBeenCalledWith('asset-locked', 'K');
    });

    it('never signs for a lesson the caller may not open', async () => {
      const { service, signer } = setup(all());
      await expect(service.video('B', 'l2')).rejects.toBeInstanceOf(NotFoundException);
      expect(signer.signLessonVideo).not.toHaveBeenCalled();
    });
  });

  describe('POST /lessons/:id/complete for a course lesson (LessonsService.completeLesson)', () => {
    it('marks an open-week lesson of the caller\'s own course done, once', async () => {
      const { lessons, db } = setup(all());
      await expect(lessons.completeLesson('A', 'l2')).resolves.toMatchObject({ user_id: 'A', lesson_id: 'l2' });
      expect(db.lessonCompletion.create).toHaveBeenCalledWith({ data: { user_id: 'A', lesson_id: 'l2' } });
    });

    it.each([
      ['another client\'s lesson', 'B', 'l2'],
      ['a lesson in a locked week', 'A', 'l4'],
      ['a lesson of a draft course', 'A', 'ld'],
      ['a missing lesson', 'A', 'nope'],
    ])('answers 404 and writes nothing for %s', async (_name, user, lessonId) => {
      const { lessons, db } = setup(all());
      await expect(lessons.completeLesson(user, lessonId)).rejects.toBeInstanceOf(NotFoundException);
      expect(db.lessonCompletion.create).not.toHaveBeenCalled();
    });
  });
});

describe('ClientCoursesController (LEARN-BE2)', () => {
  it('is student-only and passes the signed-in id, never an id from the request', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, ClientCoursesController)).toEqual(['student']);
    const courses = {
      list: jest.fn(async () => []),
      detail: jest.fn(async () => ({})),
      savePosition: jest.fn(async () => undefined),
      video: jest.fn(async () => ({ url: 'u', expires_at: null })),
    };
    // @ts-expect-error partial service double: the controller calls only these four methods
    const service: ClientCoursesService = courses;
    const controller = new ClientCoursesController(service);
    const req = { user: { id: 'A' } };
    // @ts-expect-error partial request double: the controller reads only req.user.id
    const authed: Parameters<typeof controller.list>[0] = req;
    await controller.list(authed);
    await controller.detail(authed, 'c1');
    await controller.savePosition(authed, 'l2', { position_seconds: 40 });
    await controller.video(authed, 'l2');
    expect(courses.list).toHaveBeenCalledWith('A');
    expect(courses.detail).toHaveBeenCalledWith('A', 'c1');
    expect(courses.savePosition).toHaveBeenCalledWith('A', 'l2', 40);
    expect(courses.video).toHaveBeenCalledWith('A', 'l2');
  });

  it.each([[0, true], [86400, true], [-1, false], [1.5, false], [86401, false], ['9', false]])(
    'position_seconds %p valid: %p',
    async (value, ok) => {
      expect((await validate(plainToInstance(LessonPositionDto, { position_seconds: value }))).length === 0).toBe(ok);
    },
  );

  it('position_sec, the old name, is not the field', async () => {
    expect(await validate(plainToInstance(LessonPositionDto, { position_sec: 40 }))).not.toEqual([]);
  });
});
