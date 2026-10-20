// COPILOT-BE — the client_path_change kind: payload rules, the coach's Edit and note, the apply handlers (consent and
// roster re-checked; Roman never applies), and the paged queue (oldest first, with the total).
import { BadRequestException } from '@nestjs/common';
import type { AiActionDraft } from '@prisma/client';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import {
  ClientPathChangeMaterializer, CLIENT_PATH_CHANGE, editPathChange, parsePathChange, pathChangeNote,
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

describe('client_path_change payload, Edit and note', () => {
  it('accepts the two kinds and refuses anything else', () => {
    expect(parsePathChange(move)).toMatchObject({ kind: 'move_session', workout: 'Lower body B' });
    expect(parsePathChange({ ...kcal, sources: undefined })).toMatchObject({ to_kcal: 2000, sources: [] });
    for (const bad of [{ ...move, kind: 'delete_plan' }, { ...move, extra: 1 }, { ...move, to_at: day(90) }, { ...kcal, to_kcal: 500 },
      { ...move, sources: [{ ...src[0], kind: 'chat' }] }, null]) {
      expect(() => parsePathChange(bad)).toThrow(BadRequestException);
    }
  });
  it('Edit changes only the one field the kind allows', () => {
    expect(editPathChange(move, { to_at: day(4) })).toMatchObject({ assignment_id: SESSION, to_at: day(4) });
    expect(editPathChange(kcal, { to_kcal: 2050 })).toMatchObject({ target_id: TARGET, to_kcal: 2050 });
    expect(() => editPathChange(move, { assignment_id: TARGET })).toThrow(BadRequestException);
    expect(() => editPathChange(kcal, { to_at: day(4) })).toThrow(BadRequestException);
  });
  it('the note is one trimmed line of at most 200 characters, or nothing', () => {
    expect(pathChangeNote('  Keep Thursday\n this week ')).toBe('Keep Thursday this week');
    expect(pathChangeNote('   ')).toBeNull();
    expect(pathChangeNote(undefined)).toBeNull();
    expect(() => pathChangeNote('x'.repeat(201))).toThrow(BadRequestException);
  });
});

function materialiser(over: { coachOf?: string; requester?: string; granted?: boolean; moved?: number; current?: object | null; claim?: number } = {}) {
  const writes: Array<[string, unknown]> = [];
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ role: 'student', coach_id: over.coachOf ?? COACH })) },
    aiActionDraft: {
      updateMany: jest.fn(async (a: { data: unknown }) => { writes.push(['draft', a.data]); return { count: over.claim ?? 1 }; }),
      update: jest.fn(async (a: { data: unknown }) => { writes.push(['ref', a.data]); return {}; }),
      findUnique: jest.fn(async () => ({ materialised_ref: SESSION })),
    },
    clientWorkoutAssignment: { updateMany: jest.fn(async (a: unknown) => { writes.push(['move', a]); return { count: over.moved ?? 1 }; }) },
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
    const { m, draft, writes } = materialiser({ moved: 0 });
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
  it('nothing applies without the client\'s live AI consent, after a move, or for a draft the client did not send', async () => {
    for (const over of [{ granted: false }, { coachOf: 'coach-b' }, { requester: COACH }]) {
      const { m, draft, writes } = materialiser(over);
      await expect(m.materialize(draft(move))).rejects.toMatchObject({ status: 403 });
      expect(writes).toEqual([]);
    }
  });
  it('a second approval finds the claim and answers the first result', async () => {
    const { m, draft, prisma } = materialiser({ claim: 0 });
    await expect(m.materialize(draft(move))).resolves.toEqual({ status: 'already_materialised', ref: SESSION });
    expect(prisma.clientWorkoutAssignment.updateMany).not.toHaveBeenCalled();
  });
});

function approvals(capability = CLIENT_PATH_CHANGE) {
  const draft = { id: 'd1', capability, status: 'pending', requester_id: CLIENT, subject_user_id: CLIENT, tenant_coach_id: COACH, payload: move, rationale: 'r' };
  const flips: Array<Record<string, unknown>> = [];
  const tx = {
    aiActionDraft: { updateMany: jest.fn(async (a: { data: Record<string, unknown> }) => { flips.push(a.data); return { count: 1 }; }) },
    aiRequestAudit: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    aiActionDraft: { findUnique: jest.fn(async () => draft) },
    user: { findUnique: jest.fn(async () => ({ coach_id: COACH })) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const materialize = jest.fn(async () => ({ status: 'sent', ref: SESSION }));
  const registry = fakeOf<CapabilityMaterializerRegistry>({ resolve: () => ({ materialize }) });
  const svc = new AiApprovalService(fakeOf<PrismaService>(prisma), fakeOf<AuditService>({ write: jest.fn(async () => undefined) }), registry);
  const decide = (over: object) => svc.decide({ draftId: 'd1', decider: { id: COACH, role: 'coach' }, decision: 'approved', ...over });
  return { decide, materialize, flips };
}

describe('PATCH /ai/gateway/drafts/:id on a client_path_change draft', () => {
  it('Edit applies and stores the coach\'s day; the note is stored as one line', async () => {
    const { decide, materialize, flips } = approvals();
    await decide({ editedPayload: { to_at: day(5) }, note: ' Friday\nworks better ' });
    expect(materialize.mock.calls[0]).toEqual([expect.objectContaining({ payload: expect.objectContaining({ to_at: day(5), from_at: move.from_at }) })]);
    expect(flips[0]).toMatchObject({ status: 'approved', decision_note: 'Friday works better', payload: expect.objectContaining({ to_at: day(5) }) });
  });
  it('Decline takes the optional note and applies nothing', async () => {
    const { decide, materialize, flips } = approvals();
    await decide({ decision: 'rejected', note: 'Keep Thursday this week.' });
    expect(materialize).not.toHaveBeenCalled();
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
        findMany: jest.fn(async (_a: { where: object; orderBy: object; take: number }) => rows.map((r) => ({ ...r, payload: {}, created_at: new Date(0) }))),
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
    expect(args.where).toEqual({ status: 'pending', tenant_coach_id: COACH, OR: [{ subject_user_id: null }, { subject_user_id: { in: [COACH, CLIENT] } }] });
    expect(prisma.aiActionDraft.count).toHaveBeenCalledWith({ where: args.where });
  });
  it('the next page starts after the cursor; an unknown cursor is refused', async () => {
    const { svc, prisma } = queue([{ id: 'p3', subject_user_id: CLIENT }], 3);
    await expect(svc.pageQueue({ tenantCoachId: COACH, limit: 2, after: 'p2' })).resolves.toMatchObject({ next_cursor: null, items: [{ id: 'p3' }] });
    expect(prisma.aiActionDraft.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p2', tenant_coach_id: COACH } }));
    await expect(svc.pageQueue({ tenantCoachId: COACH, limit: 2, after: 'nope' })).rejects.toMatchObject({ status: 400 });
  });
});
