ALTER TABLE users ADD COLUMN password_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_password_fingerprint ON users(password_fingerprint) WHERE password_fingerprint IS NOT NULL;
