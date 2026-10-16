/**
 * GAPS3-F2 / DECISIONS #C3-DAYONE: a client with no coach gets a fixed Day
 * One note from Roman (C3-S-85, C3-S-86, C3-S-87, approved verbatim, owner
 * item 16, 2026-10-14) and no AI call of any kind. The check is
 * romanRequiresCoach, the one behind Roman's 403 ROMAN_REQUIRES_COACH, on the
 * client's own User row read in the same request. Coached clients keep the
 * AI message.
 */
import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  PerplexityHandle,
  type PerplexityChatClient,
} from '../src/ai-egress/ai-egress.service';
import { CompleteFirstWinDto } from '../src/first-win/first-win.dto';
import { FirstWinService, type WinType } from '../src/first-win/first-win.service';
import { egressWithGrants, fakeOf } from './ai-egress/ai-egress.fakes';

interface Row {
  first_win_completed_at: Date | null;
  role: string;
  coach_id: string | null;
  name: string;
}

function harness(row: Row, others: Record<string, Row> = {}) {
  process.env.PERPLEXITY_API_KEY = 'pk-test';
  // Only User rows exist on this fake: a credit, audit or consent table
  // touched by the coachless path would throw. `others` holds other clients'
  // rows by id; any other id reads `row`.
  const prisma = {
    user: {
      findUniqueOrThrow: jest.fn(async (args: { where: { id: string } }) => ({
        ...(others[args.where.id] ?? row),
      })),
      update: jest.fn(async () => ({})),
    },
  };
  const { egress, reader } = egressWithGrants(['client-1']);
  const egressCall = jest.spyOn(egress, 'perplexityChatCreate');
  const create = jest.fn(async () => ({
    choices: [{ message: { content: 'A model written two sentence reply.' } }],
  }));
  const svc = new FirstWinService(fakeOf(prisma), egress);
  svc['_perplexity'] = PerplexityHandle.bind(
    fakeOf<PerplexityChatClient>({ chat: { completions: { create } } }),
  );
  svc['_perplexityInitialized'] = true;
  return { svc, prisma, reader, egressCall, create };
}

const COACHLESS: Row = {
  first_win_completed_at: null,
  role: 'student',
  coach_id: null,
  name: 'Sam Rivers',
};

describe('first-win: coachless clients get the fixed Day One note, no AI', () => {
  const prev = process.env.PERPLEXITY_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = prev;
  });

  const cases: Array<[WinType, string]> = [
    [
      'first_meal',
      'Your first meal is logged, Sam. A few days of meals like this tell your plan more than any form.',
    ],
    [
      'logged_first_weight',
      'Your starting weight is in, Sam. Every weigh-in from here is measured against today.',
    ],
    ['first_checkin', "Today's habits are ticked, Sam. One tick a day is how a streak starts."],
  ];

  it.each(cases)('%s returns the exact approved text with the first name', async (winType, text) => {
    const { svc, prisma, reader, egressCall, create } = harness(COACHLESS);
    const res = await svc.complete('client-1', winType);
    expect(res.aiMessage).toBe(text);
    expect(res.completedAt).toBeInstanceOf(Date);
    expect(create).toHaveBeenCalledTimes(0);
    expect(egressCall).toHaveBeenCalledTimes(0);
    expect(reader.calls).toHaveLength(0);
    // Only the caller's own row is read.
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-1' } }),
    );
  });

  it('with no approved note (set_first_goal) or no first name: the existing fixed message, still no AI', async () => {
    // Word for word the deterministic messages already on main (no new text).
    const goal = harness(COACHLESS);
    const g = await goal.svc.complete('client-1', 'set_first_goal');
    expect(g.aiMessage).toBe(
      'Setting a clear goal turns a direction into a destination. Every decision from here — what you eat, when you train — can now be tested against that target.',
    );
    const blank = harness({ ...COACHLESS, name: '  ' });
    const b = await blank.svc.complete('client-1', 'first_meal');
    expect(b.aiMessage).toBe(
      'Logging your first meal starts your nutrition baseline. Three days of honest data says more about your habits than any intake form.',
    );
    const blankWeight = harness({ ...COACHLESS, name: '' });
    const w = await blankWeight.svc.complete('client-1', 'logged_first_weight');
    expect(w.aiMessage).toBe(
      'Your first weight log sets the baseline every future measurement is compared against. Tracking consistently, even on days the number is not where you want it, is the discipline that produces results over 90 days.',
    );
    const blankHabits = harness({ ...COACHLESS, name: '' });
    const c = await blankHabits.svc.complete('client-1', 'first_checkin');
    expect(c.aiMessage).toBe(
      'Checking off your daily habits is the smallest unit of progress. One tick a day, repeated for 90 days, is the consistency that compounds into results.',
    );
    for (const h of [goal, blank, blankWeight, blankHabits]) {
      expect(h.create).toHaveBeenCalledTimes(0);
      expect(h.egressCall).toHaveBeenCalledTimes(0);
      expect(h.reader.calls).toHaveLength(0);
    }
  });

  it("names only the caller: another client's row and first name never reach the response", async () => {
    const { svc, prisma } = harness(COACHLESS, {
      'client-2': { ...COACHLESS, name: 'Alex Moore' },
    });
    const res = await svc.complete('client-2', 'first_meal');
    expect(res.aiMessage).toBe(
      'Your first meal is logged, Alex. A few days of meals like this tell your plan more than any form.',
    );
    expect(res.aiMessage).not.toContain('Sam');
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-2' } }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'client-2' } }),
    );
  });

  it('coached client: unchanged, the model writes the message', async () => {
    const { svc, create, egressCall } = harness({ ...COACHLESS, coach_id: 'coach-1' });
    const res = await svc.complete('client-1', 'first_meal');
    expect(res.aiMessage).toBe('A model written two sentence reply.');
    expect(create).toHaveBeenCalledTimes(1);
    expect(egressCall).toHaveBeenCalledTimes(1);
  });

  it('coach left mid-day: the next call reads coach_id null and gets the fixed text', async () => {
    const row: Row = { ...COACHLESS, coach_id: 'coach-1' };
    const { svc, prisma, create } = harness(row);
    await svc.complete('client-1', 'logged_first_weight');
    expect(create).toHaveBeenCalledTimes(1);
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      ...row,
      coach_id: null,
      first_win_completed_at: new Date('2026-10-14T09:00:00Z'),
    });
    const res = await svc.complete('client-1', 'logged_first_weight');
    expect(res.aiMessage).toBe(
      'Your starting weight is in, Sam. Every weigh-in from here is measured against today.',
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('unknown action keeps the 400 from the global validation pipe', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(
      pipe.transform({ winType: 'dance' }, { type: 'body', metatype: CompleteFirstWinDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
