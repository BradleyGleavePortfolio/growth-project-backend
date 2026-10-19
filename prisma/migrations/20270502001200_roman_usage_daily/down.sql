-- Reverse of 20270502001200_roman_usage_daily. Drops the table (with its FK,
-- CHECK and policies). Loses today's Roman counts, so every client's daily
-- counts start again from 0; nothing else is touched.
DROP TABLE IF EXISTS "roman_usage_daily";
