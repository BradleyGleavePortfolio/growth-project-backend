import sys
root=sys.argv[1]
def load(p): return open(root+'/'+p).read()
def save(p,s): open(root+'/'+p,'w').write(s)
def rep(s,old,new,cnt=1):
    assert s.count(old)==cnt, (old[:80], s.count(old))
    return s.replace(old,new)
p='src/roman/roman.constants.ts'; s=load(p)
s=rep(s,"""/**
 * Daily spend cap for all Roman turns together (UTC day), in US dollars.
 * Env ROMAN_DAILY_COST_CAP_USD (registered in ENV_RULES); default 25. A turn""","""/**
 * Platform-wide daily spend ceiling for all Roman turns together (UTC day),
 * in US dollars: a runaway breaker, not a per-client limit (the per-client
 * limit is the 429 ROMAN_RATE_LIMIT turn cap above; the per-coach money
 * bound is the coach's monthly AI credit pool). Env ROMAN_DAILY_COST_CAP_USD
 * (registered in ENV_RULES); default 100, sized to launch volume (operator
 * 121, 13:33): about 2,000 to 3,000 ordinary turns a day at $0.03 to $0.05
 * each, or 23 clients each at the full 50-turn limit at the worst-case
 * reservation, so ordinary launch use never meets it. A turn""")
s=rep(s,"""export const ROMAN_DAILY_COST_CAP_USD_DEFAULT = 25;""","""export const ROMAN_DAILY_COST_CAP_USD_DEFAULT = 100;""")
s=rep(s,"""/** The failure copy for one machine code, written for the caller's audience. */""","""/**
 * 402 COACH_AI_BUDGET_EXHAUSTED (B-668-1): the coach's monthly AI credit pool
 * is used up. The client copy never shows the coach's credit figures.
 */
export const ROMAN_COACH_POOL_EMPTY_MESSAGE =
  "Your coach's AI credits for this month are used up, so Roman cannot answer right now. Your coach is in Messages any time, and your plan and logs work as usual.";
export const ROMAN_COACH_POOL_EMPTY_MESSAGE_COACH = `The AI credits on your coaching account are used up for this month, so Roman cannot answer right now. Add a credit pack to keep using Roman. ${ROMAN_COACH_NEXT_STEP}`;

/** The failure copy for one machine code, written for the caller's audience. */""")
save(p,s)
p='src/common/env-validation.ts'; s=load(p)
s=rep(s,"""    default: 'unset → 25 (ROMAN_DAILY_COST_CAP_USD_DEFAULT); an invalid value also means 25, never no cap',
    reason:
      'Daily spend cap for all Roman turns together (UTC day, US dollars). Over the cap Roman answers 503 ROMAN_CAPACITY_REACHED; an unreadable ledger fails closed. No boot validator (ENV_RULES hygiene): RomanService.dailyCostCapUsd treats a non-numeric or negative value as 25.',""","""    default: 'unset → 100 (ROMAN_DAILY_COST_CAP_USD_DEFAULT); an invalid value also means 100, never no cap',
    reason:
      'Platform-wide daily spend ceiling for all Roman turns together (UTC day, US dollars), a runaway breaker sized to launch volume; the per-client limit is the 429 ROMAN_RATE_LIMIT turn cap and the per-coach bound is the monthly AI credit pool. Over the ceiling Roman answers 503 ROMAN_CAPACITY_REACHED; an unreadable ledger fails closed. No boot validator (ENV_RULES hygiene): RomanService.dailyCostCapUsd treats a non-numeric or negative value as 100.',""")
save(p,s)
p='.env.example'; s=load(p)
s=rep(s,"""# Daily spend cap for all Roman turns together (UTC day, USD). Unset = 25.
# Over the cap Roman answers 503 ROMAN_CAPACITY_REACHED; fails closed.""","""# Platform-wide daily spend ceiling for all Roman turns together (UTC day,
# USD), a runaway breaker sized to launch volume. Unset = 100. Over it Roman
# answers 503 ROMAN_CAPACITY_REACHED; fails closed. The per-client limit is
# the 429 ROMAN_RATE_LIMIT turn cap; each coach's monthly AI pool still applies.""")
save(p,s)
p='src/roman/roman.controller.ts'; s=load(p)
s=rep(s,"""    if (!crisis) await this.roman.assertDailyCapacity(caller);
""","""    if (!crisis) await this.roman.assertDailyCapacity(caller);
    // B-668-1 — the coach's monthly AI credit pool, before the turn is stored
    // (402 COACH_AI_BUDGET_EXHAUSTED, copy for the caller's audience).
    if (!crisis) await this.roman.assertCoachPoolOpen(caller);
""")
save(p,s)
p='test/roman/roman-launch-hardening.spec.ts'; s=load(p)
s=rep(s,"""    expect(svc.dailyCostCapUsd({ ROMAN_DAILY_COST_CAP_USD: 'lots' })).toBe(25);
    expect(svc.dailyCostCapUsd({})).toBe(25);""","""    expect(svc.dailyCostCapUsd({ ROMAN_DAILY_COST_CAP_USD: 'lots' })).toBe(100);
    expect(svc.dailyCostCapUsd({})).toBe(100);""")
s=rep(s,"""    expect(pc.today.remaining_kcal).toBe(1100);
  });
});
""","""    expect(pc.today.remaining_kcal).toBe(1100);
  });

  it('B-668-3 (Sol): kcal facts keep their family, day and source', () => {
    const base = fakeBundle().context;
    const day = (date: string, active_kcal: number | null) => ({
      date,
      steps: null,
      active_kcal,
      resting_hr_bpm: null,
      hrv_ms: null,
      sleep_hours: null,
      sleep_efficiency_pct: null,
      recovery_score: null,
      readiness_score: null,
    });
    const pc = postCheckContextOf({
      ...base,
      today: {
        ...base.today,
        entries: [{ meal: 'lunch', name: 'Bowl', kcal: 450, protein_g: 30, logged_at: '12:10' }],
      },
      last_7_days: {
        ...base.last_7_days,
        days: [
          { date: '2026-10-01', kcal: 1850, protein_g: 90, carbs_g: 200, fat_g: 60, meals_logged: 3 },
        ],
      },
      wearables: {
        ...base.wearables,
        avg_7d: { ...base.wearables.avg_7d, active_kcal: 380 },
        days: [day('2026-10-01', 400), day('2026-10-02', 2500)],
      },
      meal_plan: { title: 'Plan', items: ['Breakfast oats 200 kcal'] },
    });
    expect(pc.kcal_facts).toEqual({
      intake_entries_today: [450],
      intake_past_days: [1850],
      burned_today: [2500],
      burned_past: [400, 380],
      meal_plan: [200],
    });
  });
});
""")
save(p,s)
p='test/roman/roman-streaming.spec.ts'; s=load(p)
s=rep(s,"""  it('no AI provider configured: an emergency message still gets the 911 template', async () => {""","""  it.each(['I think I am going into anaphylactic shock', 'I took a whole bottle of pills'])(
    'A-666-1 (Opus) no grant + acute emergency without the trigger word (%s): the 911 template, zero model calls',
    async (content) => {
      const { ctrl, anthropic, messages } = setup([]);
      const { res, writes } = makeRes();
      await ctrl.sendMessage(fakeOf(makeReq()), fakeOf(res), 'sess_1', { content });
      const done = parseFrames(writes).find((f) => f.data?.type === 'done');
      expect(done?.data.text).toBe(ROMAN_SAFETY_TEMPLATES.emergency);
      expect(anthropic.messages.stream).not.toHaveBeenCalled();
      expect(messages.map((m) => m.role)).toEqual(['user', 'roman']);
    },
  );

  it('no AI provider configured: an emergency message still gets the 911 template', async () => {""")
save(p,s)
print('rest ok')
