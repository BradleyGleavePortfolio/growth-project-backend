-- ROMANCOUNT (agent 145): each client's Roman use per local day (100 messages,
-- 3 files, 5 changes). Additive. Written only by the backend in one atomic
-- statement (src/roman/roman-usage.ts); a client reads only their own rows.

SET lock_timeout = '5s';

CREATE TABLE "roman_usage_daily" (
    "client_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "files" INTEGER NOT NULL DEFAULT 0,
    "changes" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roman_usage_daily_pkey" PRIMARY KEY ("client_id", "day"),
    CONSTRAINT "roman_usage_daily_counts_check" CHECK ("messages" >= 0 AND "files" >= 0 AND "changes" >= 0)
);

ALTER TABLE "roman_usage_daily" ADD CONSTRAINT "roman_usage_daily_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "roman_usage_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roman_usage_daily" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "roman_usage_daily" FROM anon, authenticated;
GRANT SELECT ON TABLE "roman_usage_daily" TO authenticated;

CREATE POLICY "p_roman_usage_daily_service_role_all" ON "roman_usage_daily"
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "p_roman_usage_daily_client_select_own" ON "roman_usage_daily"
    AS PERMISSIVE FOR SELECT TO authenticated USING ("client_id" = app.current_user_id());

CREATE POLICY "p_roman_usage_daily_anon_deny" ON "roman_usage_daily"
    AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
