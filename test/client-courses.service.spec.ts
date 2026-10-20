import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { ClientCoursesController } from '../src/courses/client-courses.controller';
import { LessonPositionDto } from '../src/courses/client-courses.dto';
import { ClientCoursesService } from '../src/courses/client-courses.service';
import type { PrismaService } from '../src/prisma.service';

// Two clients (A, B) in two coaches' courses, and a draft. The fake database
// answers only for the user_id the service asks about, so a read that forgot
// its tenant filter would hand one client the other's course.
const lesson = (id: string) => ({ id, title: `Title ${id}`, kind: 'both' });
const module_ = (id: string, position: number, opens: number, ...ids: string[]) => ({
  id,
  position,
  title: `Week ${position}`,
  note: null,
  opens_after_days: opens,
  lessons: ids.map(lesson),
});
const course = (id: string, status: string, week_rule: string, modules: ReturnType<typeof module_>[]) => ({
  id,
  status,
  title: `Course ${id}`,
  summary: null,
  week_rule,
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
  starts_on: new Date('2026-10-05T00:00:00Z'),
  ended_at: null,
  opened_all_at: null,
  created_at: new Date('2026-10-05T00:00:00Z'),
  course: c,
  ...extra,
});
const CONTENT: Record<string, object> = {
  l1: { description: null, body_markdown: 'OPEN-BODY-1', video_url: null, article_url: null, media_asset_id: null },
  l2: { description: null, body_markdown: 'OPEN-BODY-2', video_url: 'https://cdn.example/open.mp4', article_url: null, media_asset_id: 'asset-open' },
  l4: { description: null, body_markdown: 'LOCKED-BODY', video_url: 'https://cdn.example/locked.mp4', article_url: null, media_asset_id: 'asset-locked' },
};

interface EnrolmentQuery {
  where: { user_id: string; course_id?: string; course: { modules?: { some: { lessons: { some: { id: string } } } } } };
}
interface UserLessonsQuery {
  where: { user_id: string; lesson_id: { in: string[] } };
}
interface LessonsQuery {
  where: { id: { in: string[] } };
}

function setup(enrolments: ReturnType<typeof enrol>[], marks: [string, string][] = [], progress: [string, string, number][] = []) {
  const published = (e: ReturnType<typeof enrol>) => e.course.status === 'published';
  const holds = (e: ReturnType<typeof enrol>, id: string) => e.course.modules.some((m) => m.lessons.some((l) => l.id === id));
  const db = {
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
    },
    lesson: {
      findMany: jest.fn(async ({ where }: LessonsQuery) => where.id.in.map((id) => ({ id, ...CONTENT[id] }))),
    },
    lessonProgress: {
      findMany: jest.fn(async ({ where }: UserLessonsQuery) =>
        progress
          .filter(([u, l]) => u === where.user_id && where.lesson_id.in.includes(l))
          .map(([, l, s]) => ({ lesson_id: l, position_seconds: s })),
      ),
      upsert: jest.fn(async () => ({})),
    },
    notificationPreferences: { findUnique: jest.fn(async () => null) },
    coachProfile: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => null) },
  };
  // @ts-expect-error partial PrismaService double: the service reads only these delegates
  const prisma: PrismaService = db;
  return { db, service: new ClientCoursesService(prisma) };
}

describe('ClientCoursesService (LEARN-BE2)', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-12T20:00:00Z') }));
  afterEach(() => jest.useRealTimers());
  const all = () => [enrol('A', C1), enrol('A', C3), enrol('B', C2)];

  it('lists only the caller\'s published courses with a progress summary', async () => {
    const { service, db } = setup(all(), [['A', 'l1']]);
    expect(await service.list('A')).toEqual([
      {
        id: 'c1',
        title: 'Course c1',
        summary: null,
        starts_on: '2026-10-05',
        done: 1,
        total: 5,
        weeks_open: 2,
        weeks_total: 3,
        current_week: 1,
        next_unlock_on: '2026-10-19',
      },
    ]);
    // Reads by enrolment alone: a deleted coach's course is kept, so no coach filter.
    expect(db.courseEnrolment.findMany.mock.calls[0][0].where).toEqual({ user_id: 'A', course: { status: 'published' } });
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

  it('never sends a locked week\'s body, link or media, and never reads them', async () => {
    const { service, db } = setup(all());
    const detail = await service.detail('A', 'c1');
    const text = JSON.stringify(detail);
    for (const secret of ['LOCKED-BODY', 'locked.mp4', 'asset-locked']) expect(text).not.toContain(secret);
    expect(db.lesson.findMany.mock.calls[0][0].where).toEqual({ id: { in: ['l1', 'l1b', 'l2', 'l3'] } });
    const [w1, , w3] = detail.weeks;
    expect(w3).toMatchObject({ open: false, opens_on: '2026-10-19', total: 1 });
    expect(w3.lessons).toEqual([{ id: 'l4', title: 'Title l4', kind: 'both', done: false }]);
    expect(w1.lessons[0]).toMatchObject({ id: 'l1', body_markdown: 'OPEN-BODY-1', position_seconds: 0 });
  });

  it('opens a locked week for a client the coach opened all weeks for', async () => {
    const { service } = setup([enrol('A', C1, { opened_all_at: new Date('2026-10-06T00:00:00Z') })]);
    const detail = await service.detail('A', 'c1');
    expect(detail.weeks.every((w) => w.open)).toBe(true);
    expect(detail.weeks[2].lessons[0]).toMatchObject({ body_markdown: 'LOCKED-BODY', media_asset_id: 'asset-locked' });
  });

  it('gives completion state and the resume position', async () => {
    const { service } = setup(all(), [['A', 'l1'], ['B', 'l1b']], [['A', 'l2', 95], ['A', 'l1', 30], ['B', 'l1b', 12]]);
    const detail = await service.detail('A', 'c1');
    expect(detail.weeks[0].lessons.map((l) => l.done)).toEqual([true, false]);
    expect(detail.weeks[1].lessons[0]).toMatchObject({ id: 'l2', position_seconds: 95 });
    // l1 is done, so the resume point is l2; B's marks and positions never count for A.
    expect(detail.resume).toEqual({ lesson_id: 'l2', position_seconds: 95 });
    expect(detail.done).toBe(1);
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
});

describe('ClientCoursesController (LEARN-BE2)', () => {
  it('is student-only and passes the signed-in id, never an id from the request', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, ClientCoursesController)).toEqual(['student']);
    const courses = { list: jest.fn(async () => []), detail: jest.fn(async () => ({})), savePosition: jest.fn(async () => undefined) };
    // @ts-expect-error partial service double: the controller calls only these three methods
    const service: ClientCoursesService = courses;
    const controller = new ClientCoursesController(service);
    const req = { user: { id: 'A' } };
    // @ts-expect-error partial request double: the controller reads only req.user.id
    const authed: Parameters<typeof controller.list>[0] = req;
    await controller.list(authed);
    await controller.detail(authed, 'c1');
    await controller.savePosition(authed, 'l2', { position_sec: 40 });
    expect(courses.list).toHaveBeenCalledWith('A');
    expect(courses.detail).toHaveBeenCalledWith('A', 'c1');
    expect(courses.savePosition).toHaveBeenCalledWith('A', 'l2', 40);
  });

  it.each([[0, true], [86400, true], [-1, false], [1.5, false], [86401, false], ['9', false]])(
    'position_sec %p valid: %p',
    async (value, ok) => {
      const errors = await validate(plainToInstance(LessonPositionDto, { position_sec: value }));
      expect(errors.length === 0).toBe(ok);
    },
  );
});
