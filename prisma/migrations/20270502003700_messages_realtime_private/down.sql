-- Rollback of 20270502003700: the policy, then its helper. Private message pings then reach nobody.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP POLICY "messages_realtime_own_topic_receive" ON realtime.messages;
DROP FUNCTION app.messages_realtime_topic_is_own(text);

COMMIT;
