// A5-COACH-BRIEF — the Roman layer inside CoachBriefService.generateBrief:
// flag-off parity, once per coach per day, settlement-exact money, kill switch.
import { CoachBriefService } from '../../src/coach/brief/coach-brief.service';
import type { RomanReplyDraftsService } from '../../src/coach/brief/roman/roman-reply-drafts.service';
import { FEATURE_COACH_BRIEF_ROMAN_ENV } from '../../src/coach/brief/roman/roman-brief.feature';
import { isRomanBriefPayload } from '../../src/coach/brief/roman/roman-highlights';
import {
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeMockConfig,
  makeMockPrisma,
  MockPrisma,
  wireSoloDefaults,
} from '../_fixtures/coach-brief-mocks';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';

const COACH = 'coach1';

type RomanPrisma = MockPrisma & {
  splitLedgerEntry: { findMany: jest.Mock };
  checkIn: MockPrisma['checkIn'] & { count: jest.Mock };
};

function prismaFor(): RomanPrisma {
  const base = makeMockPrisma();
  const p: RomanPrisma = {
    ...base,
    splitLedgerEntry: { findMany: jest.fn() },
    checkIn: { ...base.checkIn, count: jest.fn().mockResolvedValue(2) },
  };
  p.coachBrief.updateMany.mockResolvedValue({ count: 1 });
  wireSoloDefaults(p, { coachId: COACH, clientIds: ['c1', 'c2'] });
  p.coachBriefPreferences.findUnique.mockResolvedValue({ honorific: 'sir' });
  // The ledger double applies the same filter the query sends, so a wrong
  // where clause in the service changes the total.
  const now = Date.now();
  const rows = [
    {
      purchase_id: 'p1',
      kind: 'destination',
      status: 'posted',
      payee_user_id: COACH,
      amount_cents: 600_00,
      reversed_cents: 0,
      currency: 'usd',
      posted_at: new Date(now - 3_600_000),
    },
    {
      purchase_id: 'p2',
      kind: 'destination',
      status: 'posted',
      payee_user_id: COACH,
      amount_cents: 400_00,
      reversed_cents: 0,
      currency: 'usd',
      posted_at: new Date(now - 7_200_000),
    },
    {
      purchase_id: 'p3',
      kind: 'head_coach_split',
      status: 'reversed',
      payee_user_id: COACH,
      amount_cents: 300_00,
      reversed_cents: 60_00,
      currency: 'usd',
      posted_at: new Date(now - 7_200_000),
    },
    {
      purchase_id: 'p4',
      kind: 'destination',
      status: 'pending',
      payee_user_id: COACH,
      amount_cents: 999_00,
      reversed_cents: 0,
      currency: 'usd',
      posted_at: new Date(now - 7_200_000),
    },
    {
      purchase_id: 'p5',
      kind: 'destination',
      status: 'posted',
      payee_user_id: COACH,
      amount_cents: 999_00,
      reversed_cents: 0,
      currency: 'usd',
      posted_at: new Date(now - 30 * 3_600_000),
    },
  ];
  p.splitLedgerEntry.findMany.mockImplementation(
    async (args: {
      where: {
        payee_user_id: string;
        kind: { in: string[] };
        status: { in: string[] };
        posted_at: { gte: Date; lt: Date };
      };
    }) =>
      rows.filter(
        (r) =>
          r.payee_user_id === args.where.payee_user_id &&
          args.where.kind.in.includes(r.kind) &&
          args.where.status.in.includes(r.status) &&
          r.posted_at >= args.where.posted_at.gte &&
          r.posted_at < args.where.posted_at.lt,
      ),
  );
  p.coachBrief.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'b1',
    coach_id: COACH,
    brief_date: '2026-10-03',
    status: 'generated',
    generated_at: new Date(),
    generation_started_at: null,
    narrative: String(args.data.narrative ?? ''),
    brief_context: makeBriefContext({ roster_size: 2 }),
    action_items: [],
    generated_by: 'fallback',
    brief_mode: 'solo_coach',
    roman: args.data.roman ?? null,
    created_at: new Date(),
  }));
  return p;
}

function romanDraftsFake() {
  const prepareDrafts = jest.fn().mockResolvedValue({
    clients: 3,
    drafted: 3,
    drafts_failed: 0,
    drafts_pending: 0,
    without_ai_consent_clients: 0,
    without_ai_consent_messages: 0,
    client_names: ['Sarah Jones', 'Ana', 'Lee'],
  });
  return { prepareDrafts, svc: fakeOf<RomanReplyDraftsService>({ prepareDrafts }) };
}

function service(p: RomanPrisma, drafts: RomanReplyDraftsService) {
  return new CoachBriefService(
    asPrismaService(p),
    asConfig(makeMockConfig()),
    grantAllEgress(),
    undefined,
    drafts,
  );
}

describe('CoachBriefService — Roman layer', () => {
  const prev = process.env[FEATURE_COACH_BRIEF_ROMAN_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[FEATURE_COACH_BRIEF_ROMAN_ENV];
    else process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = prev;
  });

  it('flag unset: no Roman work at all, nothing new written, summary.roman is null', async () => {
    delete process.env[FEATURE_COACH_BRIEF_ROMAN_ENV];
    const p = prismaFor();
    const d = romanDraftsFake();
    const r = await service(p, d.svc).generateBrief(COACH, 'America/Los_Angeles', '2026-10-03', {
      force: true,
    });
    expect(d.prepareDrafts).not.toHaveBeenCalled();
    expect(p.splitLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(p.coachBrief.update.mock.calls[0][0].data).not.toHaveProperty('roman');
    expect(r.summary?.roman).toBeNull();
  });

  it('flag on: money reconciles exactly with the settlement rows; drafts prepared for the scope', async () => {
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'true';
    const p = prismaFor();
    const d = romanDraftsFake();
    const r = await service(p, d.svc).generateBrief(COACH, 'America/Los_Angeles', '2026-10-03', {
      force: true,
    });
    expect(d.prepareDrafts).toHaveBeenCalledTimes(1);
    expect(d.prepareDrafts.mock.calls[0][2]).toEqual(['c1', 'c2']);
    const roman = r.summary?.roman;
    expect(isRomanBriefPayload(roman)).toBe(true);
    // 600 + 400 + (300 - 60) = 1,240.00; pending and out-of-window rows excluded.
    expect(roman?.money.by_currency).toEqual([
      { currency: 'usd', collected_cents: 1_240_00, payments: 3 },
    ]);
    expect(
      roman?.text.startsWith(
        'Sir, we collected $1,240.00 in the last 24 hours, across 3 payments.',
      ),
    ).toBe(true);
    expect(roman?.text).toContain(
      'Sarah and 2 others messaged you. I have reply drafts ready for each of them.',
    );
    expect(roman?.text).toContain('2 check-ins are waiting for your review.');
    expect(roman?.text).not.toContain('!');
    expect(roman?.push_text).not.toContain('Sarah');
  });

  it('once per coach per day: a generated row (restart, second request) does not re-run Roman', async () => {
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'true';
    const p = prismaFor();
    p.coachBrief.findUnique.mockResolvedValue({
      id: 'b1',
      coach_id: COACH,
      brief_date: '2026-10-03',
      status: 'generated',
      generated_at: new Date(),
      generation_started_at: null,
      narrative: 'cached',
      brief_context: makeBriefContext({ roster_size: 2 }),
      action_items: [],
      generated_by: 'ai',
      brief_mode: 'solo_coach',
      roman: null,
      created_at: new Date(),
    });
    const d = romanDraftsFake();
    const svc = service(p, d.svc);
    await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-03');
    await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-03');
    expect(d.prepareDrafts).not.toHaveBeenCalled();
    expect(p.coachBrief.update).not.toHaveBeenCalled();
  });

  it('a fresh in-flight lease held by another instance: no Roman work here', async () => {
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'true';
    const p = prismaFor();
    const inflight = {
      id: 'b1',
      coach_id: COACH,
      brief_date: '2026-10-03',
      status: 'generating',
      generated_at: null,
      generation_started_at: new Date(),
      narrative: null,
      brief_context: null,
      action_items: null,
      generated_by: null,
      brief_mode: null,
      roman: null,
      created_at: new Date(),
    };
    p.coachBrief.findUnique.mockResolvedValue(inflight);
    const d = romanDraftsFake();
    await service(p, d.svc).generateBrief(COACH, 'America/Los_Angeles', '2026-10-03');
    expect(d.prepareDrafts).not.toHaveBeenCalled();
  });

  it('a Roman failure never fails the brief', async () => {
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'true';
    const p = prismaFor();
    p.splitLedgerEntry.findMany.mockRejectedValue(new Error('db down'));
    const d = romanDraftsFake();
    const r = await service(p, d.svc).generateBrief(COACH, 'America/Los_Angeles', '2026-10-03', {
      force: true,
    });
    expect(r.status).toBe('generated');
    expect(p.coachBrief.update.mock.calls[0][0].data).not.toHaveProperty('roman');
    expect(r.summary?.roman).toBeNull();
  });

  it('kill switch: turning the flag off hides an already stored Roman layer', async () => {
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'true';
    const p = prismaFor();
    const d = romanDraftsFake();
    const svc = service(p, d.svc);
    const on = await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-03', { force: true });
    expect(on.summary?.roman).not.toBeNull();
    const stored = await p.coachBrief.update.mock.results[0].value;
    process.env[FEATURE_COACH_BRIEF_ROMAN_ENV] = 'false';
    p.coachBrief.findUnique.mockResolvedValue(stored);
    const off = await svc.generateBrief(COACH, 'America/Los_Angeles', '2026-10-03');
    expect(off.summary?.roman).toBeNull();
  });
});
