const encoder = new TextEncoder();
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function todayMoscow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function authenticated(request, env) {
  const token = cookieValue(request, "vitina_session");
  if (!token) return false;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?"
  ).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  return Boolean(row);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM login_attempts WHERE attempted_at<?").bind(now - 600).run();
    const attempts = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM login_attempts WHERE ip=? AND attempted_at>?"
    ).bind(ip, now - 600).first();
    if (Number(attempts?.count || 0) >= 8) return json({ error: "Слишком много попыток. Повтори позже." }, 429);
    const data = await body(request);
    const supplied = String(data.pin || "");
    if ((await sha256(supplied)) !== (await sha256(env.ACCESS_PIN || ""))) {
      await env.DB.prepare("INSERT INTO login_attempts(ip,attempted_at) VALUES(?,?)").bind(ip, now).run();
      return json({ error: "Неверный код доступа" }, 401);
    }
    const token = randomToken();
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now).run();
    await env.DB.prepare("INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)")
      .bind(await sha256(token), now + SESSION_SECONDS).run();
    return json({ ok: true }, 200, {
      "set-cookie": `vitina_session=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = cookieValue(request, "vitina_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, {
      "set-cookie": "vitina_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    });
  }

  const isAuth = await authenticated(request, env);
  if (path === "/api/session") return json({ authenticated: isAuth });
  if (!isAuth) return json({ error: "Требуется вход" }, 401);

  const today = todayMoscow();

  if (path === "/api/today" && method === "GET") {
    const day = await env.DB.prepare("SELECT date,statement,created_at FROM days WHERE date=?").bind(today).first();
    return json({ date: today, started: Boolean(day), day: day || null });
  }

  if (path === "/api/days" && method === "POST") {
    const data = await body(request);
    const date = String(data.date || "");
    const statement = String(data.statement || "").trim();
    if (date !== today) return json({ error: "Запись можно создать только за сегодняшний день" }, 400);
    if (!statement || statement.length > 1000) return json({ error: "Напиши фразу длиной от 1 до 1000 символов" }, 400);
    try {
      await env.DB.prepare("INSERT INTO days(date,statement,created_at) VALUES(?,?,?)")
        .bind(date, statement, new Date().toISOString()).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "Сегодняшний день уже начат" }, 409);
      throw error;
    }
    return json({ ok: true, date }, 201);
  }

  if (path === "/api/thoughts" && method === "POST") {
    const data = await body(request);
    const date = String(data.date || "");
    const text = String(data.text || "").trim();
    if (date !== today) return json({ error: "Мысли можно добавлять только в текущий день" }, 400);
    if (!text || text.length > 4000) return json({ error: "Запись должна содержать от 1 до 4000 символов" }, 400);
    const day = await env.DB.prepare("SELECT date FROM days WHERE date=?").bind(date).first();
    if (!day) return json({ error: "Сначала начни сегодняшний день" }, 409);
    const createdAt = new Date().toISOString();
    const result = await env.DB.prepare("INSERT INTO thoughts(day_date,text,created_at) VALUES(?,?,?)")
      .bind(date, text, createdAt).run();
    return json({ id: result.meta.last_row_id, text, created_at: createdAt }, 201);
  }

  if (path === "/api/archive" && method === "GET") {
    const result = await env.DB.prepare(`
      SELECT d.date,d.statement,d.created_at,COUNT(t.id) AS thought_count,
             MAX(t.created_at) AS last_activity
      FROM days d LEFT JOIN thoughts t ON t.day_date=d.date
      GROUP BY d.date ORDER BY d.date DESC
    `).all();
    const days = result.results || [];
    const thoughts = days.reduce((sum, row) => sum + Number(row.thought_count || 0), 0);
    const existing = new Set(days.map(row => row.date));
    let cursor = new Date(`${today}T12:00:00+03:00`), streak = 0;
    const dateAt = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    while (existing.has(dateAt(cursor))) { streak++; cursor = new Date(cursor.getTime() - 86400000); }
    return json({ days, stats: { days: days.length, thoughts, streak } });
  }

  if (path.startsWith("/api/days/") && method === "GET") {
    const date = decodeURIComponent(path.slice("/api/days/".length));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Некорректная дата" }, 400);
    const day = await env.DB.prepare("SELECT date,statement,created_at FROM days WHERE date=?").bind(date).first();
    if (!day) return json({ error: "В этот день записей нет" }, 404);
    const thoughts = await env.DB.prepare(
      "SELECT id,text,created_at FROM thoughts WHERE day_date=? ORDER BY created_at,id"
    ).bind(date).all();
    return json({ ...day, thoughts: thoughts.results || [] });
  }

  return json({ error: "Не найдено" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ status: "ok", storage: "cloudflare-d1" });
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "Временная ошибка сервера" }, 500);
    }
  },
};
