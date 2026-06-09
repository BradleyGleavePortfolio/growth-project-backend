/**
 * broadcast-ping-contract.spec.ts — §10.1 + §6 ABSOLUTE RULE guard.
 *
 * Every one of the nine v1-4 broadcast payload shapes carries IDs, timestamps,
 * enum state values, and numeric deltas/percents ONLY. This test constructs a
 * realistic instance of each typed payload, parses it through its strict Zod
 * schema (proving no stray keys survive), and asserts the serialized form does
 * NOT match the forbidden user-content key pattern. If a future refactor adds
 * a `body`/`content`/`text`/`emoji`/`reason`/`title`/`excerpt` field, this red.
 */

import 'reflect-metadata';
import {
  MessageCreatedPayloadSchema,
  MessageUpdatedPayloadSchema,
  PostCreatedPayloadSchema,
  PostUpdatedPayloadSchema,
  ReactionChangedPayloadSchema,
  EventStateChangedPayloadSchema,
  ChallengeProgressChangedPayloadSchema,
  ModerationActionCreatedPayloadSchema,
  MembershipChangedPayloadSchema,
} from '../../../src/community/realtime/community-realtime.types';

const FORBIDDEN = /body|content|text|emoji|reason|title|excerpt/i;

// Each entry: a schema + a representative payload covering all of its keys.
const cases: ReadonlyArray<{
  name: string;
  schema: { parse: (v: unknown) => unknown };
  payload: Record<string, unknown>;
  expectedKeys: string[];
}> = [
  {
    name: 'community.message.created',
    schema: MessageCreatedPayloadSchema,
    payload: {
      id: 'msg_1',
      cohortId: 'coh_1',
      authorId: 'usr_1',
      createdAt: '2026-06-09T10:00:00.000Z',
    },
    expectedKeys: ['id', 'cohortId', 'authorId', 'createdAt'],
  },
  {
    name: 'community.message.updated',
    schema: MessageUpdatedPayloadSchema,
    payload: {
      id: 'msg_1',
      cohortId: 'coh_1',
      updatedAt: '2026-06-09T10:01:00.000Z',
    },
    expectedKeys: ['id', 'cohortId', 'updatedAt'],
  },
  {
    name: 'community.post.created',
    schema: PostCreatedPayloadSchema,
    payload: {
      id: 'post_1',
      workspaceId: 'ws_1',
      authorId: 'usr_1',
      createdAt: '2026-06-09T10:00:00.000Z',
    },
    expectedKeys: ['id', 'workspaceId', 'authorId', 'createdAt'],
  },
  {
    name: 'community.post.updated',
    schema: PostUpdatedPayloadSchema,
    payload: {
      id: 'post_1',
      workspaceId: 'ws_1',
      updatedAt: '2026-06-09T10:01:00.000Z',
    },
    expectedKeys: ['id', 'workspaceId', 'updatedAt'],
  },
  {
    name: 'community.reaction.changed',
    schema: ReactionChangedPayloadSchema,
    payload: {
      targetType: 'message',
      targetId: 'msg_1',
      kind: 'cheer',
      delta: 1,
    },
    expectedKeys: ['targetType', 'targetId', 'kind', 'delta'],
  },
  {
    name: 'community.event.state_changed',
    schema: EventStateChangedPayloadSchema,
    payload: {
      eventId: 'evt_1',
      fromState: 'tomorrow',
      toState: 'live',
      at: '2026-06-09T10:00:00.000Z',
    },
    expectedKeys: ['eventId', 'fromState', 'toState', 'at'],
  },
  {
    name: 'community.challenge.progress_changed',
    schema: ChallengeProgressChangedPayloadSchema,
    payload: { challengeId: 'chl_1', userId: 'usr_1', percent: 42 },
    expectedKeys: ['challengeId', 'userId', 'percent'],
  },
  {
    name: 'community.moderation.action_created',
    schema: ModerationActionCreatedPayloadSchema,
    payload: {
      actionId: 'act_1',
      wsId: 'ws_1',
      targetType: 'message',
      targetId: 'msg_1',
      action: 'hide',
    },
    expectedKeys: ['actionId', 'wsId', 'targetType', 'targetId', 'action'],
  },
  {
    name: 'community.membership.changed',
    schema: MembershipChangedPayloadSchema,
    payload: { wsId: 'ws_1', userId: 'usr_1', change: 'joined' },
    expectedKeys: ['wsId', 'userId', 'change'],
  },
];

describe('v1-4 broadcast ping contract (IDs only, no user content)', () => {
  it('covers exactly the nine documented broadcast events', () => {
    expect(cases.map((c) => c.name).sort()).toEqual(
      [
        'community.challenge.progress_changed',
        'community.event.state_changed',
        'community.membership.changed',
        'community.message.created',
        'community.message.updated',
        'community.moderation.action_created',
        'community.post.created',
        'community.post.updated',
        'community.reaction.changed',
      ].sort(),
    );
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('parses through its strict Zod schema with exactly the expected keys', () => {
        const parsed = c.schema.parse(c.payload) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual([...c.expectedKeys].sort());
      });

      it('serialized payload contains no forbidden user-content keys', () => {
        const serialized = JSON.stringify(c.schema.parse(c.payload));
        expect(serialized).not.toMatch(FORBIDDEN);
      });

      it('strict schema rejects an injected `body` field', () => {
        expect(() =>
          c.schema.parse({ ...c.payload, body: 'leaked user text' }),
        ).toThrow();
      });
    });
  }
});
