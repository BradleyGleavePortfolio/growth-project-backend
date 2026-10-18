-- C10RT: community realtime pings travel only on private per-person topics,
-- community:user:<User.id>. Realtime authorization reads the policies on
-- realtime.messages: a signed-in person may receive on their own topic and no
-- other; there is no INSERT policy, so only the server sends. Reverse: down.sql.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- True when the topic is the caller's own; DEFINER: reads "User" without its policies.
CREATE FUNCTION app.community_realtime_topic_is_own(p_topic text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public."User" u
                 WHERE u."supabase_id" = auth.uid()::text AND u."deleted_at" IS NULL
                   AND p_topic = 'community:user:' || u."id")
$fn$;
ALTER FUNCTION app.community_realtime_topic_is_own(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app.community_realtime_topic_is_own(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.community_realtime_topic_is_own(text) FROM anon;
GRANT EXECUTE ON FUNCTION app.community_realtime_topic_is_own(text) TO authenticated, service_role;

CREATE POLICY "community_realtime_own_topic_receive" ON realtime.messages
  FOR SELECT TO authenticated
  USING (realtime.messages."extension" = 'broadcast' AND (SELECT app.community_realtime_topic_is_own(realtime.topic())));

COMMIT;
