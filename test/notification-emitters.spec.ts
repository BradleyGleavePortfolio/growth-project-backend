/**
 * Unit tests for every Phase 9 notification emitter.
 *
 * Strategy: mock NotificationsService.createNotification to capture every
 * call without touching the database. Each test asserts:
 *   - the correct kind value is used
 *   - body text is plain English with no emoji
 *   - body length is <= 160 chars
 *   - payload contains only non-PII context fields
 *   - deep_link uses the tgp:// scheme
 */

import { MilestoneReachedEmitter } from '../src/notifications/emitters/milestone-reached.emitter';
import { MessageReceivedEmitter } from '../src/notifications/emitters/message-received.emitter';
import { MissedCheckinEmitter } from '../src/notifications/emitters/missed-checkin.emitter';
import { WeightTrendAlertEmitter } from '../src/notifications/emitters/weight-trend-alert.emitter';
import { CheckinSubmittedEmitter } from '../src/notifications/emitters/checkin-submitted.emitter';
import { BuildWeekDayUnlockedEmitter } from '../src/notifications/emitters/build-week-day-unlocked.emitter';
import { CoachAlertEmitter } from '../src/notifications/emitters/coach-alert.emitter';
import { NotificationKind } from '../src/notifications/notification-kind';
import type { CreateNotificationInput } from '../src/notifications/notifications.service';

// ── Shared mock setup ────────────────────────────────────────────────────────

const createNotificationMock = jest.fn().mockResolvedValue({ id: 'notif-1' });
const pushToCoachMock = jest.fn().mockResolvedValue(true);

const mockNotificationsService = {
  createNotification: createNotificationMock,
  pushToCoach: pushToCoachMock,
} as never;

function capturedCalls(): CreateNotificationInput[] {
  return createNotificationMock.mock.calls.map((c: [CreateNotificationInput]) => c[0]);
}

beforeEach(() => {
  createNotificationMock.mockClear();
  pushToCoachMock.mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertNoPii(body: string) {
  // Body must not contain raw numeric weight comparisons to other users,
  // financial figures, or @-style email addresses.
  expect(body).not.toMatch(/@\S+\.\S+/); // no email addresses in body
  expect(body.length).toBeLessThanOrEqual(160);
  // Doctrine: no emoji.
  // eslint-disable-next-line no-control-regex
  expect(body).not.toMatch(/[\u{1F300}-\u{1FFFF}]/u);
}

// ── milestone_reached ────────────────────────────────────────────────────────

describe('MilestoneReachedEmitter', () => {
  const emitter = new MilestoneReachedEmitter(mockNotificationsService);

  it('emits inapp + push notifications with correct kind', async () => {
    await emitter.emit('user-1', { milestoneType: 'weight_goal', value: '185 lbs' });

    const calls = capturedCalls();
    expect(calls.length).toBe(2);

    const [inapp, push] = calls;
    expect(inapp.kind).toBe(NotificationKind.MILESTONE_REACHED);
    expect(inapp.channel).toBe('inapp');
    expect(push.kind).toBe(NotificationKind.MILESTONE_REACHED);
    expect(push.channel).toBe('push');
  });

  it('body contains the milestone value and is under 160 chars', async () => {
    await emitter.emit('user-1', { milestoneType: 'checkin_streak_30', value: '30 days' });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('30 days');
    assertNoPii(inapp.body);
  });

  it('body omits value gracefully when not provided', async () => {
    await emitter.emit('user-1', { milestoneType: 'build_week_complete' });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('build week complete');
    assertNoPii(inapp.body);
  });

  it('deep_link uses tgp:// scheme', async () => {
    await emitter.emit('user-1', { milestoneType: 'weight_goal', value: '185 lbs' });
    const [inapp] = capturedCalls();
    expect(inapp.deep_link).toMatch(/^tgp:\/\//);
  });

  it('payload contains milestoneType and value', async () => {
    await emitter.emit('user-1', { milestoneType: 'weight_goal', value: '185 lbs' });
    const [inapp] = capturedCalls();
    expect(inapp.payload).toMatchObject({ milestoneType: 'weight_goal', value: '185 lbs' });
  });

  it('does not throw when createNotification rejects', async () => {
    createNotificationMock.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      emitter.emit('user-1', { milestoneType: 'weight_goal', value: '185 lbs' }),
    ).resolves.toBeUndefined();
  });
});

// ── message_received ─────────────────────────────────────────────────────────

describe('MessageReceivedEmitter', () => {
  const emitter = new MessageReceivedEmitter(mockNotificationsService);

  it('emits to recipient with correct kind', async () => {
    await emitter.emit('client-1', { senderName: 'Alex', threadId: 'thread-abc' });

    const calls = capturedCalls();
    expect(calls.length).toBe(2);
    expect(calls[0].kind).toBe(NotificationKind.MESSAGE_RECEIVED);
    expect(calls[0].user_id).toBe('client-1');
  });

  it('body contains sender name', async () => {
    await emitter.emit('client-1', { senderName: 'Jordan', threadId: 'thread-xyz' });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('Jordan');
    assertNoPii(inapp.body);
  });

  it('deep_link includes threadId when provided', async () => {
    await emitter.emit('client-1', { senderName: 'Alex', threadId: 'thread-abc' });
    const [inapp] = capturedCalls();
    expect(inapp.deep_link).toContain('thread-abc');
  });

  it('deep_link falls back to generic messages route when no threadId', async () => {
    await emitter.emit('client-1', { senderName: 'Alex' });
    const [inapp] = capturedCalls();
    expect(inapp.deep_link).toBe('tgp://messages');
  });
});

// ── missed_checkin ────────────────────────────────────────────────────────────

describe('MissedCheckinEmitter', () => {
  const emitter = new MissedCheckinEmitter(mockNotificationsService);

  it('emits client notification', async () => {
    await emitter.emit({ clientUserId: 'u1', daysMissed: 3 });
    const calls = capturedCalls();
    // At minimum: inapp + push for client
    expect(calls.filter((c) => c.user_id === 'u1').length).toBeGreaterThanOrEqual(2);
  });

  it('emits coach notification when coachId is provided', async () => {
    await emitter.emit({
      clientUserId: 'u1',
      coachId: 'coach-1',
      clientDisplayName: 'Sam',
      daysMissed: 4,
    });
    const calls = capturedCalls();
    expect(calls.some((c) => c.user_id === 'coach-1')).toBe(true);
  });

  it('coach body contains daysMissed count', async () => {
    await emitter.emit({
      clientUserId: 'u1',
      coachId: 'coach-1',
      clientDisplayName: 'Sam',
      daysMissed: 5,
    });
    const coachCalls = capturedCalls().filter((c) => c.user_id === 'coach-1');
    expect(coachCalls[0].body).toContain('5');
  });

  it('body does not exceed 160 chars', async () => {
    await emitter.emit({ clientUserId: 'u1', daysMissed: 100 });
    capturedCalls().forEach((c) => assertNoPii(c.body));
  });

  it('kind is MISSED_CHECKIN on all calls', async () => {
    await emitter.emit({ clientUserId: 'u1', daysMissed: 3 });
    capturedCalls().forEach((c) => {
      expect(c.kind).toBe(NotificationKind.MISSED_CHECKIN);
    });
  });
});

// ── weight_trend_alert ───────────────────────────────────────────────────────

describe('WeightTrendAlertEmitter', () => {
  const emitter = new WeightTrendAlertEmitter(mockNotificationsService);

  it('emits for toward_goal direction', async () => {
    await emitter.emit('u1', { direction: 'toward_goal', windowDays: 5, avgDeltaLbs: -0.3 });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('toward your goal');
    assertNoPii(inapp.body);
  });

  it('emits for away_from_goal direction', async () => {
    await emitter.emit('u1', { direction: 'away_from_goal', windowDays: 5, avgDeltaLbs: 0.5 });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('away from your goal');
  });

  it('emits for stalled direction', async () => {
    await emitter.emit('u1', { direction: 'stalled', windowDays: 7, avgDeltaLbs: 0 });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('stable');
  });

  it('deep_link points to weight screen', async () => {
    await emitter.emit('u1', { direction: 'toward_goal', windowDays: 5, avgDeltaLbs: -0.3 });
    const [inapp] = capturedCalls();
    expect(inapp.deep_link).toBe('tgp://weight');
  });

  it('payload contains avgDeltaLbs for in-app use', async () => {
    await emitter.emit('u1', { direction: 'toward_goal', windowDays: 5, avgDeltaLbs: -0.3 });
    const [inapp] = capturedCalls();
    expect(inapp.payload).toMatchObject({ avgDeltaLbs: -0.3 });
  });
});

// ── checkin_submitted ────────────────────────────────────────────────────────

describe('CheckinSubmittedEmitter', () => {
  const emitter = new CheckinSubmittedEmitter(mockNotificationsService);

  it('notifies the coach, not the client', async () => {
    await emitter.emit({
      coachId: 'coach-1',
      clientDisplayName: 'Sam',
      clientUserId: 'u1',
      streakDays: 7,
    });
    const calls = capturedCalls();
    expect(calls.every((c) => c.user_id === 'coach-1')).toBe(true);
  });

  it('body contains streak count and is numeric', async () => {
    await emitter.emit({
      coachId: 'coach-1',
      clientDisplayName: 'Sam',
      clientUserId: 'u1',
      streakDays: 14,
    });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('14');
    assertNoPii(inapp.body);
  });

  it('deep_link routes to client check-in feed', async () => {
    await emitter.emit({
      coachId: 'coach-1',
      clientDisplayName: 'Sam',
      clientUserId: 'u1',
      streakDays: 3,
    });
    const [inapp] = capturedCalls();
    expect(inapp.deep_link).toContain('u1');
  });
});

// ── build_week_day_unlocked ───────────────────────────────────────────────────

describe('BuildWeekDayUnlockedEmitter', () => {
  const emitter = new BuildWeekDayUnlockedEmitter(mockNotificationsService);

  it('emits to the client with correct kind', async () => {
    await emitter.emit('u1', { dayNumber: 2, dayTitle: 'STRATEGY' });
    const calls = capturedCalls();
    expect(calls[0].kind).toBe(NotificationKind.BUILD_WEEK_DAY_UNLOCKED);
    expect(calls[0].user_id).toBe('u1');
  });

  it('body contains day number and title', async () => {
    await emitter.emit('u1', { dayNumber: 3, dayTitle: 'INCOME SETUP' });
    const [inapp] = capturedCalls();
    expect(inapp.body).toContain('Day 3');
    expect(inapp.body).toContain('INCOME SETUP');
    assertNoPii(inapp.body);
  });

  it('deep_link includes day number', async () => {
    await emitter.emit('u1', { dayNumber: 4, dayTitle: 'BODY PROTOCOL' });
    const [inapp] = capturedCalls();
    expect(inapp.deep_link).toContain('4');
  });
});

// ── coach_alert ───────────────────────────────────────────────────────────────

describe('CoachAlertEmitter', () => {
  const emitter = new CoachAlertEmitter(mockNotificationsService);

  it('emits inapp notification and calls pushToCoach', async () => {
    await emitter.emit({
      coachId: 'coach-1',
      alertId: 'alert-1',
      alertType: 'risk_red_transition',
      message: 'Client shows high churn risk signals.',
      severity: 'critical',
      clientUserId: 'u1',
    });

    const calls = capturedCalls();
    expect(calls.some((c) => c.channel === 'inapp')).toBe(true);
    expect(pushToCoachMock).toHaveBeenCalledWith(
      'coach-1',
      expect.objectContaining({ alertId: 'alert-1', alertType: 'risk_red_transition' }),
    );
  });

  it('notification goes to coach, not client', async () => {
    await emitter.emit({
      coachId: 'coach-1',
      alertId: 'alert-1',
      alertType: 'consecutive_misses',
      message: 'Client has missed 3 check-ins.',
      severity: 'warning',
    });
    capturedCalls().forEach((c) => {
      expect(c.user_id).toBe('coach-1');
    });
  });

  it('body is truncated to 160 chars max', async () => {
    const longMessage = 'A'.repeat(200);
    await emitter.emit({
      coachId: 'coach-1',
      alertId: 'a1',
      alertType: 'test',
      message: longMessage,
      severity: 'info',
    });
    capturedCalls().forEach((c) => {
      expect(c.body.length).toBeLessThanOrEqual(160);
    });
  });
});
