import { MessagingService } from '../../src/messaging/messaging.service';
import type { PrismaService } from '../../src/prisma.service';
import type { SupabaseService } from '../../src/supabase/supabase.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { PtmService } from '../../src/ptm/ptm.service';
import type {
  MessageReceivedEmitter,
} from '../../src/notifications/emitters/message-received.emitter';
import type { AuditService } from '../../src/audit/audit.service';
import type { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { cast, FakeTable } from './_fake-db';

// B-609-3 — the coach welcome's idempotency key lives at the persistence
// boundary: the real MessagingService.sendAsCoach writes
// CoachMessage.welcome_job_id (@unique), and a second send for the same job
// returns the already-persisted row with no second realtime ping, push, audit,
// analytics, PTM signal or AI-context bust.

const COACH = 'coach-1';
const CLIENT = 'client-1';

function harness() {
  const users = new FakeTable([['id']]);
  // Same unique key as the real CoachMessage table.
  const messages = new FakeTable([['welcome_job_id']]);
  void users.create({ data: { id: COACH, role: 'coach', coach_id: null, name: 'Morgan Reyes' } });
  void users.create({ data: { id: CLIENT, role: 'student', coach_id: COACH, name: 'Dana Lee' } });
  const prisma = { user: users, coachMessage: messages };
  const broadcastNewMessage = jest.fn(async () => undefined);
  const emit = jest.fn();
  const write = jest.fn(async () => undefined);
  const capture = jest.fn();
  const ptmEmit = jest.fn();
  const invalidateForUser = jest.fn();
  const svc = new MessagingService(
    cast<PrismaService>(prisma),
    cast<SupabaseService>({ broadcastNewMessage }),
    cast<AnalyticsService>({ capture }),
    cast<PtmService>({ emit: ptmEmit }),
    cast<MessageReceivedEmitter>({ emit }),
    cast<AuditService>({ write }),
    cast<ClientAIContextService>({ invalidateForUser }),
  );
  const fanOut = () => ({
    pings: broadcastNewMessage.mock.calls.length,
    audits: write.mock.calls.length,
    analytics: capture.mock.calls.length,
    ptm: ptmEmit.mock.calls.length,
    aiBusts: invalidateForUser.mock.calls.length,
  });
  return { svc, messages, fanOut };
}

describe('MessagingService.sendAsCoach — welcomeJobId idempotency key (B-609-3)', () => {
  it('two sends for the same welcome job persist one row and fan out once', async () => {
    const h = harness();
    const send = () =>
      h.svc.sendAsCoach(COACH, CLIENT, { body: 'Welcome in.' }, { welcomeJobId: 'job-1' });
    const first = await send();
    const once = h.fanOut();
    const second = await send();
    expect(second.id).toBe(first.id);
    expect(h.messages.rows).toHaveLength(1);
    expect(h.messages.rows[0]).toMatchObject({ welcome_job_id: 'job-1', sender_id: COACH });
    expect(h.fanOut()).toEqual(once);
    expect(once).toEqual({ pings: 1, audits: 1, analytics: 1, ptm: 2, aiBusts: 1 });
  });

  it('different welcome jobs are independent', async () => {
    const h = harness();
    await h.svc.sendAsCoach(COACH, CLIENT, { body: 'Welcome in.' }, { welcomeJobId: 'job-1' });
    await h.svc.sendAsCoach(COACH, CLIENT, { body: 'Welcome in.' }, { welcomeJobId: 'job-2' });
    expect(h.messages.rows).toHaveLength(2);
  });

  it('an ordinary coach message carries no key and is never deduplicated', async () => {
    const h = harness();
    await h.svc.sendAsCoach(COACH, CLIENT, { body: 'Same words.' });
    await h.svc.sendAsCoach(COACH, CLIENT, { body: 'Same words.' });
    expect(h.messages.rows).toHaveLength(2);
    expect(h.messages.rows.every((r) => r.welcome_job_id === undefined)).toBe(true);
    expect(h.fanOut().pings).toBe(2);
  });

  it('a unique violation on some other key is not swallowed', async () => {
    const h = harness();
    jest
      .spyOn(h.messages, 'create')
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(
      h.svc.sendAsCoach(COACH, CLIENT, { body: 'Welcome in.' }, { welcomeJobId: 'job-9' }),
    ).rejects.toThrow('dup');
    expect(h.fanOut().pings).toBe(0);
  });
});
