-- Disposable/pre-use only. Refuse to erase even one issued setup identity.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE "ImportIntent", "ExtensionPairCode" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "ImportIntent") THEN
    RAISE EXCEPTION 'Issued import intents exist; retain schema and use compatible forward repair';
  END IF;
END $$;
ALTER TABLE "ExtensionPairCode" DROP COLUMN "import_intent_id";
DROP TABLE "ImportIntent";
COMMIT;
