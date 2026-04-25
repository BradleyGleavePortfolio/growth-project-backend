import { SetMetadata } from '@nestjs/common';

// SECURITY: mark an endpoint as intentionally unauthenticated. The global
// JwtAuthGuard checks for this metadata and skips token validation when
// present. Use sparingly — only for endpoints that must not require a JWT
// (e.g. /health, /api/auth/login, /api/auth/register).
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
