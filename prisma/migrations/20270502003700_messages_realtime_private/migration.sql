-- MSGRT: coach-client message pings travel only on private per-person topics,
-- messages:user:<User.id> (SupabaseService.pingChat). Realtime authorization
-- reads the policies on realtime.messages: a signed-in person may receive on
-- their own topic and no other; there is no INSERT policy, so only the server
-- sends. Same shape as 20270502003300 (community). Order: after 0003400 (main),
-- 0003500 and 0003600 (open PRs); it depends on none of them. Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- True when the topic is the caller's own; DEFINER: reads "User" without its policies.
CREATE FUNCTION app.messages_realtime_topic_is_own(p_topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public."User" u
                 WHERE u."supabase_id" = auth.uid()::text AND u."deleted_at" IS NULL
                   AND p_topic = 'messages:user:' || u."id")
$fn$;
ALTER FUNCTION app.messages_realtime_topic_is_own(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.messages_realtime_topic_is_own(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.messages_realtime_topic_is_own(text) FROM anon;
GRANT EXECUTE ON FUNCTION app.messages_realtime_topic_is_own(text) TO authenticated, service_role;

CREATE POLICY "messages_realtime_own_topic_receive" ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.messages."extension" = 'broadcast' AND (SELECT app.messages_realtime_topic_is_own(realtime.topic())));

COMMIT;
