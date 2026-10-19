// test/roman/eval/eval-roman-live.spec.ts
//
// The manual live runner (scripts/eval-roman-live.ts) through a stub SDK: no
// network, no paid call. Every case it runs, in run order, must send its own
// question as the only turn, ground on its own persona at the fixtures' clock,
// and keep the fixed safety replies free of any model call.

import { GOLDEN_SET } from './golden-set';
import { makeStubModel } from './stub-model';
import { withRomanEnabled } from './harness';
import { LOCAL_TODAY_PT } from '../fixtures/roman-personas';
import { LIVE_SKIP, runLiveCase } from '../../../scripts/eval-roman-live';

withRomanEnabled();

const LIVE_CASES = GOLDEN_SET.filter((g) => !LIVE_SKIP.has(g.id));
// What only the right persona's seeded "today" can put in the prompt.
const OWN_TODAY: Record<string, { has: string; not: string }> = {
  P1: { has: 'Greek yogurt bowl', not: 'ZELDA-CANARY food' },
  P4: { has: 'ZELDA-CANARY food', not: 'Greek yogurt bowl' },
};

describe('live Roman eval runner: one fresh, own-question turn per case', () => {
  it('walks every live case in run order over one SDK', async () => {
    expect(LIVE_CASES).toHaveLength(35);
    const model = makeStubModel('Noted.');
    for (const item of LIVE_CASES) {
      const before = model.calls.length;
      const reply = await runLiveCase(model.client, item);
      const sent = model.calls.slice(before);
      if (item.zero_model_calls) {
        expect({ id: item.id, calls: sent.length, reply: reply.length > 0 }).toEqual({ id: item.id, calls: 0, reply: true });
        continue;
      }
      expect({ id: item.id, messages: sent.map((c) => c.body.messages) }).toEqual({
        id: item.id,
        messages: [[{ role: 'user', content: item.question }]],
      });
      const data = sent[0].clientData ?? '';
      expect({ id: item.id, today: data.includes(`"local_date":"${LOCAL_TODAY_PT}"`) }).toEqual({ id: item.id, today: true });
      const own = OWN_TODAY[item.persona];
      if (own) expect({ id: item.id, has: data.includes(own.has), not: data.includes(own.not) }).toEqual({ id: item.id, has: true, not: false });
    }
  });
});
