CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_days (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_user_days_date ON user_days(date);

CREATE TABLE IF NOT EXISTS user_thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_date TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id, day_date) REFERENCES user_days(user_id, date) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_thoughts_day_time ON user_thoughts(user_id, day_date, created_at, id);

CREATE TABLE IF NOT EXISTS registration_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registration_attempts_ip_time ON registration_attempts(ip, attempted_at);
