CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thoughts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_date TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thoughts_day_time ON thoughts(day_date, created_at, id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);
