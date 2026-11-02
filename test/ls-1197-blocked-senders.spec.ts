import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import type { Prisma } from '@prisma/client';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { CoachBriefService } from '../src/coach/brief/coach-brief.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

interface BriefReads {
  aggregateSoloContext(coach: string, clients: string[], zone: string, date: string): Promise<{
    unreadThreads: Array<{ message_preview: string }>;
  }>;
  ownThreadPreviews(coach: string, rows: Array<{ brief_mode: string; action_items: Prisma.JsonValue }>): Promise<
    (items: Prisma.JsonValue) => Prisma.JsonValue
  >;
}

describe('LS-1197 B1: count-rule must check the actual author, not only the thread client', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  const head = randomUUID();
  const client = randomUUID();
  const assistant = randomUUID();
  const control = 'Client control words';
  const hidden = 'Words from another coach';

  beforeAll(async () => {
    fixture = await ls1197Database();
    for (const [id, role, coach] of [[head, 'coach', null], [client, 'student', head], [assistant, 'coach', head]] as const) {
      await fixture.prisma.user.create({ data: {
        id, supabase_id: randomUUID(), email: randomUUID(), name: 'Review fixture', role, coach_id: coach,
      } });
    }
    const at = Date.now() - 2000;
    await fixture.prisma.coachMessage.create({ data: {
      coach_id: head, client_id: client, sender_id: client, body: control, created_at: new Date(at),
    } });
    // A coach-side sender in the head's canonical thread is normal team messaging.
    await fixture.prisma.coachMessage.create({ data: {
      coach_id: head, client_id: client, sender_id: assistant, body: hidden, created_at: new Date(at + 1000),
    } });
  }, 240_000);
  afterAll(async () => { await fixture?.stop(); });

  const reads = [
    {
      name: 'Command Center latest preview',
      read: async () => {
        const service = stub<CommandCenterService>(Object.assign(Object.create(CommandCenterService.prototype), { prisma: fixture.db }));
        return (await service.getInbox(head, {})).threads.map((t) => t.last_message_preview);
      },
    },
    {
      name: 'Coach Brief generated preview and AI input',
      read: async () => {
        const service = stub<BriefReads>(Object.assign(Object.create(CoachBriefService.prototype), { prisma: fixture.db }));
        return (await service.aggregateSoloContext(head, [client], 'UTC', '2026-10-30')).unreadThreads.map((t) => t.message_preview);
      },
    },
    {
      name: 'Coach Brief stored preview',
      read: async () => {
        const service = stub<BriefReads>(Object.assign(Object.create(CoachBriefService.prototype), { prisma: fixture.db }));
        const items = [{ type: 'message_unread', client_id: client, detail: hidden }];
        const keep = await service.ownThreadPreviews(head, [{ brief_mode: 'solo_coach', action_items: items }]);
        return JSON.stringify(keep(items));
      },
    },
  ];
  for (const read of reads) {
    for (const direction of ['viewer blocks author', 'author blocks viewer']) {
      it(`${read.name}: ${direction} must hide that author's words`, async () => {
        expect(JSON.stringify(await read.read())).toContain(hidden);
        const pair = direction === 'viewer blocks author'
          ? { blocker_id: head, blocked_id: assistant }
          : { blocker_id: assistant, blocked_id: head };
        await fixture.prisma.userBlock.create({ data: pair });
        try {
          expect(JSON.stringify(await read.read())).not.toContain(hidden);
        } finally {
          await fixture.prisma.userBlock.deleteMany({ where: pair });
        }
        expect(JSON.stringify(await read.read())).toContain(hidden);
      });
    }
  }

  it('control: the original forty live count cases still pass on this same product tree', () => {
    execFileSync(process.execPath, [require.resolve('jest/bin/jest'), '--config', 'jest.rls.config.js',
      '--runInBand', '--runTestsByPath', 'test/rls/count-deleted-be-rls.spec.ts'], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, TEST_DATABASE_URL: fixture.url },
      stdio: 'inherit',
      timeout: 120_000,
    });
  }, 150_000);
});
