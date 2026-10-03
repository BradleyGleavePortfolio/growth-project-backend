// A5-COACH-BRIEF — Roman reply drafts: box-2 consent gate, idempotency,
// coach-only send, edit + audit, tenancy, stale-draft retirement.
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AnthropicHandle } from '../../src/ai-egress/ai-egress.service';
import type { AnthropicMessagesClient } from '../../src/ai-egress/ai-egress.service';
import type { AiApprovalService, DecideInput } from '../../src/ai/gateway/ai-approval.service';
import type { AuditService, AuditWriteInput } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/prisma.service';
import { COACH_MESSAGE_CAPABILITY } from '../../src/ai/gateway/materialisers/coach-message.materialiser';
import { RomanReplyDraftsService } from '../../src/coach/brief/roman/roman-reply-drafts.service';
import { RomanDraftError } from '../../src/coach/brief/roman/roman-errors';
import { FakeConsentReader, egressWithGrants, fakeOf } from '../ai-egress/ai-egress.fakes';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { RomanFakeStore } from './roman-fake-store';
import { COACH_AI_MODEL } from '../../src/ai/coach/coach-ai.constants';

const COACH = '11111111-1111-4111-8111-111111111111';
const OTHER_COACH = '22222222-2222-4222-8222-222222222222';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // box 2 granted
const BEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // no box 2
const T0 = new Date('2026-10-03T06:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function modelReply(reply: string, category = 'question', urgency = 'today'): string {
  return JSON.stringify({ category, urgency, reply });
}

function setup(opts: { grants?: string[]; replies?: string[]; egress?: AiEgressService } = {}) {
  const store = new RomanFakeStore();
  store.addUser(COACH, 'Bradley Gleave');
  store.addUser(OTHER_COACH, 'Other Coach');
  store.addUser(ANA, 'Ana Lopez');
  store.addUser(BEN, 'Ben Ito');
  const replies = [
    ...(opts.replies ?? [
      modelReply(
        'Good question, Ana. Keep the tempo slow on the first set and tell me how it feels.',
      ),
    ]),
  ];
  const create = jest.fn(async () => ({
    content: [
      { type: 'text', text: replies.length > 1 ? (replies.shift() ?? '') : (replies[0] ?? '') },
    ],
  }));
  const handle = AnthropicHandle.bind(
    fakeOf<AnthropicMessagesClient>({ messages: { create, stream: jest.fn() } }),
  );
  const egress = opts.egress ?? egressWithGrants(opts.grants ?? [ANA]).egress;
  const audit: AuditWriteInput[] = [];
  const decided: DecideInput[] = [];
  const approvals = {
    decide: jest.fn(async (input: DecideInput) => {
      decided.push(input);
      const d = store.aiDrafts.find((x) => x.id === input.draftId);
      if (!d) throw new ForbiddenException('AI draft not found');
      if (d.status !== 'pending') throw new ForbiddenException(`Draft already ${String(d.status)}`);
      if (d.tenant_coach_id !== input.decider.id)
        throw new ForbiddenException('Draft is outside your tenant');
      if (input.decision === 'approved') {
        const payload = d.payload as { clientId: string; body: string };
        const id = store.addMessage({
          client_id: payload.clientId,
          coach_id: String(d.tenant_coach_id),
          sender_id: String(d.tenant_coach_id),
          body: payload.body,
          at: new Date(),
        });
        Object.assign(d, { status: 'approved', materialised_at: new Date(), materialised_ref: id });
      } else {
        Object.assign(d, { status: 'rejected' });
      }
      return d;
    }),
  };
  const svc = new RomanReplyDraftsService(
    fakeOf<PrismaService>(store.prisma),
    fakeOf<ConfigService>({ get: () => undefined }),
    egress,
    fakeOf<AiApprovalService>(approvals),
    fakeOf<AuditService>({ write: async (i: AuditWriteInput) => void audit.push(i) }),
    handle,
  );
  return { store, svc, create, audit, approvals, decided };
}

function seedUnread(store: RomanFakeStore) {
  store.addMessage({
    client_id: ANA,
    coach_id: COACH,
    sender_id: COACH,
    body: 'How did legs feel?',
    at: at(0),
    read_at: at(1),
  });
  const ana = store.addMessage({
    client_id: ANA,
    coach_id: COACH,
    sender_id: ANA,
    body: 'ANA-SECRET: knees a bit sore after squats',
    at: at(5),
  });
  store.addMessage({
    client_id: BEN,
    coach_id: COACH,
    sender_id: BEN,
    body: 'BEN-SECRET-1 can we move Friday',
    at: at(6),
  });
  const ben = store.addMessage({
    client_id: BEN,
    coach_id: COACH,
    sender_id: BEN,
    body: 'BEN-SECRET-2 or Saturday',
    at: at(7),
  });
  return { ana, ben };
}

function promptsSent(create: jest.Mock): string {
  return JSON.stringify(create.mock.calls);
}

describe('RomanReplyDraftsService — box-2 consent gate (R2b / D2)', () => {
  it('drafts only for a client with box 2; the other client never reaches the model', async () => {
    const { store, svc, create } = setup({ grants: [ANA] });
    seedUnread(store);
    const r = await svc.prepareDrafts(COACH, 'Bradley Gleave', [ANA, BEN]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0])).toContain(`"model":"${COACH_AI_MODEL}"`);
    const sent = promptsSent(create);
    expect(sent).toContain('ANA-SECRET');
    expect(sent).not.toContain('BEN-SECRET');
    expect(sent).not.toContain('Ben');
    expect(r).toMatchObject({
      clients: 2,
      drafted: 1,
      drafts_failed: 0,
      without_ai_consent_clients: 1,
      without_ai_consent_messages: 2,
    });
    expect(store.aiDrafts).toHaveLength(1);
    expect(store.aiDrafts[0]).toMatchObject({
      capability: COACH_MESSAGE_CAPABILITY,
      status: 'pending',
      requester_id: null,
      tenant_coach_id: COACH,
      subject_user_id: ANA,
    });
  });

  it('no client with box 2 -> no model call at all and no draft rows', async () => {
    const { store, svc, create } = setup({ grants: [] });
    seedUnread(store);
    const r = await svc.prepareDrafts(COACH, 'Bradley', [ANA, BEN]);
    expect(create).not.toHaveBeenCalled();
    expect(store.claims).toHaveLength(0);
    expect(store.aiDrafts).toHaveLength(0);
    expect(r.without_ai_consent_clients).toBe(2);
  });

  it('a grant withdrawn between the filter and the send: nothing is sent, nothing drafted', async () => {
    class FlipReader extends FakeConsentReader {
      reads = 0;
      async hasClientAiConsent(id: string): Promise<boolean> {
        this.reads += 1;
        return this.reads === 1 && id === ANA; // first read grants, the gate's re-read refuses
      }
    }
    const reader = new FlipReader();
    const { store, svc, create } = setup({ egress: new AiEgressService(reader) });
    seedUnread(store);
    const r = await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    expect(create).not.toHaveBeenCalled();
    expect(store.aiDrafts).toHaveLength(0);
    expect(store.claims[0]).toMatchObject({ status: 'failed', failure_code: 'consent_withdrawn' });
    expect(r.without_ai_consent_clients).toBe(1);
  });
});

describe('RomanReplyDraftsService — idempotent generation (once per source message)', () => {
  it('a second prepare (restart, second device, brief + screen) makes no second draft', async () => {
    const { store, svc, create } = setup();
    seedUnread(store);
    await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    const again = await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.aiDrafts).toHaveLength(1);
    expect(store.claims).toHaveLength(1);
    expect(again.drafted).toBe(1);
  });

  it('two concurrent prepares collapse to one model call (unique claim, P2002 loser)', async () => {
    const { store, svc, create } = setup();
    seedUnread(store);
    await Promise.all([
      svc.prepareDrafts(COACH, 'Bradley', [ANA]),
      svc.prepareDrafts(COACH, 'Bradley', [ANA]),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.aiDrafts).toHaveLength(1);
  });

  it('a newer client message supersedes the older pending draft', async () => {
    const { store, svc } = setup();
    seedUnread(store);
    await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    const first = store.aiDrafts[0];
    store.addMessage({
      client_id: ANA,
      coach_id: COACH,
      sender_id: ANA,
      body: 'Also, can I swap Tuesday',
      at: at(20),
    });
    await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    expect(store.aiDrafts).toHaveLength(2);
    expect(first).toMatchObject({
      status: 'expired',
      decision_note: 'superseded_by_newer_message',
    });
    expect(store.claims.filter((c) => c.status === 'ready')).toHaveLength(1);
  });

  it('skips generation when the coach already answered after the message', async () => {
    const { store, svc, create } = setup();
    seedUnread(store);
    store.addMessage({
      client_id: ANA,
      coach_id: COACH,
      sender_id: COACH,
      body: 'On it',
      at: at(9),
    });
    await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('RomanReplyDraftsService — output rules', () => {
  it('strips emojis and exclamation marks from the draft', async () => {
    const { store, svc } = setup({ replies: [modelReply('Great work Ana!! 💪 Rest tomorrow!')] });
    seedUnread(store);
    await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    const body = (store.aiDrafts[0].payload as { body: string }).body;
    expect(body).toBe('Great work Ana. Rest tomorrow.');
  });

  it('refuses clinical wording: no draft is offered, the thread goes to manual reply', async () => {
    const { store, svc } = setup({
      replies: [modelReply('Sounds like I would diagnose tendinitis.')],
    });
    seedUnread(store);
    const r = await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    expect(store.aiDrafts).toHaveLength(0);
    expect(r.drafts_failed).toBe(1);
  });

  it('repairs once on unparseable output', async () => {
    const { store, svc, create } = setup({
      replies: ['not json', modelReply('Thanks Ana, I will adjust the plan.')],
    });
    seedUnread(store);
    const r = await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(r.drafted).toBe(1);
  });

  it('writes a generation audit row with ids only (no message content)', async () => {
    const { store, svc, audit } = setup();
    seedUnread(store);
    await svc.prepareDrafts(COACH, 'Bradley', [ANA]);
    const row = audit.find((a) => a.action === 'roman.reply_draft_generated');
    expect(row).toMatchObject({
      targetType: 'ai_action_draft',
      targetUserId: ANA,
      tenantCoachId: COACH,
    });
    expect(JSON.stringify(row)).not.toContain('ANA-SECRET');
  });
});

describe('RomanReplyDraftsService — the coach sends, nothing else does', () => {
  async function prepared() {
    const ctx = setup();
    seedUnread(ctx.store);
    await ctx.svc.prepareDrafts(COACH, 'Bradley', [ANA, BEN]);
    return ctx;
  }

  it('preparing never sends: no decide() call and no coach message is created', async () => {
    const { store, approvals } = await prepared();
    expect(approvals.decide).not.toHaveBeenCalled();
    expect(
      store.messages.filter(
        (m) => m.sender_id === COACH && m.created_at instanceof Date && m.created_at > at(1),
      ),
    ).toHaveLength(0);
  });

  it('queue lists the ready draft and the thread without consent for a personal reply', async () => {
    const { svc } = await prepared();
    const q = await svc.listQueue(COACH, 'Bradley', [ANA, BEN], { prepare: false });
    expect(q.drafts).toHaveLength(1);
    expect(q.drafts[0]).toMatchObject({
      client: { id: ANA, first_name: 'Ana' },
      urgency: 'today',
      category: 'question',
    });
    expect(q.manual).toEqual([
      expect.objectContaining({
        client: expect.objectContaining({ id: BEN }),
        reason: 'no_ai_consent',
        unread_count: 2,
      }),
    ]);
  });

  it('send with an edit: payload updated, edit audited, decide(approved) by the coach, idempotent replay', async () => {
    const { store, svc, approvals, audit } = await prepared();
    const claimId = String(store.claims[0].id);
    const r = await svc.send(COACH, claimId, { body: 'Thanks Ana. Ease off squats for two days.' });
    expect(r).toMatchObject({ status: 'sent', edited: true });
    expect(approvals.decide).toHaveBeenCalledTimes(1);
    expect(approvals.decide.mock.calls[0][0]).toMatchObject({
      decider: { id: COACH, role: 'coach' },
      decision: 'approved',
    });
    const sent = store.messages.find((m) => m.id === r.message_id);
    expect(sent).toMatchObject({
      body: 'Thanks Ana. Ease off squats for two days.',
      sender_id: COACH,
      client_id: ANA,
    });
    expect(audit.find((a) => a.action === 'roman.reply_draft_edited')?.metadata).toMatchObject({
      edited_length: 'Thanks Ana. Ease off squats for two days.'.length,
    });
    const replay = await svc.send(COACH, claimId, {});
    expect(replay.message_id).toBe(r.message_id);
    expect(approvals.decide).toHaveBeenCalledTimes(1);
    await expect(svc.dismiss(COACH, claimId)).rejects.toMatchObject({
      code: 'reply_draft_already_sent',
    });
  });

  it('another coach cannot see, send or dismiss the draft (tenancy)', async () => {
    const { store, svc, approvals } = await prepared();
    const claimId = String(store.claims[0].id);
    await expect(svc.send(OTHER_COACH, claimId, {})).rejects.toMatchObject({
      code: 'reply_draft_not_found',
    });
    await expect(svc.dismiss(OTHER_COACH, claimId)).rejects.toMatchObject({
      code: 'reply_draft_not_found',
    });
    const q = await svc.listQueue(OTHER_COACH, 'Other', [ANA], { prepare: false });
    expect(q.drafts).toHaveLength(0);
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it('blocked either way -> reply_draft_recipient_blocked, nothing sent', async () => {
    const { store, svc, approvals } = await prepared();
    store.blocks.push({ id: 'b1', blocker_id: ANA, blocked_id: COACH });
    await expect(svc.send(COACH, String(store.claims[0].id), {})).rejects.toMatchObject({
      code: 'reply_draft_recipient_blocked',
    });
    expect(approvals.decide).not.toHaveBeenCalled();
  });

  it('rejects an empty edit with a specific code', async () => {
    const { store, svc } = await prepared();
    const err = await svc
      .send(COACH, String(store.claims[0].id), { body: '   ' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RomanDraftError);
    expect(err).toMatchObject({ code: 'reply_draft_body_invalid' });
  });

  it('dismiss is idempotent and keeps the thread for a personal reply', async () => {
    const { store, svc } = await prepared();
    const claimId = String(store.claims[0].id);
    await expect(svc.dismiss(COACH, claimId)).resolves.toEqual({
      status: 'dismissed',
      id: claimId,
    });
    await expect(svc.dismiss(COACH, claimId)).resolves.toEqual({
      status: 'dismissed',
      id: claimId,
    });
    await expect(svc.send(COACH, claimId, {})).rejects.toMatchObject({
      code: 'reply_draft_dismissed',
    });
    const q = await svc.listQueue(COACH, 'Bradley', [ANA, BEN], { prepare: false });
    expect(q.manual.find((m) => m.client.id === ANA)?.reason).toBe('draft_dismissed');
  });

  it('a draft whose thread the coach already answered is retired, not shown', async () => {
    const { store, svc } = await prepared();
    store.addMessage({
      client_id: ANA,
      coach_id: COACH,
      sender_id: COACH,
      body: 'Replied by hand',
      at: at(30),
    });
    const q = await svc.listQueue(COACH, 'Bradley', [ANA], { prepare: false });
    expect(q.drafts).toHaveLength(0);
    expect(store.aiDrafts[0]).toMatchObject({
      status: 'expired',
      decision_note: 'thread_answered_by_coach',
    });
  });
});
