/**
 * push-preference-defaults.spec.ts — §10.1 + §8.1 preference-defaults pin.
 *
 * The seven new community NotificationKinds have NO schema column for their
 * channel preferences (v1-4 is schema-frozen), so their defaults live in the
 * code-level COMMUNITY_PUSH_DEFAULTS table and are applied at the read path.
 * This test pins each kind's category + push/inapp/email defaults to the §8.1
 * table so a typo in the matrix is a red test, not a silent prod misconfig.
 */

import 'reflect-metadata';
import { COMMUNITY_PUSH_DEFAULTS } from '../../../src/community/notifications/community-notifications.types';
import { NotificationKind } from '../../../src/notifications/notification-kind';
import { NotificationCategory } from '../../../src/notifications/notification-category.enum';

// §8.1 table, transcribed exactly.
const EXPECTED = [
  {
    kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
    category: NotificationCategory.COACH_DIRECT,
    push: true,
    inapp: true,
    email: false,
  },
  {
    kind: NotificationKind.COMMUNITY_DM_RECEIVED,
    category: NotificationCategory.COACH_DIRECT,
    push: true,
    inapp: true,
    email: false,
  },
  {
    kind: NotificationKind.COMMUNITY_POST_REPLIED,
    category: NotificationCategory.CLIENT_BOT,
    push: true,
    inapp: true,
    email: false,
  },
  {
    kind: NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
    category: NotificationCategory.MILESTONE,
    push: true,
    inapp: true,
    email: false,
  },
  {
    kind: NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
    category: NotificationCategory.MILESTONE,
    push: true,
    inapp: true,
    email: false,
  },
  {
    kind: NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
    category: NotificationCategory.SYSTEM,
    push: true,
    inapp: true,
    email: true,
  },
  {
    kind: NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED,
    category: NotificationCategory.SYSTEM,
    push: false, // too noisy — in-app only
    inapp: true,
    email: false,
  },
] as const;

describe('v1-4 community push preference defaults (§8.1)', () => {
  it('declares defaults for exactly the seven community kinds', () => {
    expect(Object.keys(COMMUNITY_PUSH_DEFAULTS)).toHaveLength(7);
  });

  for (const row of EXPECTED) {
    describe(row.kind, () => {
      const got = COMMUNITY_PUSH_DEFAULTS[row.kind];

      it('maps onto the expected existing NotificationCategory', () => {
        expect(got.category).toBe(row.category);
      });

      it('has the expected push/inapp/email defaults', () => {
        expect({
          push: got.push,
          inapp: got.inapp,
          email: got.email,
        }).toEqual({ push: row.push, inapp: row.inapp, email: row.email });
      });
    });
  }

  it('only membership_changed defaults push OFF', () => {
    const pushOff = Object.entries(COMMUNITY_PUSH_DEFAULTS)
      .filter(([, d]) => d.push === false)
      .map(([k]) => k);
    expect(pushOff).toEqual([NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED]);
  });
});
