import type { User } from '@prisma/client';

// Shape of a request that has passed JwtAuthGuard — the guard attaches the
// Prisma User record as req.user. Typed here so controllers can annotate
// @Request() parameters without each file redeclaring the shape.
export interface AuthedRequest {
  user: User;
}
