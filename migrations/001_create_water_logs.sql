-- RUN THIS IN SUPABASE SQL EDITOR
-- Migration: Create water_logs table for water intake tracking

CREATE TABLE IF NOT EXISTS water_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  amount_ml  INTEGER NOT NULL,
  logged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_water_logs_user_id ON water_logs(user_id);
CREATE INDEX idx_water_logs_user_logged_at ON water_logs(user_id, logged_at);
