-- Down for 20270502008200_copilot_be2 (COPILOT-BE2). The stored facts of past Copilot
-- replies are lost; the replies themselves stay.
ALTER TABLE "RomanMessage" DROP COLUMN IF EXISTS "copilot";
