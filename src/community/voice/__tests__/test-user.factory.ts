/**
 * Typed test-user factory for the v3-3 community voice-notes specs.
 *
 * R0 forbids type-escape hatches (forced double-casts, suppression comments) in
 * PR-introduced code, including tests. The voice service reads `User.id`,
 * `User.role`, and `User.plan_tier`, but the parameter is typed `User`, so a
 * faithful fixture must be a complete `User`. This factory builds every scalar
 * column with a deterministic default, so the returned value is a genuine
 * `User` with no cast — the type checker validates the shape. Mirrors the v3-2
 * classroom factory; kept local so the v3-3 slice owns its own fixtures.
 */
import type { Role, User } from '@prisma/client';

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

export function makeUser(args: { id: string; role: Role; overrides?: Partial<User> }): User {
  const base: User = {
    id: args.id,
    supabase_id: `supabase-${args.id}`,
    email: `${args.id}@example.test`,
    name: 'Test User',
    phone: null,
    role: args.role,
    coach_id: null,
    coach_practice_type: null,
    created_at: EPOCH,
    archived_at: null,
    deletion_scheduled_at: null,
    deleted_at: null,
    deletion_token_hash: null,
    deletion_token_expires_at: null,
    deletion_requested_at: null,
    deletion_confirmed_at: null,
    expo_push_token: null,
    signup_ref: null,
    default_payout_method_id: null,
    first_win_completed_at: null,
    show_on_leaderboard: false,
    leaderboard_display_name: null,
  };
  return { ...base, ...args.overrides };
}
