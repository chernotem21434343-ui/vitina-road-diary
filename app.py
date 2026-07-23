import datetime as dt
import os
import secrets
import sqlite3
import time
from functools import wraps
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request, session

BASE_DIR = Path(__file__).resolve().parent


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("SECRET_KEY", secrets.token_hex(32)),
        ACCESS_PIN=os.environ.get("ACCESS_PIN", ""),
        DATABASE=os.environ.get("DATABASE", str(BASE_DIR / "vitina_road.db")),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        MAX_CONTENT_LENGTH=1_000_000,
    )
    if test_config:
        app.config.update(test_config)
    if not app.config["ACCESS_PIN"]:
        raise RuntimeError("ACCESS_PIN is required")

    login_attempts = {}

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"])
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    @app.teardown_appcontext
    def close_db(_error=None):
        connection = g.pop("db", None)
        if connection:
            connection.close()

    def init_db():
        connection = sqlite3.connect(app.config["DATABASE"])
        connection.executescript("""
            PRAGMA journal_mode=WAL;
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
            CREATE INDEX IF NOT EXISTS idx_thoughts_day_time ON thoughts(day_date, created_at);
        """)
        connection.close()

    init_db()

    def now_iso():
        return dt.datetime.now().astimezone().isoformat(timespec="seconds")

    def today_iso():
        return dt.date.today().isoformat()

    def require_auth(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            if not session.get("authenticated"):
                return jsonify(error="Требуется вход"), 401
            return handler(*args, **kwargs)
        return wrapped

    def valid_today(value):
        return value == today_iso()

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.post("/api/login")
    def login():
        ip = request.headers.get("CF-Connecting-IP") or request.remote_addr or "unknown"
        recent = [stamp for stamp in login_attempts.get(ip, []) if time.time() - stamp < 600]
        login_attempts[ip] = recent
        if len(recent) >= 8:
            return jsonify(error="Слишком много попыток. Повтори позже."), 429
        supplied = str((request.get_json(silent=True) or {}).get("pin", ""))
        if not secrets.compare_digest(supplied, str(app.config["ACCESS_PIN"])):
            recent.append(time.time())
            return jsonify(error="Неверный код доступа"), 401
        session.clear()
        session["authenticated"] = True
        return jsonify(ok=True)

    @app.post("/api/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    @app.get("/api/session")
    def session_status():
        return jsonify(authenticated=bool(session.get("authenticated")))

    @app.get("/api/today")
    @require_auth
    def today():
        date = today_iso()
        row = db().execute("SELECT * FROM days WHERE date=?", (date,)).fetchone()
        return jsonify(date=date, started=bool(row), day=dict(row) if row else None)

    @app.post("/api/days")
    @require_auth
    def create_day():
        payload = request.get_json(silent=True) or {}
        date = str(payload.get("date", ""))
        statement = str(payload.get("statement", "")).strip()
        if not valid_today(date):
            return jsonify(error="Запись можно создать только за сегодняшний день"), 400
        if not statement or len(statement) > 1000:
            return jsonify(error="Напиши фразу длиной от 1 до 1000 символов"), 400
        try:
            db().execute("INSERT INTO days(date,statement,created_at) VALUES(?,?,?)", (date, statement, now_iso()))
            db().commit()
        except sqlite3.IntegrityError:
            return jsonify(error="Сегодняшний день уже начат"), 409
        return jsonify(ok=True, date=date), 201

    @app.post("/api/thoughts")
    @require_auth
    def create_thought():
        payload = request.get_json(silent=True) or {}
        date = str(payload.get("date", ""))
        text = str(payload.get("text", "")).strip()
        if not valid_today(date):
            return jsonify(error="Мысли можно добавлять только в текущий день"), 400
        if not text or len(text) > 4000:
            return jsonify(error="Запись должна содержать от 1 до 4000 символов"), 400
        day = db().execute("SELECT date FROM days WHERE date=?", (date,)).fetchone()
        if not day:
            return jsonify(error="Сначала начни сегодняшний день"), 409
        cursor = db().execute("INSERT INTO thoughts(day_date,text,created_at) VALUES(?,?,?)", (date, text, now_iso()))
        db().commit()
        row = db().execute("SELECT id,text,created_at FROM thoughts WHERE id=?", (cursor.lastrowid,)).fetchone()
        return jsonify(dict(row)), 201

    def day_payload(date):
        row = db().execute("SELECT * FROM days WHERE date=?", (date,)).fetchone()
        if not row:
            return None
        thoughts = db().execute("SELECT id,text,created_at FROM thoughts WHERE day_date=? ORDER BY created_at,id", (date,)).fetchall()
        result = dict(row)
        result["thoughts"] = [dict(item) for item in thoughts]
        return result

    @app.get("/api/days/<date>")
    @require_auth
    def get_day(date):
        try:
            dt.date.fromisoformat(date)
        except ValueError:
            return jsonify(error="Некорректная дата"), 400
        result = day_payload(date)
        if not result:
            return jsonify(error="В этот день записей нет"), 404
        return jsonify(result)

    @app.get("/api/archive")
    @require_auth
    def archive():
        rows = db().execute("""
            SELECT d.date,d.statement,d.created_at,COUNT(t.id) AS thought_count,
                   MAX(t.created_at) AS last_activity
            FROM days d LEFT JOIN thoughts t ON t.day_date=d.date
            GROUP BY d.date ORDER BY d.date DESC
        """).fetchall()
        days = [dict(row) for row in rows]
        total_thoughts = sum(row["thought_count"] for row in days)
        existing = {dt.date.fromisoformat(row["date"]) for row in days}
        cursor = dt.date.today()
        streak = 0
        while cursor in existing:
            streak += 1
            cursor -= dt.timedelta(days=1)
        return jsonify(days=days, stats={"days": len(days), "thoughts": total_thoughts, "streak": streak})

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    return app


if __name__ == "__main__":
    application = create_app()
    application.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8787")))
