import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { CommandCenterService } from '../src/coach/command-center/command-center.service';
import { loadHomeDay } from '../src/coach/command-center/coach-home-day';
import { CoachHomeService } from '../src/coach/home/coach-home.service';
import { PrismaService } from '../src/prisma.service';
import { ls1197Database } from './ls-1197-live-fixture';
import { stub } from './utils/trial-fakes';

describe('LS-1197R2 independent query-cost control', () => {
  let fixture: Awaited<ReturnType<typeof ls1197Database>>;
  let measured: Pick<PrismaClient, '$disconnect'>;
  let queries = 0;
  const head = randomUUID();
  const clientIds: string[] = [];

  beforeAll(async () => {
    fixture = await ls1197Database();
    await fixture.prisma.user.create({
      data: { id: head, role: 'coach', name: 'Cost control',
        email: randomUUID(), supabase_id: randomUUID() },
    });
  }, 240_000);
  afterAll(async () => {
    await measured?.$disconnect();
    await fixture?.stop();
  });

  it('inbox and Home use a fixed number of SQL queries at 1, 100 and 1000 threads', async () => {
    const database = new PrismaClient({
      datasources: { db: { url: fixture.url } },
      log: [{ emit: 'event', level: 'query' }],
    });
    measured = database;
    database.$on('query', (event) => {
      // The fence is instrumentation, not a query issued by a product reader.
      if (event.query.trim() !== 'SELECT 1') queries += 1;
    });
    await database.$connect();
    const db = stub<PrismaService>(database);
    const inbox = stub<CommandCenterService>(
      Object.assign(Object.create(CommandCenterService.prototype), { prisma: db }),
    );
    const oldHome = stub<{
      countReview(id: string, since: Date, until: Date): Promise<unknown>;
    }>(Object.assign(Object.create(CoachHomeService.prototype), { prisma: db }));
    const fence = async () => {
      // Query events arrive over the engine transport. Flush them before
      // reading/resetting the counter, otherwise one event can cross readers.
      await database.$queryRaw`SELECT 1`;
      await new Promise<void>((done) => setImmediate(done));
    };
    const results: Array<{
      threads: number; inbox: number; home: number; overview: number; review: number;
    }> = [];
    for (const size of [1, 100, 1000]) {
      const added = Array.from({ length: size - clientIds.length }, () => randomUUID());
      await fixture.prisma.user.createMany({
        data: added.map((id) => ({
          id, role: 'student' as const, coach_id: head, name: 'Cost control',
          email: randomUUID(), supabase_id: randomUUID(),
        })),
      });
      await fixture.prisma.coachMessage.createMany({
        data: added.map((id) => ({
          coach_id: head, client_id: id, sender_id: id, body: 'Allowed unread message',
        })),
      });
      clientIds.push(...added);
      await fence();
      queries = 0;
      const listed = await inbox.getInbox(head, { limit: 50 });
      expect(listed.threads).toHaveLength(Math.min(size, 50));
      await fence();
      const inboxQueries = queries;
      queries = 0;
      await loadHomeDay(db, {
        coachId: head, ownerCoachId: head, clientIds,
        habits: clientIds, workouts: clientIds, weighIns: clientIds, needsYou: [],
      }, 'UTC', new Date());
      await fence();
      const homeQueries = queries;
      queries = 0;
      // `home: true` takes the real overview -> loadHomeDay route as well.
      await inbox.getOverview(head, { home: true });
      await fence();
      const overviewQueries = queries;
      queries = 0;
      await oldHome.countReview(head, new Date(0), new Date('2100-01-01T00:00:00Z'));
      await fence();
      results.push({
        threads: size, inbox: inboxQueries, home: homeQueries,
        overview: overviewQueries, review: queries,
      });
    }
    console.log('LS-1197R2 SQL query counts', JSON.stringify(results));
    expect(results.every((row) => row.inbox > 0 && row.home > 0)).toBe(true);
    expect(new Set(results.map((row) => row.inbox)).size).toBe(1);
    expect(new Set(results.map((row) => row.home)).size).toBe(1);
    expect(new Set(results.map((row) => row.overview)).size).toBe(1);
    expect(new Set(results.map((row) => row.review)).size).toBe(1);
  }, 120_000);
});
