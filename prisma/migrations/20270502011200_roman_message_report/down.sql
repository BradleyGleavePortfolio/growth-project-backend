-- Reverse of 20270502011200_roman_message_report: drops the report table (its indexes, constraints and
-- policy go with it). Reports filed since are lost; nothing else changes.
BEGIN;
DROP TABLE IF EXISTS "RomanMessageReport";
COMMIT;
