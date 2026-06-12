/**
 * Typed test fixture builders for the v2-2 ack suites.
 *
 * Exists so the colocated specs never reach for `as unknown as` double-casts
 * (R0): every fake is a fully-typed object built from the generated Prisma
 * model types. `buildMessage` returns a complete, correctly-typed
 * `CommunityMessage` (verified with `satisfies`), and actors are typed as
 * `AckActor` (`Pick<User, 'id' | 'role'>` — exactly what the service reads),
 * so no User field has to be faked.
 *
 * Test-only module (imported solely from `*.spec.ts`); it ships no runtime
 * behaviour into the application bundle.
 */
import type { CommunityMessage } from '@prisma/client';
import type { AckActor } from './ack.service';

const DEFAULT_AT = new Date('2026-01-01T00:00:00.000Z');

export const FIXTURE_IDS = {
  workspace: '22222222-2222-2222-2222-222222222222',
  cohort: '11111111-1111-1111-1111-111111111111',
  message: 'eeeeeeee-0000-4000-8000-000000000001',
  coach: 'cccccccc-0000-0000-0000-00000000000a',
  owner: 'ffffffff-0000-0000-0000-00000000000f',
  foreignCoach: 'aaaaaaaa-0000-0000-0000-00000000000c',
  clientSender: 'dddddddd-0000-0000-0000-00000000000b',
} as const;

/** A coach actor (workspace coach by default). */
export function coachUser(overrides: Partial<AckActor> = {}): AckActor {
  return { id: FIXTURE_IDS.coach, role: 'coach', ...overrides };
}

/** A platform owner actor. */
export function ownerUser(overrides: Partial<AckActor> = {}): AckActor {
  return { id: FIXTURE_IDS.owner, role: 'owner', ...overrides };
}

/** A coach actor in a DIFFERENT workspace (used for the non-leak 404 test). */
export function foreignCoachUser(overrides: Partial<AckActor> = {}): AckActor {
  return { id: FIXTURE_IDS.foreignCoach, role: 'coach', ...overrides };
}

/**
 * A fully-typed `CommunityMessage` row. Defaults to a client-authored cohort
 * message with no ack columns stamped; pass overrides to stamp columns, change
 * scope, soft-delete, etc. The `satisfies` proves every field is present and
 * correctly typed without a cast.
 */
export function buildMessage(
  overrides: Partial<CommunityMessage> = {},
): CommunityMessage {
  const base = {
    id: FIXTURE_IDS.message,
    created_at: DEFAULT_AT,
    workspace_id: FIXTURE_IDS.workspace,
    cohort_id: FIXTURE_IDS.cohort,
    scope: 'cohort',
    dm_key: null,
    recipient_user_id: null,
    sender_id: FIXTURE_IDS.clientSender,
    kind: 'text',
    body: 'hello coach',
    voice_url: null,
    voice_duration_ms: null,
    voice_mime_type: null,
    voice_size_bytes: null,
    plan_context_type: null,
    plan_context_id: null,
    plan_week_start: null,
    plan_context_payload: null,
    parent_message_id: null,
    parent_message_at: null,
    coach_seen_at: null,
    coach_acked_at: null,
    coach_replied_at: null,
    visibility: 'active',
    deleted_at: null,
    updated_at: DEFAULT_AT,
  } satisfies CommunityMessage;
  return { ...base, ...overrides };
}

/** Convenience alias matching the prior `msg(...)` builder name. */
export function message(
  overrides: Partial<CommunityMessage> = {},
): CommunityMessage {
  return buildMessage(overrides);
}
