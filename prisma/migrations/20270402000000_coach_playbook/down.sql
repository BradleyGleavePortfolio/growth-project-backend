-- Reverse of 20270402000000_coach_playbook. Drops only what the migration
-- creates (policies and indexes go with their tables).
DROP TABLE IF EXISTS "CoachPlaybookSource";
DROP TABLE IF EXISTS "CoachPlaybook";
