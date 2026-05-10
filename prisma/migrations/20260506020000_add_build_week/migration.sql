-- Phase 4: Build Week — 7-day guided coaching arc.
--
-- Three additive tables:
--   BuildWeekDay              — global catalog (rows 1..7), seeded inline.
--   BuildWeekEnrollment       — one row per user (unique on user_id).
--   BuildWeekDayCompletion    — one row per (enrollment, day_number).
--
-- Idempotent — every CREATE / INSERT uses IF NOT EXISTS or ON CONFLICT.
-- Re-running the migration after a partial apply leaves the schema and the
-- seed in their final state.

-- 1. BuildWeekDay -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS "BuildWeekDay" (
  "id"                TEXT NOT NULL,
  "day_number"        INTEGER NOT NULL,
  "title"             TEXT NOT NULL,
  "focus_area"        TEXT NOT NULL,
  "narrative"         TEXT NOT NULL,
  "prompt_questions"  JSONB NOT NULL,
  "action_items"      JSONB NOT NULL,
  "expected_artifact" TEXT NOT NULL,
  CONSTRAINT "BuildWeekDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BuildWeekDay_day_number_key"
  ON "BuildWeekDay"("day_number");

CREATE INDEX IF NOT EXISTS "BuildWeekDay_day_number_idx"
  ON "BuildWeekDay"("day_number");

-- 2. BuildWeekEnrollment ----------------------------------------------------
CREATE TABLE IF NOT EXISTS "BuildWeekEnrollment" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "started_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "current_day"  INTEGER NOT NULL DEFAULT 1,
  "status"       TEXT NOT NULL DEFAULT 'active',
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "BuildWeekEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BuildWeekEnrollment_user_id_key"
  ON "BuildWeekEnrollment"("user_id");

CREATE INDEX IF NOT EXISTS "BuildWeekEnrollment_status_idx"
  ON "BuildWeekEnrollment"("status");

-- 3. BuildWeekDayCompletion -------------------------------------------------
CREATE TABLE IF NOT EXISTS "BuildWeekDayCompletion" (
  "id"            TEXT NOT NULL,
  "enrollment_id" TEXT NOT NULL,
  "day_number"    INTEGER NOT NULL,
  "completed_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responses"     JSONB NOT NULL,
  "artifact_text" TEXT,
  CONSTRAINT "BuildWeekDayCompletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BuildWeekDayCompletion_enrollment_day_key"
  ON "BuildWeekDayCompletion"("enrollment_id", "day_number");

CREATE INDEX IF NOT EXISTS "BuildWeekDayCompletion_day_number_idx"
  ON "BuildWeekDayCompletion"("day_number");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BuildWeekDayCompletion_enrollment_id_fkey'
  ) THEN
    ALTER TABLE "BuildWeekDayCompletion"
      ADD CONSTRAINT "BuildWeekDayCompletion_enrollment_id_fkey"
      FOREIGN KEY ("enrollment_id") REFERENCES "BuildWeekEnrollment"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Seed the catalog --------------------------------------------------------
-- 7 verbatim rows from prisma/seed-build-week.json. ON CONFLICT (day_number)
-- DO NOTHING keeps the migration idempotent across deploys; once the row
-- exists, copy edits ship via a fresh migration, never an UPDATE here.
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 1, 'Audit', 'Diagnostic + Baseline', 'Day 1 is an audit. Before strategy, before action, you take an honest inventory of where you are right now across body, income, and environment. The 40-point diagnostic, the starting body weight, and the income baseline together form the snapshot you will measure every future week against.', '["What does success look like in 90 days?", "What is your current monthly income, and how many hours per week are you free to work on this?", "What is your starting body weight today?"]'::jsonb, '[{"title": "Complete the 40-point diagnostic", "description": "Work through the diagnostic form end-to-end. Honest answers only \u2014 this becomes the baseline every later week is measured against.", "time_estimate_min": 25}, {"title": "Log starting body weight", "description": "Record your starting weight today. A photo is optional but recommended \u2014 you will compare against it on Day 7 and at the 30/60/90-day marks.", "time_estimate_min": 5}, {"title": "Income baseline", "description": "Capture current monthly income and the hours per week you can realistically commit. This sets the expansion target for Day 3.", "time_estimate_min": 10}, {"title": "Define 90-day success", "description": "Write at least 100 words on what success looks like in 90 days. Specifics beat abstractions \u2014 name a number, a body, a place.", "time_estimate_min": 15}]'::jsonb, 'Diagnostic + baseline snapshot: weight, income, hours, and a 100-word success statement.') ON CONFLICT (day_number) DO NOTHING;
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 2, 'Strategy', '90-Day Arc + Calendar Cuts', 'Day 2 turns the audit into a plan. You review the AI-generated 90-day arc, confirm the primary income lever you will lean into, and decide what gets cut from your calendar to make the next 90 days possible. Strategy without subtraction is wishful thinking.', '["Which income lever fits your skills and bandwidth: freelance, paid offer, remote job, content, or other?", "What gets cut from your calendar this week to make room for the work?", "Where in the AI-generated 90-day arc do you have the most doubt \u2014 and why?"]'::jsonb, '[{"title": "Review your AI-generated 90-day arc", "description": "Read through the arc end-to-end. Mark anything that does not fit your reality before Day 3.", "time_estimate_min": 20}, {"title": "Confirm primary income lever", "description": "Pick exactly one of: freelance, paid offer, remote job, content, other. Day 3 builds on this choice.", "time_estimate_min": 10}, {"title": "Cut from calendar", "description": "List at least one recurring commitment you are removing this week to free time for the build. Be specific.", "time_estimate_min": 15}]'::jsonb, 'Confirmed income lever and a written list of calendar cuts for the week.') ON CONFLICT (day_number) DO NOTHING;
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 3, 'Income Setup', 'Offer + Outreach', 'Day 3 is execution day on the income side. You define the offer in concrete terms — name, price, deliverable, target client — and you do something most people never do: you actually send the first five outreach messages. The day ends with a tracker so the next 90 days are measurable.', '["What is the name, price, deliverable, and target client of your offer?", "What does your LinkedIn headline say in the language of your offer?", "Who are the first five people you are reaching out to, and why each of them?"]'::jsonb, '[{"title": "Define your offer", "description": "Write down: offer name, price, the deliverable, and the exact target client. One sentence per field.", "time_estimate_min": 25}, {"title": "Build LinkedIn headline using offer language", "description": "Rewrite your LinkedIn headline so a target client recognises themselves in it within five seconds.", "time_estimate_min": 15}, {"title": "Send first 5 outreach messages", "description": "Send five outreach messages today. Capture screenshots as evidence \u2014 Day 6 reviews the responses.", "time_estimate_min": 30}, {"title": "Set up outreach tracker", "description": "Open the outreach tracker template, copy it to your own drive, and log the five sends with date, channel, and status.", "time_estimate_min": 10}]'::jsonb, 'Offer brief, updated LinkedIn headline, five outreach sends, and a populated tracker link.') ON CONFLICT (day_number) DO NOTHING;
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 4, 'Body Protocol', 'Macros + Training + Sleep', 'Day 4 protects the body that has to carry the work. Macros, training schedule, and sleep are not vanity — they are the floor under everything else. Set the protocol now so you are not negotiating with yourself in week three.', '["What are your weight, goal, and activity level \u2014 and the macro split they imply?", "How many days a week will you train, and which type each day?", "What is your average bedtime, wake time, and a self-rated sleep quality from 1 to 10?"]'::jsonb, '[{"title": "Confirm macro targets", "description": "Run the macro calculator with your weight, goal, and activity level. Lock the protein, carb, and fat targets for the week.", "time_estimate_min": 15}, {"title": "Log training schedule", "description": "Commit the days per week and the training type each day (resistance, conditioning, mobility). Put it in your calendar.", "time_estimate_min": 10}, {"title": "Sleep audit", "description": "Record average bedtime, wake time, and a 1\u201310 sleep quality score. Identify one habit to change this week.", "time_estimate_min": 10}, {"title": "Confirm Week 1 body target", "description": "Write down the one specific body outcome you are tracking this week (a weight delta, a session count, a sleep average).", "time_estimate_min": 5}]'::jsonb, 'Macro targets, training schedule, sleep audit, and a Week 1 body target.') ON CONFLICT (day_number) DO NOTHING;
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 5, 'Environment', 'Calendar + Surroundings', 'Day 5 redesigns the environment so the protocol survives contact with real life. Training, deep work, and outreach become recurring calendar slots. One environmental change happens this week — and the relocation question stays open as a longer arc for those choosing it.', '["Which time blocks will hold training, deep work, and outreach as recurring slots this week?", "What is the single environment change you will make this week?", "If you are considering relocation, which target country is on the shortlist?"]'::jsonb, '[{"title": "Calendar redesign", "description": "Block training, deep work, and outreach as recurring slots in your calendar for the next 7 days. Confirm with a checkbox once the events exist.", "time_estimate_min": 20}, {"title": "Identify one environment change", "description": "Pick one environmental change to make this week \u2014 workspace setup, a kitchen reset, a phone-distance habit. Write it down.", "time_estimate_min": 10}, {"title": "Optional: target relocation country", "description": "If relocation is part of your arc, select a target country from the supported list. Optional.", "time_estimate_min": 5}]'::jsonb, 'A redesigned weekly calendar, a documented environment change, and an optional relocation target.') ON CONFLICT (day_number) DO NOTHING;
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 6, 'Integration', 'Operating Rhythm + Tooling', 'Day 6 ties the three pillars together. You schedule the coaching call, you write the operating rhythm doc that captures how your week actually runs, and you confirm the tools that will track your progress. Integration is what makes the next 83 days repeatable.', '["When is your scheduled coaching call this cycle?", "What is your operating rhythm \u2014 the times of day each pillar gets attention?", "Which tracking tools are confirmed: weight app, income spreadsheet, calendar?"]'::jsonb, '[{"title": "Coaching call schedule confirmed", "description": "Pick a date and time for your coaching call this cycle and put it in the calendar. Confirm with a coach response.", "time_estimate_min": 10}, {"title": "Complete operating rhythm doc", "description": "Write or upload your operating rhythm doc \u2014 how each day flows across body, income, and environment.", "time_estimate_min": 30}, {"title": "Link tracking tools", "description": "Confirm the three trackers are live: weight app, income spreadsheet, calendar. Tick each off only once it is genuinely set up.", "time_estimate_min": 15}]'::jsonb, 'Scheduled coaching call, an operating rhythm doc, and three confirmed tracking tools.') ON CONFLICT (day_number) DO NOTHING;
INSERT INTO "BuildWeekDay" (id, day_number, title, focus_area, narrative, prompt_questions, action_items, expected_artifact) VALUES (gen_random_uuid(), 7, 'Lock-In', 'Self-Assessment + Certificate', 'Day 7 is the lock-in. You self-assess each of the three pillars — income setup, body protocol, environment — and you record a 60-second video describing what you actually built this week. The completion certificate is generated when the assessment, the video, and the coach sign-off all line up. This is the moment Build Week becomes a baseline you can come back to.', '["Income setup \u2014 done or not done? In one sentence, what is the evidence?", "Body protocol \u2014 done or not done? In one sentence, what is the evidence?", "Environment \u2014 done or not done? In one sentence, what is the evidence?"]'::jsonb, '[{"title": "Self-assess all 3 pillars", "description": "Mark income setup, body protocol, and environment as done or not done. Write one sentence of evidence for each.", "time_estimate_min": 15}, {"title": "Record a 60-second \"Here''s what I built\" video", "description": "Record a 60-second video describing what you built this week. Upload it. This is the artifact future-you will rewatch.", "time_estimate_min": 20}, {"title": "Generate completion certificate", "description": "Once self-assessment and video are submitted and the coach has signed off, generate the completion certificate.", "time_estimate_min": 5}]'::jsonb, 'Three-pillar self-assessment, a 60-second build video, and the generated completion certificate.') ON CONFLICT (day_number) DO NOTHING;
