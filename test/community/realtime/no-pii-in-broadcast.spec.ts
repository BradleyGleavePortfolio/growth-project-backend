/**
 * no-pii-in-broadcast.spec.ts — §10.1 DIRTY-CRITICAL guard.
 *
 * Adversarial test: a caller is handed a DB write result that ALSO contains the
 * user's authored body text ("SECRET-LEAK-TOKEN-XYZ"). The broadcast payload
 * builders must select ONLY id/timestamp/enum fields — the strict Zod schema
 * rejects the extra `body`/`content`/etc. keys, so the leak token can never be
 * serialized onto the channel an unauthenticated observer might watch.
 *
 * We assert at two layers:
 *  1. Constructing the payload from the *narrowed* fields never includes the
 *     token (the serialized form does not contain it).
 *  2. If someone naively spreads the whole write row into the schema, the
 *     strict parse THROWS rather than silently letting the token through.
 */

import 'reflect-metadata';
import {
  MessageCreatedPayloadSchema,
  PostCreatedPayloadSchema,
  ReactionChangedPayloadSchema,
  ModerationActionCreatedPayloadSchema,
} from '../../../src/community/realtime/community-realtime.types';

const LEAK = 'SECRET-LEAK-TOKEN-XYZ';

// Simulated DB write rows that include user-authored content alongside ids.
const messageRow = {
  id: 'msg_1',
  cohortId: 'coh_1',
  authorId: 'usr_1',
  createdAt: '2026-06-09T10:00:00.000Z',
  body: LEAK,
  content: LEAK,
  text: LEAK,
};

const postRow = {
  id: 'post_1',
  workspaceId: 'ws_1',
  authorId: 'usr_1',
  createdAt: '2026-06-09T10:00:00.000Z',
  body: LEAK,
  excerpt: LEAK,
};

const reactionRow = {
  targetType: 'message' as const,
  targetId: 'msg_1',
  kind: 'cheer',
  delta: 1,
  emoji: LEAK, // the raw glyph/label — must never broadcast
};

const moderationRow = {
  actionId: 'act_1',
  wsId: 'ws_1',
  targetType: 'message',
  targetId: 'msg_1',
  action: 'hide',
  reason: LEAK, // moderator's free-text reason — must never broadcast
};

describe('no PII / user content in v1-4 broadcast payloads (adversarial)', () => {
  it('message.created: narrowed payload omits the leak token', () => {
    const safe = MessageCreatedPayloadSchema.parse({
      id: messageRow.id,
      cohortId: messageRow.cohortId,
      authorId: messageRow.authorId,
      createdAt: messageRow.createdAt,
    });
    expect(JSON.stringify(safe)).not.toContain(LEAK);
  });

  it('post.created: narrowed payload omits the leak token', () => {
    const safe = PostCreatedPayloadSchema.parse({
      id: postRow.id,
      workspaceId: postRow.workspaceId,
      authorId: postRow.authorId,
      createdAt: postRow.createdAt,
    });
    expect(JSON.stringify(safe)).not.toContain(LEAK);
  });

  it('reaction.changed: narrowed payload omits the leak token', () => {
    const safe = ReactionChangedPayloadSchema.parse({
      targetType: reactionRow.targetType,
      targetId: reactionRow.targetId,
      kind: reactionRow.kind,
      delta: reactionRow.delta,
    });
    expect(JSON.stringify(safe)).not.toContain(LEAK);
  });

  it('moderation.action_created: narrowed payload omits the leak token', () => {
    const safe = ModerationActionCreatedPayloadSchema.parse({
      actionId: moderationRow.actionId,
      wsId: moderationRow.wsId,
      targetType: moderationRow.targetType,
      targetId: moderationRow.targetId,
      action: moderationRow.action,
    });
    expect(JSON.stringify(safe)).not.toContain(LEAK);
  });

  it('strict schemas THROW if a whole leaky write row is spread in', () => {
    expect(() => MessageCreatedPayloadSchema.parse(messageRow)).toThrow();
    expect(() => PostCreatedPayloadSchema.parse(postRow)).toThrow();
    expect(() => ReactionChangedPayloadSchema.parse(reactionRow)).toThrow();
    expect(() =>
      ModerationActionCreatedPayloadSchema.parse(moderationRow),
    ).toThrow();
  });
});
