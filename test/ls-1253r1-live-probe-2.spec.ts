/**
 * LS-1253R1 lens probe 2 (never merge): which spelling of the community id the DM push link carries when the caller
 * sends the route's workspace id in another spelling Postgres reads as the same uuid. Disposable postgres:15.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { ls1197Database } from './ls-1197-live-fixture';
import { CommunityAccessService } from '../src/community/community-access.service';
import { CommunitySafetyService } from '../src/community/safety/community-safety.service';
import { CommunityDmsService } from '../src/community/dms/community-dms.service';
import { CommunityDmsRepository } from '../src/community/dms/community-dms.repository';

jest.setTimeout(600_000);
const stub = <T>(v: unknown): T => v as T;

describe('LS-1253R1 live probe 2: the spelling of ?workspace= in the DM push link', () => {
  let db: Awaited<ReturnType<typeof ls1197Database>>;
  let prisma: PrismaClient;
  let dms: CommunityDmsService;
  const pushes: Array<{ recipientId: string; deepLink?: string }> = [];
  const K = randomUUID();
  const A = randomUUID();
  const ws = randomUUID();
  const space = randomUUID();
  const su = (sql: string, ...params: unknown[]) => prisma.$executeRawUnsafe(sql, ...params);

  beforeAll(async () => {
    db = await ls1197Database();
    prisma = db.prisma;
    await su(
      `INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'probe coach', 'coach'::"Role", NULL)`,
      K,
      randomUUID(),
      `ls1253r1b-${K}`,
    );
    await su(
      `INSERT INTO "User" ("id", "supabase_id", "email", "name", "role", "coach_id") VALUES ($1, $2, $3, 'probe member', 'student'::"Role", $4)`,
      A,
      randomUUID(),
      `ls1253r1b-${A}`,
      K,
    );
    await su(
      `INSERT INTO "community_workspaces" ("id", "coach_id", "name", "slug", "updated_at") VALUES ($1::uuid, $2, 'probe workspace', $3, now())`,
      ws,
      K,
      `ls1253r1b-${ws.slice(0, 8)}`,
    );
    await su(
      `INSERT INTO "community_cohorts" ("id", "workspace_id", "name", "visibility", "updated_at") VALUES ($1::uuid, $2::uuid, 'probe space', 'members'::"CommunitySpaceVisibility", now())`,
      space,
      ws,
    );
    await su(
      `INSERT INTO "community_memberships" ("id", "workspace_id", "cohort_id", "user_id", "updated_at") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())`,
      randomUUID(),
      ws,
      space,
      A,
    );
    const realtime = {
      channels: {
        cohort: () => 'cohort',
        workspace: () => 'workspace',
        user: () => 'user',
        moderation: () => 'moderation',
      },
      cohortShard: () => 0,
      broadcastCommunityEvent: async () => undefined,
    };
    const push = {
      pushEnabled: () => true,
      sendCommunityPush: async (q: { recipientId: string; deepLink?: string }) => {
        pushes.push(q);
      },
    };
    dms = new CommunityDmsService(
      new CommunityAccessService(db.db),
      new CommunityDmsRepository(db.db),
      stub(realtime),
      stub(push),
      new CommunitySafetyService(db.db),
    );
  }, 600_000);
  afterAll(async () => {
    await db?.stop();
  });

  it('each spelling of the same community id: the send answer, the link the recipient gets and the stored thread key', async () => {
    const sender = stub<User>({ id: A, role: 'student', coach_id: K });
    const spellings: Record<string, string> = {
      canonical: ws,
      upper: ws.toUpperCase(),
      simple: ws.replace(/-/g, ''),
      braced: `{${ws}}`,
      urn: `urn:uuid:${ws}`,
    };
    const got: Record<string, unknown> = {};
    for (const [label, spelled] of Object.entries(spellings)) {
      const before = pushes.length;
      let answer: string;
      try {
        await dms.send(sender, spelled, K, `Checking in ${label}`);
        answer = '200';
      } catch (e) {
        answer = e instanceof HttpException ? `${e.getStatus()}` : `error ${(e as Error).name}`;
      }
      const row = await prisma.communityMessage.findFirst({
        where: { body: `Checking in ${label}` },
        select: { dm_key: true, workspace_id: true },
      });
      got[label] = {
        answer,
        link: pushes
          .slice(before)
          .map((q) =>
            q.deepLink
              ?.replace(A, '<A>')
              .split(ws)
              .join('<ws>')
              .split(ws.toUpperCase())
              .join('<WS>')
              .split(ws.replace(/-/g, ''))
              .join('<wssimple>'),
          ),
        key:
          row?.dm_key
            ?.split(ws)
            .join('<ws>')
            .split(ws.toUpperCase())
            .join('<WS>')
            .split(ws.replace(/-/g, ''))
            .join('<wssimple>')
            .replace(A, '<A>')
            .replace(K, '<K>') ?? null,
        stored: row ? row.workspace_id === ws : null,
      };
    }
    // The hypothesis; a difference prints what the server did.
    expect(got).toEqual({
      canonical: {
        answer: '200',
        link: ['tgp://community/dm/<A>?workspace=<ws>'],
        key: expect.any(String),
        stored: true,
      },
      upper: {
        answer: '200',
        link: ['tgp://community/dm/<A>?workspace=<ws>'],
        key: expect.any(String),
        stored: true,
      },
      simple: {
        answer: '200',
        link: ['tgp://community/dm/<A>?workspace=<ws>'],
        key: expect.any(String),
        stored: true,
      },
      braced: {
        answer: '200',
        link: ['tgp://community/dm/<A>?workspace=<ws>'],
        key: expect.any(String),
        stored: true,
      },
      urn: {
        answer: '200',
        link: ['tgp://community/dm/<A>?workspace=<ws>'],
        key: expect.any(String),
        stored: true,
      },
    });
    console.warn('SPELLINGS ' + JSON.stringify(got));
  });
});
