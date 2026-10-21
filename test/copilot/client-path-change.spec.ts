// COPILOT-BE — the client_path_change kind: payload rules, the coach's Edit and note, the apply handlers (consent and
// roster re-checked; Roman never applies), and the paged queue (oldest first, with the total).
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { AiActionDraft } from '@prisma/client';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import {
  ClientPathChangeMaterializer, CLIENT_PATH_CHANGE, parsePathChange, pathChangeNote,
} from '../../src/ai/gateway/materialisers/client-path-change.materialiser';
import type { CapabilityMaterializerRegistry } from '../../src/ai/gateway/materialisers/capability-materialiser.registry';
import type { AuditService } from '../../src/audit/audit.service';
import type { MacrosService } from '../../src/macros/macros.service';
import type { PrismaService } from '../../src/prisma.service';
import { egressWithGrants, fakeOf } from '../ai-egress/ai-egress.fakes';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const COACH = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';
const NOW = Date.now();
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const src = [{ kind: 'plan', id: TARGET, date: '2026-10-19', label: 'Target 2,150 kcal' }];
const move = { kind: 'move_session', assignment_id: SESSION, workout: 'Lower body B', from_at: day(2), to_at: day(3), sources: src };
const kcal = { kind: 'set_calorie_target', target_id: TARGET, from_kcal: 2150, to_kcal: 2000, sources: src };

const AUTO_TARGET = 'auto-55555555-5555-4555-8555-555555555555';

describe('client_path_change payload and note', () => {
  it('accepts the two kinds and refuses anything else', () => {
    expect(parsePathChange(move)).toMatchObject({ kind: 'move_session', workout: 'Lower body B' });
    expect(parsePathChange({ ...kcal, sources: undefined })).toMatchObject({ to_kcal: 2000, sources: [] });
    for (const bad of [{ ...move, kind: 'delete_plan' }, { ...move, extra: 1 }, { ...kcal, to_kcal: 500 }, { ...kcal, target_id: 'auto-x' },
      { ...move, sources: [{ ...src[0], kind: 'chat' }] }, null]) {
      expect(() => parsePathChange(bad)).toThrow(BadRequestException);
    }
  });
  it('takes every MacroTarget id producer: onboarding and profile (auto-<uuid>) and a coach target (plain uuid)', () => {
    // onboarding.service.ts and profile.service.ts both write `auto-${randomUUID()}`; coach targets take the uuid default.
    for (const target_id of [`auto-${randomUUID()}`, `auto-${randomUUID()}`, randomUUID(), TARGET, AUTO_TARGET]) {
      expect(parsePathChange({ ...kcal, target_id })).toMatchObject({ target_id });
    }
    for (const target_id of ['auto-', `auto-${randomUUID()}x`, `manual-${randomUUID()}`, 'x'.repeat(41)]) {
      expect(() => parsePathChange({ ...kcal, target_id })).toThrow(BadRequestException);
    }
  });
  it('a session moves only inside the client\'s own window: 2 days back to 7 ahead', () => {
    expect(parsePathChange({ ...move, to_at: day(-1.9) })).toMatchObject({ kind: 'move_session' });
    expect(parsePathChange({ ...move, to_at: day(6.9) })).toMatchObject({ kind: 'move_session' });
    for (const to_at of [day(-2.1), day(7.1), day(90)]) expect(() => parsePathChange({ ...move, to_at })).toThrow(BadRequestException);
  });
  it('the note is one trimmed line of at most 200 characters, or nothing', () => {
    expect(pathChangeNote('  Keep Thursday\n this week ')).toBe('Keep Thursday this week');
    expect(pathChangeNote('   ')).toBeNull();
    expect(pathChangeNote(undefined)).toBeNull();
    expect(() => pathChangeNote('x'.repeat(201))).toThrow(BadRequestException);
  });
});

type Over = { coachOf?: string; requester?: string; granted?: boolean; session?: Date | null; current?: object | null; claim?: number };
const LIVE_DAY = new Date(day(1));
function materialiser(over: Over = {}) {
  const writes: Array<[string, unknown]> = [];
  // The client's session sits on `session` now (default: where Roman saw it); the move matches only that day.
  const live = over.session === undefined ? new Date(move.from_at) : over.session;
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ role: 'student', coach_id: over.coachOf ?? COACH })) },
    aiActionDraft: {
      updateMany: jest.fn(async (a: { data: unknown }) => { writes.push(['draft', a.data]); return { count: over.claim ?? 1 }; }),
      update: jest.fn(async (a: { data: unknown }) => { writes.push(['ref', a.data]); return {}; }),
      findUnique: jest.fn(async () => ({ materialised_ref: SESSION })),
    },
    clientWorkoutAssignment: {
      findFirst: jest.fn(async () => (live ? { scheduled_for: live } : null)),
      updateMany: jest.fn(async (a: { where: { scheduled_for: Date } }) => {
        writes.push(['move', a]);
        return { count: live && a.where.scheduled_for.getTime() === live.getTime() ? 1 : 0 };
      }),
    },
  };
  const current = over.current === undefined ? { id: TARGET, calories_kcal: 2150, protein_g: 160, carbs_g: 220, fats_g: 70, fiber_g: 30 } : over.current;
  const macros = { getCurrentForClient: jest.fn(async () => current), createForClient: jest.fn(async () => ({ id: 'target-new' })) };
  const { egress } = egressWithGrants(over.granted === false ? [] : [CLIENT]);
  const m = new ClientPathChangeMaterializer(fakeOf<PrismaService>(prisma), egress, fakeOf<MacrosService>(macros));
  const draft = (payload: object) => fakeOf<AiActionDraft>({
    id: 'd1', capability: CLIENT_PATH_CHANGE, status: 'pending', requester_id: over.requester ?? CLIENT, subject_user_id: CLIENT, tenant_coach_id: COACH, payload,
  });
  return { m, draft, writes, prisma, macros };
}

describe('ClientPathChangeMaterializer (the apply handlers)', () => {
  it('move_session moves only the client\'s unfinished session still on its old day', async () => {
    const { m, draft, writes } = materialiser();
    await expect(m.materialize(draft(move))).resolves.toEqual({ status: 'sent', ref: SESSION });
    expect(writes.find(([k]) => k === 'move')?.[1]).toEqual({
      where: { id: SESSION, client_id: CLIENT, scheduled_for: new Date(move.from_at), completed_at: null, skipped_at: null },
      data: { scheduled_for: new Date(move.to_at) },
    });
  });
  it('a session that moved or finished since is refused and the claim is released for Edit or Decline', async () => {
    const { m, draft, writes } = materialiser({ session: LIVE_DAY });
    await expect(m.materialize(draft(move))).rejects.toMatchObject({ status: 409, response: { code: 'COPILOT_PLAN_CHANGED' } });
    expect(writes[writes.length - 1]).toEqual(['draft', { materialised_at: null }]);
  });
  it('set_calorie_target writes a coach target through MacrosService: protein kept, carbs and fats scaled', async () => {
    const { m, draft, macros } = materialiser();
    await expect(m.materialize(draft(kcal))).resolves.toEqual({ status: 'sent', ref: 'target-new' });
    expect(macros.createForClient).toHaveBeenCalledWith(COACH, CLIENT, { calories_kcal: 2000, protein_g: 160, carbs_g: 198, fats_g: 63, fiber_g: 30 }, 'coach');
  });
  it('the calorie floor and holds still refuse, and a changed target is stale', async () => {
    const floor = materialiser();
    floor.macros.createForClient.mockRejectedValueOnce(new BadRequestException('floor'));
    await expect(floor.m.materialize(floor.draft(kcal))).rejects.toBeInstanceOf(BadRequestException);
    expect(floor.writes[floor.writes.length - 1]).toEqual(['draft', { materialised_at: null }]);
    const changed = materialiser({ current: { id: 'other', calories_kcal: 2300, protein_g: 160, carbs_g: 240, fats_g: 75 } });
    await expect(changed.m.materialize(changed.draft(kcal))).rejects.toMatchObject({ status: 409 });
  });
  it('nothing applies without the client\'s live AI consent (403), after a move or for a draft the client did not send (404)', async () => {
    for (const [over, status] of [[{ granted: false }, 403], [{ coachOf: 'coach-b' }, 404], [{ requester: COACH }, 404]] as const) {
      const { m, draft, writes } = materialiser(over);
      await expect(m.materialize(draft(move))).rejects.toMatchObject({ status });
      await expect(m.edit(draft(move), { to_at: day(4) })).rejects.toMatchObject({ status });
      expect(writes).toEqual([]);
    }
  });
  it('a second approval finds the claim and answers the first result', async () => {
    const { m, draft, prisma } = materialiser({ claim: 0 });
    await expect(m.materialize(draft(move))).resolves.toEqual({ status: 'already_materialised', ref: SESSION });
    expect(prisma.clientWorkoutAssignment.updateMany).not.toHaveBeenCalled();
  });
});

describe('the coach\'s Edit (baseline refreshed to the live plan)', () => {
  it('changes only the one field the kind allows', async () => {
    const { m, draft } = materialiser();
    await expect(m.edit(draft(move), { assignment_id: TARGET })).rejects.toBeInstanceOf(BadRequestException);
    await expect(m.edit(draft(kcal), { to_at: day(4) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(m.edit(draft(move), { to_at: day(9) })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('move: takes the session\'s day now as the baseline', async () => {
    const { m, draft } = materialiser({ session: LIVE_DAY });
    await expect(m.edit(draft(move), { to_at: day(4) })).resolves.toMatchObject({ from_at: LIVE_DAY.toISOString(), to_at: day(4), assignment_id: SESSION });
  });
  it('target: takes the current target now as the baseline, onboarding ids included', async () => {
    const { m, draft } = materialiser({ current: { id: AUTO_TARGET, calories_kcal: 2300, protein_g: 160, carbs_g: 240, fats_g: 75 } });
    await expect(m.edit(draft(kcal), { to_kcal: 2050 })).resolves.toMatchObject({ target_id: AUTO_TARGET, from_kcal: 2300, to_kcal: 2050 });
  });
  it('a session done or skipped, or no target at all, is still 409', async () => {
    const done = materialiser({ session: null });
    await expect(done.m.edit(done.draft(move), { to_at: day(4) })).rejects.toMatchObject({ status: 409, response: { code: 'COPILOT_PLAN_CHANGED' } });
    const none = materialiser({ current: null });
    await expect(none.m.edit(none.draft(kcal), { to_kcal: 2050 })).rejects.toMatchObject({ status: 409 });
  });
});

function approvals(capability: string = CLIENT_PATH_CHANGE, over: Over & { payload?: object; sentAt?: Date } = {}) {
  const draft = {
    id: 'd1', capability, status: 'pending', requester_id: CLIENT, subject_user_id: CLIENT, tenant_coach_id: COACH,
    payload: over.payload ?? move, rationale: 'r', created_at: over.sentAt ?? new Date(NOW - 86_400_000),
  };
  const flips: Array<Record<string, unknown>> = [];
  const tx = {
    aiActionDraft: { updateMany: jest.fn(async (a: { data: Record<string, unknown> }) => { flips.push(a.data); return { count: 1 }; }) },
    aiRequestAudit: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  // The real apply handler behind the registry, on the same fake database the decision reads.
  const w = materialiser(over);
  const prisma = { ...w.prisma, aiActionDraft: { ...w.prisma.aiActionDraft, findUnique: jest.fn(async () => draft) }, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const registry = fakeOf<CapabilityMaterializerRegistry>({ resolve: () => w.m });
  const svc = new AiApprovalService(fakeOf<PrismaService>(prisma), fakeOf<AuditService>({ write: jest.fn(async () => undefined) }), registry);
  const decide = (o: object = {}) => svc.decide({ draftId: 'd1', decider: { id: COACH, role: 'coach' }, decision: 'approved', ...o });
  return { decide, flips, writes: w.writes, macros: w.macros, prisma };
}

describe('PATCH /ai/gateway/drafts/:id on a client_path_change draft', () => {
  it('Edit applies and stores the coach\'s day; the note is stored as one line', async () => {
    const { decide, flips, writes } = approvals();
    await decide({ editedPayload: { to_at: day(5) }, note: ' Friday\nworks better ' });
    expect(writes.find(([k]) => k === 'move')?.[1]).toMatchObject({ data: { scheduled_for: new Date(day(5)) } });
    expect(flips[0]).toMatchObject({ status: 'approved', decision_note: 'Friday works better', payload: expect.objectContaining({ to_at: day(5) }) });
  });
  it('stale, then Edit: a moved session answers 409, and the coach\'s Edit applies on the session\'s day now', async () => {
    const { decide, flips, writes } = approvals(CLIENT_PATH_CHANGE, { session: LIVE_DAY });
    await expect(decide()).rejects.toMatchObject({ status: 409, response: { code: 'COPILOT_PLAN_CHANGED' } });
    expect(flips).toEqual([]);
    await decide({ editedPayload: { to_at: day(5) } });
    expect(writes.filter(([k]) => k === 'move').pop()?.[1]).toMatchObject({ where: { scheduled_for: LIVE_DAY }, data: { scheduled_for: new Date(day(5)) } });
    expect(flips[0]).toMatchObject({ status: 'approved', payload: expect.objectContaining({ from_at: LIVE_DAY.toISOString(), to_at: day(5) }) });
  });
  it('stale, then Edit: a changed target answers 409, and the coach\'s Edit applies on the current target', async () => {
    const current = { id: AUTO_TARGET, calories_kcal: 2300, protein_g: 160, carbs_g: 240, fats_g: 75, fiber_g: 30 };
    const { decide, flips, macros } = approvals(CLIENT_PATH_CHANGE, { payload: kcal, current });
    await expect(decide()).rejects.toMatchObject({ status: 409, response: { code: 'COPILOT_PLAN_CHANGED' } });
    await decide({ editedPayload: { to_kcal: 2050 } });
    expect(macros.createForClient).toHaveBeenCalledWith(COACH, CLIENT, expect.objectContaining({ calories_kcal: 2050, protein_g: 160 }), 'coach');
    expect(flips[0]).toMatchObject({ status: 'approved', payload: expect.objectContaining({ target_id: AUTO_TARGET, from_kcal: 2300, to_kcal: 2050 }) });
  });
  it('expected refusals reach the coach as they are, never as 500: consent off 403, the calorie floor 400', async () => {
    await expect(approvals(CLIENT_PATH_CHANGE, { granted: false }).decide()).rejects.toMatchObject({ status: 403 });
    const floor = approvals(CLIENT_PATH_CHANGE, { payload: kcal });
    floor.macros.createForClient.mockRejectedValueOnce(new BadRequestException('floor'));
    await expect(floor.decide()).rejects.toMatchObject({ status: 400 });
    expect(floor.flips).toEqual([]);
  });
  it('another coach, or a client who moved, is 404 as for an unknown id', async () => {
    const other = approvals();
    await expect(other.decide({ decider: { id: 'coach-b', role: 'coach' } })).rejects.toMatchObject({ status: 404 });
    await expect(approvals(CLIENT_PATH_CHANGE, { coachOf: 'coach-b' }).decide()).rejects.toMatchObject({ status: 404 });
  });
  it('#CP-LAPSE: 7 days after Send it expires; approve and decline answer COPILOT_SUGGESTION_EXPIRED and nothing applies', async () => {
    for (const decision of ['approved', 'rejected']) {
      const { decide, flips, writes, prisma } = approvals(CLIENT_PATH_CHANGE, { sentAt: new Date(NOW - 7 * 86_400_000 - 1000) });
      await expect(decide({ decision })).rejects.toMatchObject({ status: 409, response: { code: 'COPILOT_SUGGESTION_EXPIRED' } });
      expect(prisma.aiActionDraft.updateMany).toHaveBeenCalledWith({ where: { id: 'd1', status: 'pending', materialised_at: null }, data: { status: 'expired' } });
      expect(flips).toEqual([]);
      expect(writes.filter(([k]) => k === 'move')).toEqual([]);
    }
  });
  it('Decline takes the optional note and applies nothing', async () => {
    const { decide, flips, writes } = approvals();
    await decide({ decision: 'rejected', note: 'Keep Thursday this week.' });
    expect(writes).toEqual([]);
    expect(flips[0]).toMatchObject({ status: 'rejected', decision_note: 'Keep Thursday this week.' });
  });
  it('a payload edit on Decline or on another kind is refused; a long note is refused', async () => {
    await expect(approvals().decide({ decision: 'rejected', editedPayload: { to_at: day(5) } })).rejects.toMatchObject({ status: 400 });
    await expect(approvals('draft.coach_message').decide({ editedPayload: { body: 'x' } })).rejects.toMatchObject({ status: 400 });
    await expect(approvals().decide({ note: 'x'.repeat(201) })).rejects.toMatchObject({ status: 400 });
  });
});

describe('GET /ai/gateway/drafts?order=oldest (the paged queue)', () => {
  function queue(rows: Array<{ id: string; subject_user_id: string | null }>, total: number) {
    const prisma = {
      user: { findMany: jest.fn(async (a: { where: { coach_id?: string } }) => (a.where.coach_id ? [{ id: CLIENT }] : [{ id: CLIENT }])) },
      aiActionDraft: {
        count: jest.fn(async () => total),
        findMany: jest.fn(async (_a: { where: { AND?: Array<{ OR?: Array<{ created_at?: { gt: Date } }> }> }; orderBy: object; take: number }) => rows.map((r) => ({ ...r, payload: {}, created_at: new Date(0) }))),
        findFirst: jest.fn(async (a: { where: { id: string } }) => (a.where.id === 'p2' ? { id: 'p2', created_at: new Date(0) } : null)),
      },
    };
    return { svc: new AiApprovalService(fakeOf<PrismaService>(prisma), fakeOf<AuditService>({})), prisma };
  }
  it('lists his current clients\' pending drafts oldest first, with the total and the next cursor', async () => {
    const { svc, prisma } = queue([{ id: 'p1', subject_user_id: CLIENT }, { id: 'p2', subject_user_id: CLIENT }, { id: 'p3', subject_user_id: CLIENT }], 12);
    const page = await svc.pageQueue({ tenantCoachId: COACH, limit: 2 });
    expect(page).toMatchObject({ total: 12, next_cursor: 'p2', items: [{ id: 'p1' }, { id: 'p2' }] });
    const args = prisma.aiActionDraft.findMany.mock.calls[0][0];
    expect(args).toMatchObject({ orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: 3 });
    expect(args.where).toMatchObject({ status: 'pending', tenant_coach_id: COACH, OR: [{ subject_user_id: null }, { subject_user_id: { in: [COACH, CLIENT] } }] });
    // #CP-LAPSE: a Copilot change older than 7 days leaves the queue and the total; other kinds are untouched.
    const lapse = args.where.AND?.[0]?.OR ?? [];
    expect(lapse[0]).toEqual({ capability: { not: CLIENT_PATH_CHANGE } });
    expect(Date.now() - (lapse[1]?.created_at?.gt.getTime() ?? 0)).toBeGreaterThanOrEqual(7 * 86_400_000);
    expect(prisma.aiActionDraft.count).toHaveBeenCalledWith({ where: args.where });
  });
  it('the next page starts after the cursor; an unknown cursor is refused', async () => {
    const { svc, prisma } = queue([{ id: 'p3', subject_user_id: CLIENT }], 3);
    await expect(svc.pageQueue({ tenantCoachId: COACH, limit: 2, after: 'p2' })).resolves.toMatchObject({ next_cursor: null, items: [{ id: 'p3' }] });
    expect(prisma.aiActionDraft.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p2', tenant_coach_id: COACH } }));
    await expect(svc.pageQueue({ tenantCoachId: COACH, limit: 2, after: 'nope' })).rejects.toMatchObject({ status: 400 });
  });
});
