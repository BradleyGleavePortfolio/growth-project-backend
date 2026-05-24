// Jest bootstrap. AuthService's constructor calls `createClient(process.env.SUPABASE_URL, ...)`
// which throws synchronously if the URL is missing. Unit tests do not hit Supabase —
// they inject a mock via `(service as any).supabaseAdmin = mock` after construction —
// so providing any non-empty URL is sufficient to let construction succeed.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.USDA_API_KEY = process.env.USDA_API_KEY || 'test-usda-key';

// RECENT_AUTH_SECRET / RECENT_AUTH_TTL_MS — at-least-32-char default + safe TTL
// so tests that construct AuthService / RecentAuthGuard via real DI do not trip
// the boot-time length check. Tests that exercise misconfiguration paths set
// these to null/short values explicitly.
process.env.RECENT_AUTH_SECRET =
  process.env.RECENT_AUTH_SECRET || 'test-recent-auth-secret-at-least-32-chars-long';
process.env.RECENT_AUTH_TTL_MS = process.env.RECENT_AUTH_TTL_MS || '300000';

// Node 20 ships no native WebSocket constructor, but @supabase/realtime-js
// (transitively imported by @supabase/supabase-js) calls `WebSocket` at
// construction. Production code installs an explicit `realtime.transport: ws`
// option on every `createClient` call, but a polyfill is the simplest fix for
// the test environment so we are not coupled to every callsite.
// See: https://github.com/supabase/supabase-js/issues/802
if (typeof (globalThis as any).WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ws = require('ws');
  (globalThis as any).WebSocket = ws.WebSocket ?? ws;
}
