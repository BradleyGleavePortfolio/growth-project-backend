/**
 * Typed test-user factory for the v3-1 community challenges specs.
 *
 * R0 forbids `as any` / `as unknown as` / `@ts-ignore` escape hatches in
 * PR-introduced code, including tests. The challenge/message services only ever
 * read `User.id` and `User.role`, but those parameters are typed `User`, so a
 * faithful fixture must be a complete `User`. This factory builds every scalar
 * column with a deterministic, schema-valid default, so the returned value is a
 * genuine `User` with no cast at all — the type checker validates the shape.
 */
import type { Role, User } from '@prisma/client';

const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * Build a fully-typed `User` fixture from an id + role (the only fields the
 * services read), filling every other scalar column with a safe default. Extra
 * overrides may be supplied and are merged last.
 */
export function makeUser(args: {
  id: string;
  role: Role;
  overrides?: Partial<User>;
}): User {
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
    default_payout_method_id: null,
    first_win_completed_at: null,
    show_on_leaderboard: false,
    leaderboard_display_name: null,
  };
  return { ...base, ...args.overrides };
}
