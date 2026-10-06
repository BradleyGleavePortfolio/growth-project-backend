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

// 'sub_coach' mirrors the Prisma Role enum value. It is matched only when a
// route lists it explicitly (no hierarchy inheritance), so adding it here does
// not widen any existing route.
export type AppRole = 'owner' | 'coach' | 'student' | 'sub_coach';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
