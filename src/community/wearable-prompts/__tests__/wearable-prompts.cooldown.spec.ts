/**
 * WearablePromptsRepository.isWithinCooldown — F4 two-gate cooldown (PR #399).
 *
 * Mocks PrismaService so this runs with NO DB / NO Supabase. It pins the F4 /
 * Decision 9 (A) regression the R81 audit called out:
 *
 *   The 24h cooldown is a TWO-GATE design. The partial unique index
 *   community_wearable_prompts_active_cooldown_key guards ONLY the
 *   concurrent-undismissed case (a dismissed row drops OUT of the partial
 *   index). The cooldown-ACROSS-dismissed gate is THIS query, which must count
 *   any prompt generated inside the window REGARDLESS of dismissedAt.
 *
 *   Bouncer metaphor: the door checks two things — is there already an active
 *   prompt in the room? (unique index) and did this coach just dismiss one in
 *   the last 24h? (this cooldown query). Both bouncers must be present.
 *
 * Regression: a coach dismisses a prompt, the same signal fires 1 min later,
 * the 24h window has NOT elapsed -> isWithinCooldown still reports `true` (no
 * new prompt). The WHERE clause therefore must NOT carry a dismissedAt filter.
 */
import { WearablePromptsRepository } from '../wearable-prompts.repository';
import { WEARABLE_PROMPT_COOLDOWN_MS } from '../wearable-prompts.dto';

const COACH_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const PROMPT_ID = '55555555-5555-5555-5555-555555555555';
const METRIC = 'HRV_MS';

function makePrisma() {
  return {
    communityWearablePrompt: {
      findFirst: jest.fn(),
    },
  };
}

describe('WearablePromptsRepository.isWithinCooldown (F4 two-gate)', () => {
  afterEach(() => jest.clearAllMocks());

  it('still gates a NEW prompt 1 min after the coach dismissed the last one', async () => {
    // A prompt was generated at T0 and dismissed at T0+1min. At T0+1min a fresh
    // signal fires. The 24h window has NOT elapsed, so the cooldown must still
    // hold even though the prior prompt is dismissed (Decision 9 (A)).
    const prisma = makePrisma();
    prisma.communityWearablePrompt.findFirst.mockResolvedValue({ id: PROMPT_ID });
    const repo = new WearablePromptsRepository(prisma as never);

    const now = new Date('2026-06-14T00:01:00.000Z'); // 1 min after generation
    const within = await repo.isWithinCooldown(COACH_ID, CLIENT_ID, METRIC, now);

    expect(within).toBe(true);
    // The WHERE clause must NOT filter on dismissedAt (the whole point of F4):
    const whereArg = prisma.communityWearablePrompt.findFirst.mock.calls[0]![0]!
      .where as Record<string, unknown>;
    expect(whereArg).not.toHaveProperty('dismissedAt');
    expect(whereArg).toMatchObject({
      coachId: COACH_ID,
      clientId: CLIENT_ID,
      metricKey: METRIC,
    });
    // ...and the generatedAt lower-bound is exactly now - cooldown.
    const since = (whereArg.generatedAt as { gte: Date }).gte;
    expect(since.getTime()).toBe(now.getTime() - WEARABLE_PROMPT_COOLDOWN_MS);
  });

  it('reports NOT within cooldown once the window has fully elapsed', async () => {
    const prisma = makePrisma();
    prisma.communityWearablePrompt.findFirst.mockResolvedValue(null);
    const repo = new WearablePromptsRepository(prisma as never);
    const within = await repo.isWithinCooldown(
      COACH_ID,
      CLIENT_ID,
      METRIC,
      new Date('2026-06-16T00:00:00.000Z'),
    );
    expect(within).toBe(false);
  });
});
