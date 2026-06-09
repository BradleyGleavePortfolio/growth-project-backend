/**
 * lockscreen-privacy.spec.ts — §10.1 + §8.2 DIRTY-CRITICAL privacy guard.
 *
 * When the recipient has lock-screen privacy enabled the push body MUST be a
 * fixed safe string carrying NO user names, message excerpts, post content,
 * cohort names, or event titles. With privacy OFF, the four high-signal kinds
 * use the richer templated body. This test pins both states against §8.2 and
 * proves an adversarial tenant value never appears in a privacy-ON body.
 */

import 'reflect-metadata';
import { COMMUNITY_PUSH_BODIES } from '../../../src/community/notifications/community-notifications.types';
import { NotificationKind } from '../../../src/notifications/notification-kind';

const LEAK = 'SECRET-LEAK-TOKEN-XYZ';

describe('v1-4 lock-screen privacy push bodies (§8.2)', () => {
  describe('privacy ON — fixed safe strings (the four high-signal kinds)', () => {
    it('community_message_received', () => {
      expect(COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_MESSAGE_RECEIVED].privacyOn).toBe(
        'New community message',
      );
    });
    it('community_dm_received', () => {
      expect(COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_DM_RECEIVED].privacyOn).toBe(
        'New direct message',
      );
    });
    it('community_post_replied', () => {
      expect(COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_POST_REPLIED].privacyOn).toBe(
        'New reply on your post',
      );
    });
    it('community_event_starting_soon', () => {
      expect(
        COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_EVENT_STARTING_SOON].privacyOn,
      ).toBe('Event starting soon');
    });
  });

  describe('privacy OFF — templated bodies (§8.2 right column)', () => {
    it('community_message_received interpolates cohort name', () => {
      expect(
        COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_MESSAGE_RECEIVED].privacyOff({
          cohortName: 'Sunrise Squad',
        }),
      ).toBe('Sunrise Squad · new message');
    });
    it('community_dm_received interpolates sender initial', () => {
      expect(
        COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_DM_RECEIVED].privacyOff({
          senderInitial: 'A',
        }),
      ).toBe('A sent you a message');
    });
    it('community_post_replied interpolates replier initial', () => {
      expect(
        COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_POST_REPLIED].privacyOff({
          replierInitial: 'B',
        }),
      ).toBe('B replied to your post');
    });
    it('community_event_starting_soon interpolates event title', () => {
      expect(
        COMMUNITY_PUSH_BODIES[NotificationKind.COMMUNITY_EVENT_STARTING_SOON].privacyOff({
          eventTitle: 'Morning Mobility',
        }),
      ).toBe('Morning Mobility starts in 15 min');
    });
  });

  describe('privacy ON bodies never leak adversarial tenant data', () => {
    const allKinds = [
      NotificationKind.COMMUNITY_MESSAGE_RECEIVED,
      NotificationKind.COMMUNITY_DM_RECEIVED,
      NotificationKind.COMMUNITY_POST_REPLIED,
      NotificationKind.COMMUNITY_EVENT_STARTING_SOON,
      NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
      NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
      NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED,
    ] as const;

    for (const kind of allKinds) {
      it(`${kind}: privacyOn is a constant, ignores any context`, () => {
        // privacyOn is a plain string — there is no place to inject a leak.
        expect(COMMUNITY_PUSH_BODIES[kind].privacyOn).not.toContain(LEAK);
        expect(typeof COMMUNITY_PUSH_BODIES[kind].privacyOn).toBe('string');
      });
    }
  });

  describe('the three low-signal kinds fall back to the safe string in both states', () => {
    const fallbackKinds = [
      NotificationKind.COMMUNITY_CHALLENGE_MILESTONE,
      NotificationKind.COMMUNITY_MODERATION_ACTION_AGAINST_ME,
      NotificationKind.COMMUNITY_MEMBERSHIP_CHANGED,
    ] as const;

    for (const kind of fallbackKinds) {
      it(`${kind}: privacyOff() === privacyOn (no richer template)`, () => {
        const copy = COMMUNITY_PUSH_BODIES[kind];
        expect(copy.privacyOff({})).toBe(copy.privacyOn);
      });
    }
  });
});
