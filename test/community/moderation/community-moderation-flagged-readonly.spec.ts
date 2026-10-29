/**
 * LO-1173R2 B1 (B-TEST, lens): GET /community/moderation/flagged feeds the shipped phone's
 * CoachCommunityModerationScreen (mobile main c787007b), which draws Dismiss, Warn, Hide and Ban on
 * EVERY item and never reads `can_act`. Rule D read-only reports (the space's team, the poster's own
 * coach) on that route therefore show four buttons that all answer 404 ("This report has already been
 * handled or removed. Pull down to refresh the queue.") and the report is still there after the
 * refresh. By default the route must serve only reports the caller can act on; read-only reports
 * belong to a caller that asks for them (or to the queue route), until the phone hides the buttons.
 */
import type { User } from '@prisma/client';

import { CommunityModerationService } from '../../../src/community/moderation/community-moderation.service';

function stub<T>(v: unknown): T {
  return v as T;
}

const OWN_COACH = 'b0000000-0000-4000-8000-000000000001';
const REPORT = 'a0000000-0000-4000-8000-000000000001';
const MESSAGE = 'c0000000-0000-4000-8000-000000000001';
const SPACE = 'd0000000-0000-4000-8000-000000000001';
const OTHER_WS = 'e0000000-0000-4000-8000-000000000001';

/** Every model answers no rows, except what a test sets. */
function emptyPrisma(over: Record<string, Record<string, unknown>> = {}) {
  return new Proxy(
    {},
    {
      get: (_t, model: string) =>
        over[model] ?? {
          findMany: jest.fn(async () => []),
          findFirst: jest.fn(async () => null),
          count: jest.fn(async () => 0),
        },
    },
  );
}

describe('LO-1173R2 B1: the flagged route and the shipped phone', () => {
  it('serves a coach only reports they can act on by default (the phone draws Dismiss, Warn, Hide and Ban on every item)', async () => {
    const readOnly = {
      id: REPORT,
      workspace_id: OTHER_WS,
      target_type: 'message',
      target_id: MESSAGE,
      reason: 'spam',
      notes: null,
      status: 'open',
      action: null,
      reported_by_user_id: null,
      created_at: new Date('2026-10-28T10:00:00Z'),
    };
    const moderationRepo = {
      // Rule D: one open report on the own coach's client's row in another coach's public space.
      listForRuleDReader: jest.fn(async () => [readOnly]),
    };
    const prisma = emptyPrisma({
      communityMessage: {
        findMany: jest.fn(async () => [
          { id: MESSAGE, kind: 'text', body: 'hello', sender_id: 'w', cohort_id: SPACE, deleted_at: null },
        ]),
      },
    });
    const service = new CommunityModerationService(
      stub({}),
      stub(moderationRepo),
      stub({}),
      stub({}),
      stub({}),
      stub({}),
      stub(prisma),
      stub({ createSignedDownload: jest.fn(async () => null) }),
    );
    const coach = stub<User>({ id: OWN_COACH, role: 'coach' });

    const { items } = await service.listFlagged(coach, {});

    // Every item the default route returns is one the shipped phone's four buttons can act on.
    expect(items.filter((i) => !i.can_act)).toEqual([]);
  });
});
