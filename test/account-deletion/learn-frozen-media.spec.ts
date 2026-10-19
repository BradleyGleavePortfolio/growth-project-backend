/**
 * LEARN-FROZEN-MEDIA: a client's kept lesson keeps its video when the coach is deleted. The
 * manifest keeps the coach media a kept lesson plays (a lesson someone completed, or in a course
 * someone is enrolled in) and deletes the rest; grants on the coach's media are settled after the
 * manifest, so a grant on kept media can stay for the clients who keep the lesson. The live case
 * is test/rls/learn-frozen-media-rls.spec.ts.
 */
import type { Prisma } from '@prisma/client';
import {
  ERASURE_MANIFEST,
  executeErasureManifest,
} from '../../src/account-deletion/account-deletion.manifest';

function stub<T>(value: unknown): T {
  return value as T;
}

const KEPT_LESSON = {
  OR: [{ completions: { some: {} } }, { module: { course: { enrolments: { some: {} } } } }],
};

describe('LEARN-FROZEN-MEDIA: coach media behind a kept lesson', () => {
  const at = (model: string, field: string) =>
    ERASURE_MANIFEST.findIndex((e) => e.model === model && e.field === field);
  const lastAt = (model: string) =>
    ERASURE_MANIFEST.reduce((last, e, i) => (e.model === model ? i : last), -1);

  it('deletes the coach media no kept lesson plays and keeps the rest', () => {
    const media = ERASURE_MANIFEST.filter((e) => e.model === 'CoachMediaAsset');
    expect(media).toEqual([
      {
        model: 'CoachMediaAsset',
        field: 'coach_id',
        action: { op: 'delete' },
        where: { lessons: { none: KEPT_LESSON } },
        // COACH-GONE-DELIVERY: also kept when a held purchase delivered or owes it.
        owed: ['id'],
      },
      { model: 'CoachMediaAsset', field: 'coach_id', action: { op: 'retain', reason: expect.any(String) } },
    ]);
  });

  it('a kept lesson is exactly one the two Lesson delete entries leave', () => {
    const lessonDeletes = ERASURE_MANIFEST.filter(
      (e) => e.model === 'Lesson' && e.action.op === 'delete',
    ).map((e) => e.where);
    // Deleted: nobody completed it and (it is a single lesson, or nobody is enrolled in its course).
    // Kept: someone completed it, or someone is enrolled in its course (a single lesson has no course).
    expect(lessonDeletes).toEqual([
      { completions: { none: {} }, module_id: null },
      { completions: { none: {} }, module: { course: { enrolments: { none: {} } } } },
    ]);
  });

  it("runs after the deleted person's own completions and enrolments and after every Lesson entry", () => {
    const mediaDelete = at('CoachMediaAsset', 'coach_id');
    expect(at('LessonCompletion', 'user_id')).toBeLessThan(mediaDelete);
    expect(at('CourseEnrolment', 'user_id')).toBeLessThan(mediaDelete);
    expect(lastAt('Lesson')).toBeLessThan(mediaDelete);
  });

  type Step = { op: string; values?: unknown[] };
  function recordingTx(ownedMedia: string[]) {
    const order: Step[] = [];
    const delegate = (model: string) => ({
      findMany: async () => (model === 'coachMediaAsset' ? ownedMedia.map((id) => ({ id })) : []),
      deleteMany: async (args: unknown) => {
        order.push({ op: `${model}.deleteMany`, values: [args] });
        return { count: 0 };
      },
      updateMany: async () => ({ count: 0 }),
    });
    const top: Record<string, unknown> = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        order.push({ op: `raw:${strings.join('?').replace(/\s+/g, ' ').trim()}`, values });
        return 2;
      },
      $queryRaw: async () => [{ present: false }],
    };
    const tx = new Proxy(top, {
      get: (target, prop: string) => (prop in target ? target[prop] : delegate(prop)),
    });
    return { tx: stub<Prisma.TransactionClient>(tx), order };
  }
  const ctx = {
    userId: 'coach-1',
    email: 'coach-1-email',
    tombstoneEmail: 'deleted-coach-1',
    now: new Date(),
  };
  const grantStep = (order: Step[]) =>
    order.findIndex((s) => s.op.startsWith('raw:DELETE FROM "ClientAssetGrant"'));

  it('settles grants on the coach media after the manifest, keeping only the clients who keep a lesson', async () => {
    const { tx, order } = recordingTx(['m-1', 'm-2']);
    const results = await executeErasureManifest(tx, ctx);
    const grants = grantStep(order);
    expect(grants).toBeGreaterThan(order.findIndex((s) => s.op === 'coachMediaAsset.deleteMany'));
    expect(grants).toBeGreaterThan(order.findIndex((s) => s.op === 'lesson.deleteMany'));
    const sql = order[grants].op;
    expect(order[grants].values).toEqual([['m-1', 'm-2'], []]);
    // A grant stays only for a client who completed a lesson playing it or is enrolled in its course.
    expect(sql).toContain('AND NOT EXISTS ( SELECT 1 FROM "Lesson" l WHERE l."media_asset_id" = g."media_asset_id"');
    expect(sql).toContain('c."lesson_id" = l."id" AND c."user_id" = g."client_id"');
    expect(sql).toContain('m."id" = l."module_id" AND e."user_id" = g."client_id"');
    // No other statement removes grants by media id any more.
    expect(
      order.filter((s) => s.op === 'clientAssetGrant.deleteMany').map((s) => s.values),
    ).toEqual([[{ where: { client_id: 'coach-1' } }]]);
    expect(results).toContainEqual({
      model: 'ClientAssetGrant',
      field: 'media_asset_id',
      op: 'delete',
      count: 2,
    });
  });

  it('a coach without media runs no grant statement', async () => {
    const { tx, order } = recordingTx([]);
    const results = await executeErasureManifest(tx, ctx);
    expect(grantStep(order)).toBe(-1);
    expect(results.some((r) => r.field === 'media_asset_id')).toBe(false);
  });
});
