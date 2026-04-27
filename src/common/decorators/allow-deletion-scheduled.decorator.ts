import { SetMetadata } from '@nestjs/common';

// SECURITY: mark an endpoint as reachable by a user whose account is
// scheduled-for-deletion. JwtAuthGuard otherwise rejects requests from
// such users with 403 so a logged-in client cannot keep mutating data
// during the grace window. The recovery endpoints
// (`/users/me/account/cancel-deletion`, `/users/me/account/deletion-status`)
// are the only routes that legitimately need this opt-out — without it
// the user could not undo the schedule.
export const ALLOW_DELETION_SCHEDULED_KEY = 'allowDeletionScheduled';
export const AllowDeletionScheduled = () =>
  SetMetadata(ALLOW_DELETION_SCHEDULED_KEY, true);
