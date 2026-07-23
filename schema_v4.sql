ALTER TABLE user_days ADD COLUMN relapsed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_days ADD COLUMN relapse_at TEXT;
CREATE INDEX IF NOT EXISTS idx_user_days_relapsed ON user_days(user_id, relapsed, date);
