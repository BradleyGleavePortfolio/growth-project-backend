import type { User } from '@prisma/client';

// Shape of a request that has passed JwtAuthGuard — the guard attaches the
// Prisma User record as req.user. Typed here so controllers can annotate
// @Request() parameters without each file redeclaring the shape.
//
// The audit-context fields below are the express-level pieces the controller
// auditContext() helpers read from. They are optional because the same type
// is used in lightweight test doubles that only populate `user`.
export interface AuthedRequest {
  user: User;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
  // Attached by RequestIdMiddleware (observability/request-id.middleware.ts) on
  // every request, before any guard runs, so controllers can correlate audit
  // events with the request/error/Sentry trail. Optional because lightweight
  // test doubles populate only `user`.
  requestId?: string;
  // Set by CommunityFeatureFlagGuard for community endpoints.
  community_flag_state?: 'enabled' | 'disabled';
}

// Subset of AuthedRequest the auditContext() helpers actually need. Lets
// callers narrow to "req is express-shaped enough to extract IP + UA"
// without forcing them to assert the authenticated user too.
export type AuditableRequest = Pick<AuthedRequest, 'ip' | 'socket' | 'headers'>;
