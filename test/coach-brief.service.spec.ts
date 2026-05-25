// test/coach-brief.service.spec.ts
//
// R43 Coach Brief — unit tests. The Anthropic client is injected via
// BRIEF_ANTHROPIC_CLIENT_TOKEN so no network traffic occurs.
//
// P3-3: no untyped casts. Typed Prisma + Anthropic + Config mock
// factories live in test/_fixtures/coach-brief-mocks.ts; structural
// casts to the real Nest types are centralised there.

import { Prisma } from '@prisma/client';
import {
  CoachBriefService,
  buildActionItems,
  buildBriefPrompt,
  buildFallbackNarrative,
  buildHeadCoachSystemPrompt,
  buildSoloCoachSystemPrompt,
  buildHeadCoachActionItems,
  bucketDateLocal,
  validateClaudeNarrative,
  normalizeClaudeOutput,
  startOfDayInTz,
  endOfDayInTz,
  BRIEF_GENERATION_LEASE_MS,
} from '../src/coach/brief/coach-brief.service';
import type {
  BriefContextHeadCoach,
} from '../src/coach/brief/coach-brief.types';
import { CoachBriefScheduler } from '../src/coach/brief/coach-brief.scheduler';
import { CoachDailyLogService } from '../src/coach/brief/coach-daily-log.service';
import { CoachBriefPreferencesService } from '../src/coach/brief/coach-brief-preferences.service';
import {
  asAnthropic,
  asConfig,
  asPrismaService,
  makeBriefContext,
  makeHeadCoachContext,
  makeMockAnthropic,
  makeMockConfig,
  makeMockPrisma,
  MockPrisma,
  wireSoloDefaults,
} from './_fixtures/coach-brief-mocks';

// ─── Mode detection ────────────────────────────────────────────────────

describe('CoachBriefService.detectBriefMode', () => {
  it('returns sub_coach when an active TeamSubCoachAssignment exists as sub_coach_id', async () => {
    const prisma = makeMockPrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'a1' });

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    expect(await svc.detectBriefMode('coach1')).toBe('sub_coach');
    expect(prisma.teamSubCoachAssignment.count).not.toHaveBeenCalled();
  });

  it('returns head_coach when sub_coach assignments exist as head_coach_id', async () => {
    const prisma = makeMockPrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
    prisma.teamSubCoachAssignment.count.mockResolvedValue(2);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    expect(await svc.detectBriefMode('coach1')).toBe('head_coach');
  });

  it('returns solo_coach when no active TeamSubCoachAssignment exists in either direction', async () => {
    const prisma = makeMockPrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
    prisma.teamSubCoachAssignment.count.mockResolvedValue(0);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    expect(await svc.detectBriefMode('coach1')).toBe('solo_coach');
  });

  it('sub_coach takes precedence over head_coach when both directions exist', async () => {
    const prisma = makeMockPrisma();
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'a1' });
    prisma.teamSubCoachAssignment.count.mockResolvedValue(3);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    expect(await svc.detectBriefMode('coach1')).toBe('sub_coach');
  });
});

// ─── Sub-coach scoping ────────────────────────────────────────────────

describe('CoachBriefService.resolveClientScope', () => {
  it('returns full direct roster for solo_coach', async () => {
    const prisma = makeMockPrisma();
    prisma.user.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.resolveClientScope('coach1', 'solo_coach');
    expect(result).toEqual(['c1', 'c2']);
    expect(prisma.clientWorkoutAssignment.findMany).not.toHaveBeenCalled();
  });

  it('returns full direct roster for head_coach', async () => {
    const prisma = makeMockPrisma();
    prisma.user.findMany.mockResolvedValue([{ id: 'c1' }]);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.resolveClientScope('coach1', 'head_coach');
    expect(result).toEqual(['c1']);
  });

  it('returns only assigned clients for sub_coach (derived from open SubCoachAssignment rows)', async () => {
    const prisma = makeMockPrisma();
    prisma.subCoachAssignment.findMany.mockResolvedValue([
      { client_id: 'c1' },
      { client_id: 'c2' },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.resolveClientScope('subCoach1', 'sub_coach');
    expect(result).toEqual(['c1', 'c2']);
    expect(prisma.subCoachAssignment.findMany).toHaveBeenCalledWith({
      where: { sub_coach_id: 'subCoach1', unassigned_at: null },
      select: { client_id: true },
    });
  });

  it('returns empty array for sub_coach with no open SubCoachAssignment rows', async () => {
    const prisma = makeMockPrisma();
    prisma.subCoachAssignment.findMany.mockResolvedValue([]);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    expect(await svc.resolveClientScope('subCoach1', 'sub_coach')).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

// ─── P1-1: stale lease recovery ────────────────────────────────────────

describe('CoachBriefService.generateBrief — stale lease recovery (P1-1)', () => {
  it('returns the in-flight row when the lease is fresh (no Claude call)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.findUnique.mockResolvedValue({
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generating',
      generated_at: null,
      generation_started_at: new Date(), // fresh
      narrative: null,
      brief_context: null,
      action_items: null,
      generated_by: null,
      brief_mode: null,
      created_at: new Date(),
    });
    const anthropic = makeMockAnthropic('should not be called');

    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );
    const res = await svc.generateBrief('coach1', 'America/Los_Angeles', '2026-05-25');
    expect(res.status).toBe('pending');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(prisma.coachBrief.update).not.toHaveBeenCalled();
  });

  it('steals a stale lease (generation_started_at older than TTL) and regenerates', async () => {
    const prisma = makeMockPrisma();
    const staleStarted = new Date(Date.now() - BRIEF_GENERATION_LEASE_MS - 60_000);

    prisma.coachBrief.findUnique.mockResolvedValue({
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generating',
      generated_at: null,
      generation_started_at: staleStarted,
      narrative: null,
      brief_context: null,
      action_items: null,
      generated_by: null,
      brief_mode: null,
      created_at: staleStarted,
    });
    // Successful steal — exactly one row claimed.
    prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
    wireSoloDefaults(prisma, { coachId: 'coach1', clientIds: [] });
    prisma.coachBrief.update.mockResolvedValue({
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generated',
      generated_at: new Date(),
      generation_started_at: null,
      narrative: 'Sarah, we ran your roster this morning and pulled together what matters. No one has logged a check-in yet this morning across your 0 active clients. We haven\'t seen any payment activity yet this morning. Nothing needs your hands-on attention right now, so we\'ll keep watching.',
      brief_context: makeBriefContext({ roster_size: 0 }),
      action_items: [],
      generated_by: 'fallback',
      brief_mode: 'solo_coach',
      created_at: staleStarted,
    });

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const res = await svc.generateBrief('coach1', 'America/Los_Angeles', '2026-05-25');
    expect(res.status).toBe('generated');
    expect(prisma.coachBrief.updateMany).toHaveBeenCalled();
    expect(prisma.coachBrief.update).toHaveBeenCalled();
  });

  it('when steal loses the race, returns whatever row is fresh without calling Claude', async () => {
    const prisma = makeMockPrisma();
    const staleStarted = new Date(Date.now() - BRIEF_GENERATION_LEASE_MS - 60_000);

    prisma.coachBrief.findUnique
      .mockResolvedValueOnce({
        id: 'b1',
        coach_id: 'coach1',
        brief_date: '2026-05-25',
        status: 'generating',
        generated_at: null,
        generation_started_at: staleStarted,
        narrative: null,
        brief_context: null,
        action_items: null,
        generated_by: null,
        brief_mode: null,
        created_at: staleStarted,
      })
      .mockResolvedValueOnce({
        id: 'b1',
        coach_id: 'coach1',
        brief_date: '2026-05-25',
        status: 'generating',
        generated_at: null,
        generation_started_at: new Date(), // someone else just refreshed
        narrative: null,
        brief_context: null,
        action_items: null,
        generated_by: null,
        brief_mode: null,
        created_at: staleStarted,
      });
    prisma.coachBrief.updateMany.mockResolvedValue({ count: 0 });
    const anthropic = makeMockAnthropic('should not be called');

    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );
    const res = await svc.generateBrief('coach1', 'America/Los_Angeles', '2026-05-25');
    expect(res.status).toBe('pending');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });
});

describe('CoachBriefService.generateBrief — idempotent generated path', () => {
  it('returns the cached row when status=generated exists', async () => {
    const prisma = makeMockPrisma();
    const existing = {
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generated',
      generated_at: new Date('2026-05-25T07:00:00Z'),
      generation_started_at: null,
      narrative: 'cached',
      brief_context: makeBriefContext({ roster_size: 1 }),
      action_items: [],
      generated_by: 'ai',
      brief_mode: 'solo_coach',
      created_at: new Date('2026-05-25T00:00:00Z'),
    };
    prisma.coachBrief.findUnique.mockResolvedValue(existing);

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.generateBrief('coach1', 'America/Los_Angeles', '2026-05-25');

    expect(result.summary?.narrative).toBe('cached');
    expect(prisma.coachBrief.update).not.toHaveBeenCalled();
  });

  it('forces regeneration when opts.force is true and no fresh lease exists', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBrief.updateMany.mockResolvedValue({ count: 1 });
    wireSoloDefaults(prisma, { coachId: 'coach1', clientIds: [] });
    prisma.coachBrief.update.mockResolvedValue({
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generated',
      generated_at: new Date(),
      generation_started_at: null,
      narrative: 'Sarah, we ran your roster this morning and pulled together what matters. No one has logged a check-in yet this morning across your 0 active clients. We haven\'t seen any payment activity yet this morning.',
      brief_context: makeBriefContext({ roster_size: 0 }),
      action_items: [],
      generated_by: 'fallback',
      brief_mode: 'solo_coach',
      created_at: new Date(),
    });

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.generateBrief(
      'coach1',
      'America/Los_Angeles',
      '2026-05-25',
      { force: true },
    );
    expect(result.status).toBe('generated');
    expect(prisma.coachBrief.update).toHaveBeenCalled();
    expect(prisma.coachBrief.updateMany).toHaveBeenCalled();
  });

  it('atomic claim — losing the create race returns the inflight row without calling Claude', async () => {
    const briefRow = {
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: 'generating',
      generated_at: null,
      generation_started_at: new Date(),
      narrative: null,
      brief_context: null,
      action_items: null,
      generated_by: null,
      brief_mode: null,
      created_at: new Date(),
    };

    const loserPrisma = makeMockPrisma();
    loserPrisma.coachBrief.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(briefRow);
    const P2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    loserPrisma.coachBrief.create.mockRejectedValue(P2002);

    const loserAnthropic = makeMockAnthropic('should not be called');
    const loserSvc = new CoachBriefService(
      asPrismaService(loserPrisma),
      asConfig(makeMockConfig()),
      asAnthropic(loserAnthropic),
    );
    const res = await loserSvc.generateBrief(
      'coach1',
      'America/Los_Angeles',
      '2026-05-25',
    );
    expect(res.status).toBe('pending');
    expect(loserAnthropic.messages.create).not.toHaveBeenCalled();
    expect(loserPrisma.coachBrief.update).not.toHaveBeenCalled();
  });
});

// ─── Claude validation / contract enforcement (P1-7) ───────────────────

describe('validateClaudeNarrative', () => {
  const fiveSentenceValid =
    "Sarah, we ran your roster and pulled the highlights together. Three of seven clients have already checked in today. We're chasing one failed payment in the background. Two workouts need your eyes before noon. Here's what to tackle: workouts and one message.";

  it('accepts a valid 3–5 sentence we-voice paragraph', () => {
    expect(validateClaudeNarrative(fiveSentenceValid, 'Sarah')).toBeNull();
  });

  it('rejects empty / whitespace narratives', () => {
    expect(validateClaudeNarrative('   ', 'Sarah')).toBe('empty');
  });

  it('rejects too few sentences', () => {
    expect(validateClaudeNarrative('Sarah, we got nothing.', 'Sarah')).toMatch(
      /^too_few_sentences:/,
    );
  });

  it('rejects too many sentences', () => {
    const six = Array.from({ length: 6 })
      .map((_, i) => (i === 0 ? 'Sarah, we have updates.' : `We have item ${i + 1}.`))
      .join(' ');
    expect(validateClaudeNarrative(six, 'Sarah')).toMatch(/^too_many_sentences:/);
  });

  it('rejects meta prefixes', () => {
    expect(
      validateClaudeNarrative(
        "Here is your brief: Sarah, we have you covered. We're working on the payments. We'll keep watching.",
        'Sarah',
      ),
    ).toBe('meta_prefix');
  });

  it('rejects markdown leftovers', () => {
    expect(
      validateClaudeNarrative(
        "Sarah, here is what we found. **Important:** three things need eyes. We're on it.",
        'Sarah',
      ),
    ).toBe('markdown');
  });

  it('rejects missing first-name opener', () => {
    expect(
      validateClaudeNarrative(
        "We ran the roster this morning. Three clients checked in. We're keeping watch on everything else for you.",
        'Sarah',
      ),
    ).toBe('missing_first_name');
  });

  it('rejects missing first-person plural voice', () => {
    expect(
      validateClaudeNarrative(
        "Sarah, the roster looks good today. Three clients checked in. Two more need attention.",
        'Sarah',
      ),
    ).toBe('missing_we_voice');
  });

  it('rejects narratives over 600 chars', () => {
    const long = 'Sarah, ' + 'we keep going. '.repeat(60);
    expect(validateClaudeNarrative(long, 'Sarah')).toMatch(/^too_long:/);
  });
});

describe('normalizeClaudeOutput', () => {
  it('strips leading code fences', () => {
    expect(normalizeClaudeOutput('```\nSarah, we got it.\n```')).toBe(
      'Sarah, we got it.',
    );
  });

  it('strips a leading "Here is your brief:" prefix', () => {
    expect(
      normalizeClaudeOutput("Here is your brief: Sarah, we got it."),
    ).toMatch(/^Sarah/);
  });
});

// ─── Claude call + fallback + repair (P1-7) ────────────────────────────

describe('CoachBriefService.callClaude', () => {
  it('returns ai narrative when Claude returns a valid contract response', async () => {
    const prisma = makeMockPrisma();
    const valid =
      "Sarah, we ran your roster and pulled the highlights together. Three of seven clients have already checked in today. We're chasing one failed payment in the background. Two workouts need your eyes before noon. Here's what to tackle: workouts and one message.";
    const anthropic = makeMockAnthropic(valid);
    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );

    const result = await svc.callClaude(
      makeBriefContext({ workouts_pending_approval: 1, missed_checkin: 0 }),
    );
    expect(result.generated_by).toBe('ai');
    expect(result.narrative).toBe(valid);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  it('attempts one repair then falls back when Claude keeps violating the contract', async () => {
    const prisma = makeMockPrisma();
    // Two-sentence response — fails too_few_sentences and is not
    // recoverable via normalizeClaudeOutput (no meta prefix or
    // markdown to strip), so the violation surfaces on both attempts.
    const tooFew =
      "Sarah, we have updates this morning. We will keep watching for you.";
    const anthropic = makeMockAnthropic([tooFew, tooFew]);
    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );

    const result = await svc.callClaude(
      makeBriefContext({ workouts_pending_approval: 1, missed_checkin: 0 }),
    );
    expect(result.generated_by).toBe('fallback');
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
  });

  it('falls back when Claude throws', async () => {
    const prisma = makeMockPrisma();
    const anthropic = makeMockAnthropic(new Error('boom'));
    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );

    const result = await svc.callClaude(
      makeBriefContext({ workouts_pending_approval: 1 }),
    );
    expect(result.generated_by).toBe('fallback');
    expect(result.narrative).toMatch(/Sarah/);
  });

  it('skips Claude entirely on the zero-action fast path (solo)', async () => {
    const prisma = makeMockPrisma();
    const anthropic = makeMockAnthropic('should not be called');
    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );

    const result = await svc.callClaude(
      makeBriefContext({
        checked_in_today: 5,
        missed_checkin: 0,
        workouts_pending_approval: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
      }),
    );
    expect(result.generated_by).toBe('fallback');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('falls back when ANTHROPIC_API_KEY is missing', async () => {
    const prisma = makeMockPrisma();
    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.callClaude(
      makeBriefContext({ workouts_pending_approval: 1 }),
    );
    expect(result.generated_by).toBe('fallback');
  });

  it('uses head-coach system prompt when brief_mode=head_coach', async () => {
    const prisma = makeMockPrisma();
    const valid =
      "Marcus, we ran the team report this morning. We collected $4,200 across 3 payments today. We're chasing one failed payment in the background. The team of two sub-coaches is supporting 50 clients with two new sign-ups in 24h.";
    const anthropic = makeMockAnthropic(valid);
    const svc = new CoachBriefService(
      asPrismaService(prisma),
      asConfig(makeMockConfig()),
      asAnthropic(anthropic),
    );

    const ctx = makeHeadCoachContext({
      coach_name: 'Marcus Reed',
      coach_first_name: 'Marcus',
      total_revenue_today_cents: 420000,
    });
    await svc.callClaude(ctx);

    expect(anthropic.messages.create).toHaveBeenCalled();
    const call = anthropic.messages.create.mock.calls[0][0] as {
      system: string;
      messages: Array<{ content: string }>;
    };
    expect(call.system).toContain('runs a team');
    expect(call.messages[0].content).toContain('TEAM BUSINESS METRICS');
  });
});

// ─── Head-coach attribution (P1-3, P1-4) ──────────────────────────────

describe('CoachBriefService head-coach mode — business-only response (P1-3) + assignment attribution (P1-4)', () => {
  it('emits HeadCoachActionItem[] with no client identifiers and attributes by SubCoachAssignment', async () => {
    const prisma = makeMockPrisma();
    const coachId = 'head1';
    const subCoachId = 'sub1';
    const delegatedClientId = 'cdelegated';
    const ownClientId = 'cown';

    // detectBriefMode → head_coach
    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue(null);
    prisma.teamSubCoachAssignment.count.mockResolvedValue(1);

    // coach metadata
    prisma.user.findUnique.mockResolvedValue({ name: 'Marcus Reed' });

    // TeamSubCoachAssignment for the head
    prisma.teamSubCoachAssignment.findMany.mockResolvedValue([
      {
        sub_coach_id: subCoachId,
        sub_coach: { id: subCoachId, name: 'Coach Priya' },
      },
    ]);

    // Open SubCoachAssignment for the head — delegatedClientId to sub1.
    prisma.subCoachAssignment.findMany.mockResolvedValue([
      { sub_coach_id: subCoachId, client_id: delegatedClientId },
    ]);

    // Head coach's own clients (User.coach_id = head). Both delegated +
    // non-delegated still appear under the head's coach_id.
    const now = new Date();
    prisma.user.findMany
      // headOwnedClients
      .mockResolvedValueOnce([
        { id: ownClientId, created_at: now },
        { id: delegatedClientId, created_at: now },
      ])
      // delegated client lookup for created_at
      .mockResolvedValueOnce([{ id: delegatedClientId, created_at: now }]);

    // Revenue + dunning + MRR aggregates.
    prisma.clientPurchase.aggregate
      .mockResolvedValueOnce({ _sum: { amount_cents: 420000 }, _count: { _all: 3 } }) // revenue today
      .mockResolvedValueOnce({ _sum: { amount_cents: 2840000 } }); // revenue 30d
    prisma.clientPurchase.findMany.mockResolvedValue([
      { amount_cents: 50000, package: { interval: 'month', interval_count: 1 } },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ count: 1n, total: 8900n }]);

    // Brief atomic claim path: no row exists yet, create returns a generating row.
    prisma.coachBrief.findUnique.mockResolvedValue(null);
    prisma.coachBrief.create.mockResolvedValue({
      id: 'b1',
      coach_id: coachId,
      brief_date: '2026-05-25',
      status: 'generating',
      generated_at: null,
      generation_started_at: now,
      narrative: null,
      brief_context: null,
      action_items: null,
      generated_by: null,
      brief_mode: null,
      created_at: now,
    });

    let capturedActionItems: unknown = null;
    let capturedContext: unknown = null;
    prisma.coachBrief.update.mockImplementation((args) => {
      const data = (args as { data: Prisma.CoachBriefUpdateInput }).data;
      capturedActionItems = data.action_items;
      capturedContext = data.brief_context;
      return Promise.resolve({
        id: 'b1',
        coach_id: coachId,
        brief_date: '2026-05-25',
        status: 'generated',
        generated_at: now,
        generation_started_at: null,
        narrative: 'Marcus, we have the team report. We collected $4,200 today. We are chasing one failed payment.',
        brief_context: data.brief_context,
        action_items: data.action_items,
        generated_by: 'fallback',
        brief_mode: 'head_coach',
        created_at: now,
      });
    });

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    const result = await svc.generateBrief(coachId, 'America/Los_Angeles', '2026-05-25');

    expect(result.summary?.brief_mode).toBe('head_coach');
    // Action items: no client_id, no client_name fields anywhere.
    const items = capturedActionItems as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.client_id).toBeUndefined();
      expect(item.client_name).toBeUndefined();
      expect(['team_revenue_review', 'dunning_queue', 'team_performance', 'sub_coach_operations']).toContain(
        item.type,
      );
    }

    // Context shape: no per-client counters in the head-coach payload.
    const ctx = capturedContext as Record<string, unknown>;
    expect(ctx.brief_mode).toBe('head_coach');
    expect(ctx.workouts_pending_approval).toBeUndefined();
    expect(ctx.unread_messages).toBeUndefined();
    expect(ctx.weight_logs_flagged).toBeUndefined();
    expect(ctx.missed_checkin).toBeUndefined();

    // P1-4: sub-coach highlights derived from SubCoachAssignment, not
    // User.coach_id. The single delegated client is attributed under sub1.
    const highlights = ctx.sub_coach_highlights as Array<{ active_clients: number }>;
    expect(highlights[0].active_clients).toBe(1);
    expect(ctx.team_clients_total).toBe(2);
  });
});

// ─── P1-5: sub-coach unread messages via client_id scope ───────────────

describe('CoachBriefService sub-coach unread messages — P1-5', () => {
  it('queries coachMessage by client_id IN clientIds, not coach_id = sub_coach_id', async () => {
    const prisma = makeMockPrisma();
    const subCoachId = 'sub1';
    const assignedClientIds = ['c1', 'c2'];

    prisma.teamSubCoachAssignment.findFirst.mockResolvedValue({ id: 'a1' });
    prisma.subCoachAssignment.findMany.mockResolvedValue(
      assignedClientIds.map((id) => ({ client_id: id })),
    );
    prisma.user.findMany
      .mockResolvedValueOnce(assignedClientIds.map((id) => ({ id }))) // resolveClientScope filter
      .mockResolvedValueOnce([]); // missingCheckinClients
    prisma.user.findUnique.mockResolvedValue({ name: 'Sub Coach' });

    prisma.checkIn.findMany.mockResolvedValue([]);
    prisma.clientWorkoutAssignment.findMany.mockResolvedValue([]);
    prisma.clientWorkoutAssignment.count.mockResolvedValue(0);
    prisma.clientPurchase.aggregate.mockResolvedValue({
      _sum: { amount_cents: null },
      _count: { _all: 0 },
    });
    prisma.clientPurchase.count.mockResolvedValue(0);
    prisma.coachMessage.findMany.mockResolvedValue([
      {
        client_id: 'c1',
        client: { name: 'Client One' },
        body: 'hi coach',
        created_at: new Date(),
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ count: 0n, total: 0n }]);
    prisma.coachBrief.findUnique.mockResolvedValue(null);
    prisma.coachBrief.create.mockResolvedValue({
      id: 'b1',
      coach_id: subCoachId,
      brief_date: '2026-05-25',
      status: 'generating',
      generated_at: null,
      generation_started_at: new Date(),
      narrative: null,
      brief_context: null,
      action_items: null,
      generated_by: null,
      brief_mode: null,
      created_at: new Date(),
    });
    prisma.coachBrief.update.mockImplementation((args) => {
      const data = (args as { data: Prisma.CoachBriefUpdateInput }).data;
      return Promise.resolve({
        id: 'b1',
        coach_id: subCoachId,
        brief_date: '2026-05-25',
        status: 'generated',
        generated_at: new Date(),
        generation_started_at: null,
        narrative: 'placeholder',
        brief_context: data.brief_context,
        action_items: data.action_items,
        generated_by: 'fallback',
        brief_mode: 'sub_coach',
        created_at: new Date(),
      });
    });

    const svc = new CoachBriefService(asPrismaService(prisma), asConfig(makeMockConfig()));
    await svc.generateBrief(subCoachId, 'America/Los_Angeles', '2026-05-25');

    const call = prisma.coachMessage.findMany.mock.calls[0]?.[0] as {
      where: { client_id: { in: string[] }; NOT: { sender_id: string } };
    };
    expect(call.where.client_id).toEqual({ in: assignedClientIds });
    expect(call.where.NOT).toEqual({ sender_id: subCoachId });
    // Critically: we do NOT filter by coach_id (which is head-coach-scoped).
    const whereKeys = Object.keys(call.where);
    expect(whereKeys).not.toContain('coach_id');
  });
});

// ─── Voice fallback (P1-6) ─────────────────────────────────────────────

describe('buildFallbackNarrative — TGP voice contract (P1-6)', () => {
  it('produces 3–5 sentences, opens with coach first name, uses we-voice', () => {
    const out = buildFallbackNarrative(
      makeBriefContext({
        coach_first_name: 'Sarah',
        checked_in_today: 5,
        missed_checkin: 2,
        workouts_pending_approval: 1,
      }),
    );
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.startsWith('Sarah, ')).toBe(true);
    expect(/\b(we|we're|we've|we'll)\b/i.test(out)).toBe(true);
    const sentences = out.split(/(?<=[.!?])(?=\s|$)/).filter((s) => s.trim());
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(5);
  });

  it('produces a valid head-coach fallback', () => {
    const out = buildFallbackNarrative(
      makeHeadCoachContext({ coach_first_name: 'Marcus' }),
    );
    expect(out.startsWith('Marcus, ')).toBe(true);
    expect(/\b(we|we're|we've|we'll)\b/i.test(out)).toBe(true);
    const sentences = out.split(/(?<=[.!?])(?=\s|$)/).filter((s) => s.trim());
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(5);
  });

  it('zero-action solo fallback still satisfies the contract', () => {
    const out = buildFallbackNarrative(
      makeBriefContext({
        checked_in_today: 3,
        missed_checkin: 0,
        workouts_pending_approval: 0,
        weight_logs_flagged: 0,
        unread_messages: 0,
      }),
    );
    expect(out.startsWith('Sarah, ')).toBe(true);
    expect(/\bwe(?:'(?:re|ve|ll))?\b/i.test(out)).toBe(true);
  });
});

// ─── Timezone math (P1-8) ──────────────────────────────────────────────

describe('startOfDayInTz / endOfDayInTz — half-hour + DST (P1-8)', () => {
  function formatInTz(d: Date, tz: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);
  }

  it('Asia/Kolkata (UTC+5:30) start-of-day matches the requested date', () => {
    const start = startOfDayInTz('2026-05-25', 'Asia/Kolkata');
    expect(formatInTz(start, 'Asia/Kolkata').startsWith('2026-05-25')).toBe(true);
    // 00:00 IST → 18:30 UTC prior day
    expect(start.toISOString()).toBe('2026-05-24T18:30:00.000Z');
  });

  it('Asia/Kathmandu (UTC+5:45) start-of-day matches the requested date', () => {
    const start = startOfDayInTz('2026-05-25', 'Asia/Kathmandu');
    expect(formatInTz(start, 'Asia/Kathmandu').startsWith('2026-05-25')).toBe(true);
    expect(start.toISOString()).toBe('2026-05-24T18:15:00.000Z');
  });

  it('Australia/Adelaide (UTC+9:30/+10:30) — start-of-day rolls under DST', () => {
    const start = startOfDayInTz('2026-05-25', 'Australia/Adelaide');
    expect(formatInTz(start, 'Australia/Adelaide').startsWith('2026-05-25')).toBe(true);
  });

  it('America/New_York spring-forward day — endOfDay still resolves to the same calendar date', () => {
    const end = endOfDayInTz('2026-03-08', 'America/New_York');
    expect(formatInTz(end, 'America/New_York').startsWith('2026-03-08')).toBe(true);
  });

  it('America/New_York fall-back day — endOfDay still resolves to the same calendar date', () => {
    const end = endOfDayInTz('2026-11-01', 'America/New_York');
    expect(formatInTz(end, 'America/New_York').startsWith('2026-11-01')).toBe(true);
  });
});

// ─── Pure helpers ──────────────────────────────────────────────────────

describe('buildBriefPrompt', () => {
  it('includes the coach first name and numeric fields (solo)', () => {
    const out = buildBriefPrompt(makeBriefContext({ coach_first_name: 'Sarah' }));
    expect(out).toContain('Coach first name: Sarah');
    expect(out).toContain('Roster size: 7');
    expect(out).toContain('Check-ins received today: 5');
  });

  it('head-coach prompt never includes the solo client section', () => {
    const out = buildBriefPrompt(makeHeadCoachContext());
    expect(out).toContain('TEAM BUSINESS METRICS');
    expect(out).not.toContain('CLIENT DATA');
    expect(out).not.toContain('Roster size:');
  });
});

describe('buildActionItems (solo / sub-coach)', () => {
  it('sorts by priority ASC then by type alphabetically', () => {
    const items = buildActionItems({
      pendingWorkouts: [
        { id: 'w1', client_id: 'c1', client_name: 'Alex', plan_name: 'Upper' },
      ],
      unreadThreads: [
        { client_id: 'c2', client_name: 'Bea', message_preview: 'hi' },
      ],
      flaggedWeightLogs: [
        { client_id: 'c3', client_name: 'Cy', delta_lbs: 5.2 },
      ],
      missingCheckinClients: [{ id: 'c4', name: 'Dan' }],
    });
    expect(items.map((i) => i.priority)).toEqual([1, 1, 2, 3]);
    expect(items[0].type).toBe('message_unread');
    expect(items[1].type).toBe('workout_approval');
  });

  it('caps missing check-in items at 5', () => {
    const items = buildActionItems({
      pendingWorkouts: [],
      unreadThreads: [],
      flaggedWeightLogs: [],
      missingCheckinClients: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        name: `Client ${i}`,
      })),
    });
    expect(items.filter((i) => i.type === 'checkin_missing')).toHaveLength(5);
  });
});

describe('buildHeadCoachActionItems', () => {
  it('emits team-level items with no client identifiers', () => {
    const ctx: BriefContextHeadCoach = makeHeadCoachContext({
      dunning_in_progress: 2,
      dunning_amount_cents: 11000,
    });
    const items = buildHeadCoachActionItems(ctx);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      // No client_id / client_name on the type itself.
      const itemRecord = i as unknown as Record<string, unknown>;
      expect(itemRecord.client_id).toBeUndefined();
      expect(itemRecord.client_name).toBeUndefined();
    }
    const types = items.map((i) => i.type);
    expect(types).toContain('dunning_queue');
  });
});

describe('buildSoloCoachSystemPrompt / buildHeadCoachSystemPrompt', () => {
  it('solo prompt mentions warm voice + first-person plural', () => {
    const p = buildSoloCoachSystemPrompt();
    expect(p).toContain('first-person plural');
    expect(p).toContain('first name');
  });

  it('head-coach prompt mentions COO + revenue', () => {
    const p = buildHeadCoachSystemPrompt();
    expect(p).toContain('COO');
    expect(p).toContain('team');
  });
});

describe('bucketDateLocal', () => {
  it('returns YYYY-MM-DD format', () => {
    const d = new Date('2026-05-25T08:00:00Z');
    expect(bucketDateLocal(d, 'America/Los_Angeles')).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('respects the supplied timezone (Sydney rolls over before UTC)', () => {
    const d = new Date('2026-05-24T23:00:00Z');
    expect(bucketDateLocal(d, 'Australia/Sydney')).toBe('2026-05-25');
    expect(bucketDateLocal(d, 'America/Los_Angeles')).toBe('2026-05-24');
  });
});

// ─── Scheduler ─────────────────────────────────────────────────────────

interface SchedulerNotifications {
  pushToUser: jest.Mock;
}

interface SchedulerBriefService {
  getOrGenerateTodaysBrief: jest.Mock;
}

function makeSchedulerBriefService(
  summary:
    | null
    | { narrative: string } = { narrative: 'Sarah, all clear today.' },
): SchedulerBriefService {
  return {
    getOrGenerateTodaysBrief: jest.fn().mockResolvedValue({
      id: 'b1',
      coach_id: 'coach1',
      brief_date: '2026-05-25',
      status: summary ? 'generated' : 'pending',
      brief_mode: 'solo_coach',
      generated_at: new Date().toISOString(),
      summary: summary
        ? {
            date: '2026-05-25',
            brief_mode: 'solo_coach',
            narrative: summary.narrative,
            brief_context: makeBriefContext(),
            action_items: [],
            generated_by: 'ai',
          }
        : null,
      created_at: new Date().toISOString(),
    }),
  };
}

function makeScheduler(
  prisma: MockPrisma,
  briefService: SchedulerBriefService,
  notifications: SchedulerNotifications,
  config: Record<string, string | undefined> = {},
): CoachBriefScheduler {
  return new CoachBriefScheduler(
    asPrismaService(prisma),
    briefService as unknown as CoachBriefService,
    notifications as unknown as ConstructorParameters<typeof CoachBriefScheduler>[2],
    asConfig(makeMockConfig(config)),
  );
}

describe('CoachBriefScheduler.maybeDispatch', () => {
  it('skips coach when local time does not match notification_time', async () => {
    const prisma = makeMockPrisma();
    const notifications: SchedulerNotifications = { pushToUser: jest.fn() };
    const briefService = { getOrGenerateTodaysBrief: jest.fn() };
    const scheduler = makeScheduler(prisma, briefService, notifications);

    const now = new Date('2026-05-25T12:00:00Z');
    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'token' },
      },
      now,
    );
    expect(briefService.getOrGenerateTodaysBrief).not.toHaveBeenCalled();
    expect(notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('does NOT mark last_push_attempt_date when generation is still in-flight (P1-2)', async () => {
    const prisma = makeMockPrisma();
    const notifications: SchedulerNotifications = { pushToUser: jest.fn() };
    // brief.summary is null — generation is pending / still in-flight.
    const briefService = makeSchedulerBriefService(null);
    const scheduler = makeScheduler(prisma, briefService, notifications);

    const now = new Date('2026-05-25T14:00:00Z'); // 07:00 PT
    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      now,
    );

    expect(briefService.getOrGenerateTodaysBrief).toHaveBeenCalled();
    expect(notifications.pushToUser).not.toHaveBeenCalled();
    // The push ledger must not have been touched — leaving the slot open
    // for the next minute's retry.
    expect(prisma.coachBriefPushLedger.updateMany).not.toHaveBeenCalled();
  });

  it('uses the server-only CoachBriefPushLedger for dedup (P1-9)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPushLedger.upsert.mockResolvedValue({});
    // P1-4 fix round 5: scheduler now reads a ledger snapshot BEFORE
    // claiming the lease so it can short-circuit on prior success and
    // enforce the retry budget. With no prior delivery, the lease claim
    // must succeed and the success-marker updateMany must run.
    prisma.coachBriefPushLedger.findUnique.mockResolvedValue({
      last_push_date: null,
      last_push_attempt_date: null,
      push_attempts_today: 0,
      push_attempt_lease_until: null,
    });
    prisma.coachBriefPushLedger.updateMany
      .mockResolvedValueOnce({ count: 1 }) // lease claim
      .mockResolvedValueOnce({ count: 1 }); // success marker
    const notifications: SchedulerNotifications = {
      // P1-5 fix round 5: pushToUser returns a typed PushDeliveryResult.
      // Scheduler only marks success when delivered=true.
      pushToUser: jest
        .fn()
        .mockResolvedValue({ delivered: true, code: 'delivered' }),
    };
    const briefService = makeSchedulerBriefService();
    const scheduler = makeScheduler(prisma, briefService, notifications);

    const now = new Date('2026-05-25T14:00:00Z');
    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      now,
    );

    expect(prisma.coachBriefPushLedger.upsert).toHaveBeenCalled();
    expect(prisma.coachBriefPushLedger.findUnique).toHaveBeenCalled();
    expect(prisma.coachBriefPushLedger.updateMany).toHaveBeenCalledTimes(2);
    // Critically: CoachBriefPreferences.updateMany must NOT be used for
    // dedup any more — that table holds coach-writable RLS state.
    expect(prisma.coachBriefPreferences.updateMany).not.toHaveBeenCalled();
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark success when pushToUser reports delivered=false (P1-5)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPushLedger.upsert.mockResolvedValue({});
    prisma.coachBriefPushLedger.findUnique.mockResolvedValue({
      last_push_date: null,
      last_push_attempt_date: null,
      push_attempts_today: 0,
      push_attempt_lease_until: null,
    });
    prisma.coachBriefPushLedger.updateMany
      .mockResolvedValueOnce({ count: 1 }) // lease claim
      .mockResolvedValueOnce({ count: 1 }); // lease release (no success)
    const notifications: SchedulerNotifications = {
      // Transport-level error — Expo refused the message. Pre-fix-round-5
      // pushToUser swallowed this and returned void, causing the scheduler
      // to fabricate a delivery record. The new contract returns a typed
      // result whose `delivered` flag is false.
      pushToUser: jest
        .fn()
        .mockResolvedValue({ delivered: false, code: 'transport-error' }),
    };
    const briefService = makeSchedulerBriefService();
    const scheduler = makeScheduler(prisma, briefService, notifications);

    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      new Date('2026-05-25T14:00:00Z'),
    );

    // Two updateMany calls: the lease claim and the lease release.
    // Critically: the second call must NOT set last_push_date.
    expect(prisma.coachBriefPushLedger.updateMany).toHaveBeenCalledTimes(2);
    const secondCallArgs = (
      prisma.coachBriefPushLedger.updateMany as jest.Mock
    ).mock.calls[1][0];
    expect(secondCallArgs.data).not.toHaveProperty('last_push_date');
    expect(secondCallArgs.data.push_attempt_lease_until).toBeNull();
  });

  it('short-circuits when last_push_date already equals briefDate (P1-4)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPushLedger.upsert.mockResolvedValue({});
    // Ledger snapshot shows today's brief already delivered. Scheduler
    // must skip the lease claim AND the pushToUser call entirely.
    prisma.coachBriefPushLedger.findUnique.mockResolvedValue({
      last_push_date: '2026-05-25',
      last_push_attempt_date: '2026-05-25',
      push_attempts_today: 1,
      push_attempt_lease_until: null,
    });
    const notifications: SchedulerNotifications = { pushToUser: jest.fn() };
    const briefService = makeSchedulerBriefService();
    const scheduler = makeScheduler(prisma, briefService, notifications);

    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      new Date('2026-05-25T14:00:00Z'),
    );

    expect(notifications.pushToUser).not.toHaveBeenCalled();
    expect(prisma.coachBriefPushLedger.updateMany).not.toHaveBeenCalled();
  });

  it('stops retrying when daily push budget is exhausted (P1-4)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPushLedger.upsert.mockResolvedValue({});
    // 5 attempts already burned today — scheduler must back off.
    prisma.coachBriefPushLedger.findUnique.mockResolvedValue({
      last_push_date: null,
      last_push_attempt_date: '2026-05-25',
      push_attempts_today: 5,
      push_attempt_lease_until: null,
    });
    const notifications: SchedulerNotifications = { pushToUser: jest.fn() };
    const briefService = makeSchedulerBriefService();
    const scheduler = makeScheduler(prisma, briefService, notifications);

    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      new Date('2026-05-25T14:00:00Z'),
    );

    expect(notifications.pushToUser).not.toHaveBeenCalled();
    expect(prisma.coachBriefPushLedger.updateMany).not.toHaveBeenCalled();
  });

  it('skips push when another instance has already claimed today', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPushLedger.upsert.mockResolvedValue({});
    prisma.coachBriefPushLedger.findUnique.mockResolvedValue({
      last_push_date: null,
      last_push_attempt_date: null,
      push_attempts_today: 0,
      push_attempt_lease_until: null,
    });
    // Attempt claim returns count=0 — another instance won.
    prisma.coachBriefPushLedger.updateMany.mockResolvedValue({ count: 0 });
    const notifications: SchedulerNotifications = { pushToUser: jest.fn() };
    const briefService = makeSchedulerBriefService();
    const scheduler = makeScheduler(prisma, briefService, notifications);

    await scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      new Date('2026-05-25T14:00:00Z'),
    );
    expect(notifications.pushToUser).not.toHaveBeenCalled();
  });

  it('passes an AbortSignal to pushToUser and aborts on timeout (P2-6)', async () => {
    jest.useFakeTimers();
    const prisma = makeMockPrisma();
    prisma.coachBriefPushLedger.upsert.mockResolvedValue({});
    prisma.coachBriefPushLedger.findUnique.mockResolvedValue({
      last_push_date: null,
      last_push_attempt_date: null,
      push_attempts_today: 0,
      push_attempt_lease_until: null,
    });
    prisma.coachBriefPushLedger.updateMany.mockResolvedValue({ count: 1 });
    let receivedSignal: AbortSignal | undefined;
    const notifications: SchedulerNotifications = {
      pushToUser: jest.fn(
        (
          _userId: string,
          _title: string,
          _body: string,
          _data: Record<string, unknown> | undefined,
          signal: AbortSignal | undefined,
        ) => {
          receivedSignal = signal;
          return new Promise(() => undefined); // never resolves
        },
      ),
    };
    const briefService = makeSchedulerBriefService();
    const scheduler = makeScheduler(prisma, briefService, notifications);

    const dispatchPromise = scheduler.maybeDispatch(
      {
        coach_id: 'coach1',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'coach1', name: 'S', expo_push_token: 'ExpoToken' },
      },
      new Date('2026-05-25T14:00:00Z'),
    );

    await jest.advanceTimersByTimeAsync(11_000);
    await expect(dispatchPromise).resolves.toBeUndefined();
    expect(notifications.pushToUser).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    jest.useRealTimers();
  });

  it('respects COACH_BRIEF_NOTIFICATIONS_ENABLED=off (dispatchDailyBriefs no-op)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.findMany.mockResolvedValue([]);
    const scheduler = makeScheduler(
      prisma,
      { getOrGenerateTodaysBrief: jest.fn() },
      { pushToUser: jest.fn() },
      { COACH_BRIEF_NOTIFICATIONS_ENABLED: 'off' },
    );
    await scheduler.dispatchDailyBriefs();
    expect(prisma.coachBriefPreferences.findMany).not.toHaveBeenCalled();
  });

  it('P1-2: COACH_BRIEF_ENABLED=off short-circuits BEFORE the prefs lookup', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.findMany.mockResolvedValue([]);
    const brief = { getOrGenerateTodaysBrief: jest.fn() };
    const push = { pushToUser: jest.fn() };
    const scheduler = makeScheduler(
      prisma,
      brief,
      push,
      // Master kill switch off; notifications switch left on so we prove
      // COACH_BRIEF_ENABLED takes precedence over the narrower flag.
      { COACH_BRIEF_ENABLED: 'off', COACH_BRIEF_NOTIFICATIONS_ENABLED: 'on' },
    );
    await scheduler.dispatchDailyBriefs();
    expect(prisma.coachBriefPreferences.findMany).not.toHaveBeenCalled();
    expect(brief.getOrGenerateTodaysBrief).not.toHaveBeenCalled();
    expect(push.pushToUser).not.toHaveBeenCalled();
  });

  it('does not throw when one coach dispatch fails (Promise.allSettled isolation)', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.findMany.mockResolvedValue([
      {
        coach_id: 'a',
        notification_time: '07:00',
        timezone: 'America/Los_Angeles',
        coach: { id: 'a', name: 'A', expo_push_token: null },
      },
      {
        coach_id: 'b',
        notification_time: 'bad',
        timezone: 'America/Los_Angeles',
        coach: { id: 'b', name: 'B', expo_push_token: null },
      },
    ]);
    const scheduler = makeScheduler(
      prisma,
      { getOrGenerateTodaysBrief: jest.fn() },
      { pushToUser: jest.fn() },
    );
    await expect(scheduler.dispatchDailyBriefs()).resolves.toBeUndefined();
  });
});

// ─── DailyLog + Preferences ─────────────────────────────────────────────

describe('CoachDailyLogService', () => {
  it('returns an empty stub when no log row exists', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);
    prisma.coachDailyLog.findUnique.mockResolvedValue(null);

    const svc = new CoachDailyLogService(asPrismaService(prisma));
    const result = await svc.getTodaysLog('coach1');
    expect(result).toMatchObject({
      coach_id: 'coach1',
      content: '',
      exists: false,
    });
    expect(result.log_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('upserts and returns the persisted log row', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue({
      timezone: 'America/Los_Angeles',
    });
    const created = {
      id: 'l1',
      coach_id: 'coach1',
      log_date: '2026-05-25',
      content: 'good day',
      created_at: new Date(),
      updated_at: new Date(),
    };
    prisma.coachDailyLog.upsert.mockResolvedValue(created);

    const svc = new CoachDailyLogService(asPrismaService(prisma));
    const result = await svc.upsertTodaysLog('coach1', 'good day');
    expect(result.content).toBe('good day');
    expect(prisma.coachDailyLog.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('CoachBriefPreferencesService', () => {
  it('returns defaults when no row exists, without writing', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.findUnique.mockResolvedValue(null);

    const svc = new CoachBriefPreferencesService(asPrismaService(prisma));
    const result = await svc.getOrDefault('coach1');
    expect(result).toMatchObject({
      coach_id: 'coach1',
      notification_time: '07:00',
      timezone: 'America/Los_Angeles',
      enabled: true,
    });
    expect(prisma.coachBriefPreferences.upsert).not.toHaveBeenCalled();
  });

  it('upserts only the supplied fields', async () => {
    const prisma = makeMockPrisma();
    prisma.coachBriefPreferences.upsert.mockResolvedValue({
      coach_id: 'coach1',
      notification_time: '09:30',
      timezone: 'America/Los_Angeles',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const svc = new CoachBriefPreferencesService(asPrismaService(prisma));
    const result = await svc.upsert('coach1', { notification_time: '09:30' });
    expect(result.notification_time).toBe('09:30');
    expect(prisma.coachBriefPreferences.upsert).toHaveBeenCalledTimes(1);
  });
});
