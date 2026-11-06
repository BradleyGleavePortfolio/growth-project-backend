// LO-1224 B-TEST B1 (never merge): the speed test must time every read the six screens fire when they open.
// Read lists from growth-project-mobile c26961a3:
//   Home (Needs you): src/screens/coach/home-v11/useCoachHomeV11.ts:99-106 (loadMonth, ltv, at-risk), :34-35
//     (usePendingAiDrafts -> GET /ai/gateway/drafts?status=pending, useClientUnreadCount -> GET /notifications/unread-count),
//     planEndedData.ts:62 (GET /v1/coach/churned-clients?take=50).
//   Client list: src/screens/coach/lookup/ClientLookupScreen.tsx:107 (loadEnded at 45 clients).
//   Money: src/screens/coach/money/MoneyScreen.tsx:222 (GET /coach/connect/status, no Stripe call for a ready account)
//     and :229 (useAIBudget -> GET /coach/ai/budget).
import { readFileSync } from 'fs';
import { join } from 'path';

const spec = readFileSync(join(__dirname, 'coach-busy-reads.speed.spec.ts'), 'utf8');
const timed = (screen: string) =>
  [...spec.matchAll(/\{ screen: '([^']+)', path: [`']([^`']+)[`']/g)].filter((m) => m[1] === screen).map((m) => m[2].split('?')[0]);

describe('coach busy reads coverage (LO-1224 B1)', () => {
  it('times every read the Home (Needs you), the client list and Money fire on open', () => {
    const missing = [
      ...['/coach/command-center/ltv-metrics', '/coach/command-center/at-risk', '/ai/gateway/drafts', '/notifications/unread-count', '/v1/coach/churned-clients']
        .filter((p) => !timed('Needs you').includes(p)).map((p) => `Needs you ${p}`),
      ...['/v1/coach/churned-clients'].filter((p) => !timed('Client list').includes(p)).map((p) => `Client list ${p}`),
      ...['/coach/connect/status', '/coach/ai/budget'].filter((p) => !timed('Money').includes(p)).map((p) => `Money ${p}`),
    ];
    expect(missing).toEqual([]);
  });
});
