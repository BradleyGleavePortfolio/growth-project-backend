-- Down for 20270304000000_a4_broadcasts_cards_saved_replies. Drops only the
-- six tables this migration created (children first). No other table changes.
DROP TABLE IF EXISTS "coach_client_tags";
DROP TABLE IF EXISTS "coach_saved_replies";
DROP TABLE IF EXISTS "coach_message_cards";
DROP TABLE IF EXISTS "coach_broadcast_deliveries";
DROP TABLE IF EXISTS "coach_broadcast_runs";
DROP TABLE IF EXISTS "coach_broadcasts";
