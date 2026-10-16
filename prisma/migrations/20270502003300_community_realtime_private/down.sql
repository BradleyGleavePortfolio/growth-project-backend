-- Rollback of 20270502003300: the policy, then its helper. Private pings then reach nobody.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY "community_realtime_own_topic_receive" ON realtime.messages;
DROP FUNCTION app.community_realtime_topic_is_own(text);

COMMIT;
