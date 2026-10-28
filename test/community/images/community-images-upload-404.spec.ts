/**
 * SPACE-404-CLASS (operator ruling 6353734516 on b#1137), FR-1161R B1(2):
 * POST /community/cohorts/:cohortId/images/upload-url. A space the caller
 * cannot open (another workspace's space, a space they were removed or banned
 * from) answers the same 404 status and body as a space id that does not
 * exist, before any link is signed or erasure recorded. A readable member, the
 * space's coach and the platform owner still get a link. FEATURE_COMMUNITY_IMAGES
 * off stays a bare 404.
 */
import { HttpException, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthedRequest } from '../../../src/auth/auth-request';
import type { CommunityAccessService } from '../../../src/community/community-access.service';
import type { CommunityImageStore } from '../../../src/community/images/community-image-store';
import { CommunityImagesController } from '../../../src/community/images/community-images.controller';
import type { PrismaService } from '../../../src/prisma.service';

function stub<T>(v: unknown): T {
  return v as T;
}

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '22222222-2222-4222-8222-333333333333';
const SPACE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_SPACE = '11111111-1111-4111-8111-999999999999';
const ABSENT_SPACE = '11111111-1111-4111-8111-000000000000';
const COACH = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_COACH = 'cccccccc-0000-4000-8000-000000000002';
const MEMBER = 'aaaaaaaa-0000-4000-8000-000000000001';
const REMOVED = 'aaaaaaaa-0000-4000-8000-000000000002';
const BANNED = 'aaaaaaaa-0000-4000-8000-000000000003';
const OWNER = 'eeeeeeee-0000-4000-8000-000000000001';

const cohorts: Record<string, { id: string; workspace_id: string; kind: string }> = {
  [SPACE]: { id: SPACE, workspace_id: WS, kind: 'group' },
  [FOREIGN_SPACE]: { id: FOREIGN_SPACE, workspace_id: OTHER_WS, kind: 'group' },
};
const coachOf: Record<string, string> = { [WS]: COACH, [OTHER_WS]: OTHER_COACH };

function caller(id: string, role: string): AuthedRequest {
  return stub<AuthedRequest>({ user: stub<User>({ id, role }) });
}

function world() {
  const access = stub<CommunityAccessService>({
    findCohort: jest.fn(async (id: string) => cohorts[id] ?? null),
    // Who can open a space: its workspace's coach, an active member of it
    // (MEMBER in SPACE only), the platform owner. REMOVED and BANNED cannot.
    canAccessCohort: jest.fn(async (c: { id: string; workspace_id: string }, u: User) => {
      if (u.role === 'owner') return true;
      if (coachOf[c.workspace_id] === u.id) return true;
      return u.id === MEMBER && c.id === SPACE;
    }),
  });
  const signUpload = jest.fn(async (owner: string, cohortId: string) => ({
    upload_url: `https://storage.test/upload/${owner}/${cohortId}`,
    key: `community-images/${owner}/${cohortId}/k.jpg`,
    expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    sweep_at: new Date(Date.now() + 7_500_000),
  }));
  const erasures: Array<Record<string, unknown>> = [];
  const prisma = {
    communityVoiceErasure: {
      updateMany: async () => ({ count: 0 }),
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: `er-${erasures.length + 1}`, attempts: 0, ...create };
        erasures.push(row);
        return row;
      },
    },
  };
  const controller = new CommunityImagesController(
    access,
    stub<CommunityImageStore>({ signUpload }),
    stub<PrismaService>(prisma),
  );
  return { controller, signUpload, erasures };
}

const dto = { mime: 'image/jpeg' as const, size_bytes: 2 * 1024 * 1024 };

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error('expected the call to be refused');
}

beforeEach(() => {
  process.env.FEATURE_COMMUNITY_IMAGES = 'true';
});
afterEach(() => {
  delete process.env.FEATURE_COMMUNITY_IMAGES;
});

describe('POST cohorts/:cohortId/images/upload-url — foreign answers like missing (SPACE-404-CLASS)', () => {
  it('answers a missing space with the class 404', async () => {
    const { controller } = world();
    const missing = await refusal(controller.uploadUrl(caller(MEMBER, 'student'), ABSENT_SPACE, dto));
    expect(missing).toEqual({
      status: 404,
      body: { error: 'not_found', code: 'community.cohort.not_found' },
    });
  });

  it('answers every unreadable space exactly like a missing one, and signs nothing', async () => {
    const { controller, signUpload, erasures } = world();
    const missing = await refusal(controller.uploadUrl(caller(MEMBER, 'student'), ABSENT_SPACE, dto));
    const refused: Array<[AuthedRequest, string]> = [
      [caller(MEMBER, 'student'), FOREIGN_SPACE], // another workspace's space
      [caller(REMOVED, 'student'), SPACE], // removed from the space
      [caller(BANNED, 'student'), SPACE], // banned from the community
      [caller(OTHER_COACH, 'coach'), SPACE], // another coach
      [caller(COACH, 'coach'), FOREIGN_SPACE], // this coach, other workspace
    ];
    for (const [req, space] of refused) {
      expect(await refusal(controller.uploadUrl(req, space, dto))).toEqual(missing);
    }
    expect(signUpload).not.toHaveBeenCalled();
    expect(erasures).toHaveLength(0);
  });

  it('still signs for a readable member, the space coach and the platform owner', async () => {
    const { controller, signUpload, erasures } = world();
    for (const req of [caller(MEMBER, 'student'), caller(COACH, 'coach'), caller(OWNER, 'owner')]) {
      const out = await controller.uploadUrl(req, SPACE, dto);
      expect(out.key).toContain(`/${req.user.id}/${SPACE}/`);
      expect(out).not.toHaveProperty('sweep_at');
    }
    expect(signUpload).toHaveBeenCalledTimes(3);
    expect(erasures).toHaveLength(3);
  });

  it('keeps the bare 404 with FEATURE_COMMUNITY_IMAGES off', async () => {
    delete process.env.FEATURE_COMMUNITY_IMAGES;
    const { controller, signUpload } = world();
    await expect(controller.uploadUrl(caller(MEMBER, 'student'), SPACE, dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(signUpload).not.toHaveBeenCalled();
  });
});
