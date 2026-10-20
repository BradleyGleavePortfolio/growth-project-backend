// COPILOT-BE — the client's side: Send (consent-gated, coachless refused, not counted), the status lines, the kill switch.
import { NotFoundException } from '@nestjs/common';
import { CopilotFeatureGuard, isCopilotEnabled } from '../../src/copilot/copilot.controller';
import { CopilotService } from '../../src/copilot/copilot.service';
import type { PrismaService } from '../../src/prisma.service';
import { ROMAN_REQUIRES_COACH } from '../../src/roman/roman-requires-coach';
import { egressWithGrants, fakeOf } from '../ai-egress/ai-egress.fakes';

const CLIENT = { id: 'client-a', role: 'student', coach_id: 'coach-k' };
const row = (status: string) => ({
  id: 'd1', status, payload: { kind: 'move_session' }, rationale: 'Thursday is your busiest day.', decision_note: null,
  created_at: new Date('2026-10-20T16:41:00Z'), decided_at: null,
});

function build(opts: { status?: string | null; granted?: boolean } = {}) {
  const prisma = {
    aiActionDraft: {
      updateMany: jest.fn(async () => ({ count: opts.status === 'suggested' ? 0 : 1 })),
      findFirst: jest.fn(async () => (opts.status === null ? null : row(opts.status ?? 'pending'))),
      findMany: jest.fn(async () => [row('approved')]),
      count: jest.fn(async () => 4),
    },
    romanUsageDaily: { upsert: jest.fn() },
  };
  const { egress } = egressWithGrants(opts.granted === false ? [] : [CLIENT.id]);
  return { svc: new CopilotService(fakeOf<PrismaService>(prisma), egress), prisma };
}

describe('POST /client/copilot/suggestions/:id/send', () => {
  it('hands the client\'s own unsent suggestion to their coach now, and counts nothing', async () => {
    const { svc, prisma } = build();
    await expect(svc.send(CLIENT, 'd1')).resolves.toMatchObject({ id: 'd1', status: 'pending', reason: 'Thursday is your busiest day.' });
    const [args] = prisma.aiActionDraft.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
    expect(args.where).toMatchObject({ id: 'd1', capability: 'client_path_change', requester_id: 'client-a', subject_user_id: 'client-a', status: 'suggested' });
    expect(args.data).toMatchObject({ status: 'pending', tenant_coach_id: 'coach-k' });
    expect(prisma.romanUsageDaily.upsert).not.toHaveBeenCalled();
  });
  it('without live AI consent nothing is sent', async () => {
    const { svc, prisma } = build({ granted: false });
    await expect(svc.send(CLIENT, 'd1')).rejects.toMatchObject({ status: 403, response: { code: 'ai_consent_required' } });
    expect(prisma.aiActionDraft.updateMany).not.toHaveBeenCalled();
  });
  it('a client with no coach gets ROMAN_REQUIRES_COACH; a coach cannot send', async () => {
    const { svc, prisma } = build();
    await expect(svc.send({ ...CLIENT, coach_id: null }, 'd1')).rejects.toMatchObject({ status: 403, response: { code: ROMAN_REQUIRES_COACH } });
    await expect(svc.send({ ...CLIENT, role: 'coach' }, 'd1')).rejects.toMatchObject({ status: 403 });
    expect(prisma.aiActionDraft.updateMany).not.toHaveBeenCalled();
  });
  it('someone else\'s row is 404; a lapsed unsent one is 409; a repeat Send answers the sent row', async () => {
    await expect(build({ status: null }).svc.send(CLIENT, 'd1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(build({ status: 'suggested' }).svc.send(CLIENT, 'd1')).rejects.toMatchObject({ status: 409, response: { code: 'COPILOT_SUGGESTION_EXPIRED' } });
    await expect(build({ status: 'approved' }).svc.send(CLIENT, 'd1')).resolves.toMatchObject({ status: 'approved' });
  });
});

describe('GET /client/copilot', () => {
  it('reads only the client\'s own sent suggestions, newest first, three of them, with the total', async () => {
    const { svc, prisma } = build();
    await expect(svc.recent('client-a')).resolves.toMatchObject({ suggestions: [{ id: 'd1', status: 'approved' }], suggestions_total: 4 });
    const where = { capability: 'client_path_change', requester_id: 'client-a', subject_user_id: 'client-a', status: { in: ['pending', 'approved', 'rejected', 'expired'] } };
    expect(prisma.aiActionDraft.findMany).toHaveBeenCalledWith({ where, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 3 });
    expect(prisma.aiActionDraft.count).toHaveBeenCalledWith({ where });
  });
});

describe('FEATURE_CLIENT_PATH_COPILOT', () => {
  const saved = process.env.FEATURE_CLIENT_PATH_COPILOT;
  afterEach(() => { if (saved === undefined) delete process.env.FEATURE_CLIENT_PATH_COPILOT; else process.env.FEATURE_CLIENT_PATH_COPILOT = saved; });
  it('is off unless exactly true; off answers 404', () => {
    delete process.env.FEATURE_CLIENT_PATH_COPILOT;
    expect(() => new CopilotFeatureGuard().canActivate()).toThrow(NotFoundException);
    expect(isCopilotEnabled({ FEATURE_CLIENT_PATH_COPILOT: '1' })).toBe(false);
    process.env.FEATURE_CLIENT_PATH_COPILOT = 'true';
    expect(new CopilotFeatureGuard().canActivate()).toBe(true);
  });
});
