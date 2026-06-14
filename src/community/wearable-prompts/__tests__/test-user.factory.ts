/**
 * Typed test-user factory for the v3-4 wearable-prompts specs.
 *
 * R0 forbids type-escape hatches (forced casts, suppression comments) in
 * PR-introduced code, including tests. The service only reads `User.id` +
 * `User.role`, but the parameter is typed `Pick<User, 'id' | 'role'>`, so a
 * faithful fixture must be exactly that shape. Kept local so the v3-4 slice
 * owns its own fixtures (mirrors the v3-3 voice factory).
 */
import type { Role, User } from '@prisma/client';

export function makeCoachUser(
  id: string,
  role: Role = 'coach',
): Pick<User, 'id' | 'role'> {
  return { id, role };
}
