// Jest bootstrap. AuthService's constructor calls `createClient(process.env.SUPABASE_URL, ...)`
// which throws synchronously if the URL is missing. Unit tests do not hit Supabase —
// they inject a mock via `(service as any).supabaseAdmin = mock` after construction —
// so providing any non-empty URL is sufficient to let construction succeed.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.USDA_API_KEY = process.env.USDA_API_KEY || 'test-usda-key';
