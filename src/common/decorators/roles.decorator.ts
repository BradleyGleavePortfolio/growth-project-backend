import { SetMetadata } from '@nestjs/common';

// Phase 1B: declarative role gate. Use alongside JwtAuthGuard + RolesGuard:
//
//   @Roles('owner')
//   @UseGuards(JwtAuthGuard, RolesGuard)
//   @Get('admin/coaches')
//   listCoaches() { ... }
//
// Roles are OR-combined. OWNER bypass is built into RolesGuard, so a route
// declaring `@Roles('coach')` is automatically reachable by OWNER as well
// (Healthie-style hierarchy: OWNER > COACH > STUDENT).
export const ROLES_KEY = 'roles';

export type AppRole = 'owner' | 'coach' | 'student';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
