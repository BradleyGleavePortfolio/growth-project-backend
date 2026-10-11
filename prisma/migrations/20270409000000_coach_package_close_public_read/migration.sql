-- CoachPackage: no direct reads with the public (anon) or signed-in
-- (authenticated) app keys. "coach_package_client_select" (SELECT USING (true),
-- 20260606000003) let them read every package row, share tokens and Stripe ids
-- included; permissive policies are OR'ed, so the later deny-all
-- "CoachPackage_server_only" never closed it. Nothing reads CoachPackage through
-- the Supabase API: the backend reads it through Prisma, which bypasses RLS, and
-- the mobile app and public pages go through the backend. RLS stays on and
-- forced. Reverse: down.sql.

SET lock_timeout = '5s';

ALTER TABLE "CoachPackage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachPackage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "coach_package_client_select" ON "CoachPackage";

RESET lock_timeout;
