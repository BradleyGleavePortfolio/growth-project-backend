/**
 * B-610-7 (#610 fix round 5) live proof for community_messages_scope_shape_check
 * on a database migrated with the real chain (`prisma migrate deploy`, CI job
 * community-live-tests).
 *
 * Section 5 of 20270211000000 widened the check so comments on workspace-wide
 * posts / challenges (cohort_id NULL) can be stored. The first version let a
 * NULL discriminator turn the comment arm UNKNOWN, and a CHECK accepts
 * UNKNOWN, so a cohort-less UNTAGGED row slipped through. Every nullable
 * discriminator / id combination is inserted here as the migration owner
 * (constraints apply to every role) and must be refused with 23514 on this
 * exact constraint, while the legitimate shapes still insert.
 *
 * GATE: env-gated on COMMUNITY_TEST_DATABASE_URL (skips with a logged reason
 * when unset; never a silent pass).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { liveDbUrl } from '../_support/community-db';
import { insertLiveUser } from '../_support/community-live-seed';

const itLive = liveDbUrl() ? describe : describe.skip;

if (!liveDbUrl()) {
  // eslint-disable-next-line no-console
  console.warn('[community-message-shape] COMMUNITY_TEST_DATABASE_URL not set — live spec skipped.');
}

interface Shape {
  scope: 'cohort' | 'dm';
  cohort: boolean;
  dmKey: string | null;
  type: string | null;
  contextId: boolean;
}

itLive('community_messages scope-shape CHECK (live DB, B-610-7)', () => {
  let prisma: PrismaClient;
  const tag = randomUUID().slice(0, 8);
  const coachId = randomUUID();
  let wsId = '';
  let cohortId = '';

  async function insert(s: Shape): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO community_messages
        (id, workspace_id, cohort_id, scope, dm_key, sender_id, body,
         plan_context_type, plan_context_id, updated_at)
      VALUES
        (${randomUUID()}::uuid, ${wsId}::uuid,
         ${s.cohort ? cohortId : null}::uuid,
         ${s.scope}::"CommunityMessageScope", ${s.dmKey}, ${coachId}, 'shape probe',
         ${s.type}, ${s.contextId ? randomUUID() : null}::uuid, now())`;
  }

  async function expectRefused(s: Shape): Promise<void> {
    await expect(insert(s)).rejects.toThrow(/community_messages_scope_shape_check/);
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: liveDbUrl() as string } } });
    await prisma.$connect();
    await insertLiveUser(prisma, { id: coachId, role: 'coach', name: `Shape ${tag}`, coachId: null });
    const ws = await prisma.communityWorkspace.create({
      data: { coach_id: coachId, name: `Shape ${tag}`, slug: `shape-${tag}` },
    });
    wsId = ws.id;
    const cohort = await prisma.communityCohort.create({
      data: { workspace_id: ws.id, name: `Shape cohort ${tag}` },
    });
    cohortId = cohort.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRaw`DELETE FROM community_messages WHERE workspace_id = ${wsId}::uuid`;
    await prisma.$executeRaw`DELETE FROM community_cohorts WHERE workspace_id = ${wsId}::uuid`;
    await prisma.$executeRaw`DELETE FROM community_workspaces WHERE id = ${wsId}::uuid`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE id = ${coachId}`;
    await prisma.$disconnect();
  });

  it('still stores every legitimate shape', async () => {
    // Plain cohort chat.
    await insert({ scope: 'cohort', cohort: true, dmKey: null, type: null, contextId: false });
    // Comment on a Hall post / workspace-wide challenge (no cohort).
    await insert({
      scope: 'cohort',
      cohort: false,
      dmKey: null,
      type: 'community_post_comment',
      contextId: true,
    });
    await insert({
      scope: 'cohort',
      cohort: false,
      dmKey: null,
      type: 'community_challenge_comment',
      contextId: true,
    });
    // DM.
    await insert({ scope: 'dm', cohort: false, dmKey: `dm:${tag}`, type: null, contextId: false });
  });

  it('refuses the cohort-less untagged row the NULL discriminator used to admit', async () => {
    await expectRefused({ scope: 'cohort', cohort: false, dmKey: null, type: null, contextId: true });
  });

  it('refuses every other cohort-less shape that is not a tagged comment naming its parent', async () => {
    const refused: Shape[] = [
      { scope: 'cohort', cohort: false, dmKey: null, type: null, contextId: false },
      { scope: 'cohort', cohort: false, dmKey: null, type: 'community_post_comment', contextId: false },
      { scope: 'cohort', cohort: false, dmKey: null, type: 'plan_week', contextId: true },
      { scope: 'cohort', cohort: false, dmKey: `dm:${tag}`, type: 'community_post_comment', contextId: true },
      { scope: 'cohort', cohort: true, dmKey: `dm:${tag}`, type: null, contextId: false },
      { scope: 'dm', cohort: true, dmKey: `dm:${tag}`, type: null, contextId: false },
      { scope: 'dm', cohort: false, dmKey: null, type: null, contextId: false },
      { scope: 'dm', cohort: false, dmKey: null, type: 'community_post_comment', contextId: true },
    ];
    for (const shape of refused) await expectRefused(shape);
  });
});
