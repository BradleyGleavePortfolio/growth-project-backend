-- COPILOT-BE2: a Path Copilot reply keeps its cited facts and its suggestion id on the reply row.
-- Nullable, no default: every existing row and every other turn stays null. RomanMessage's row
-- security (owner-only select, service-role writes) is unchanged and covers the new column.
ALTER TABLE "RomanMessage" ADD COLUMN "copilot" JSONB;
