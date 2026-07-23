const enc = new TextEncoder();
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function todayMoscow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function generatedPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const raw = [...bytes].map(b => alphabet[b % alphabet.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}
function cookieValue(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
async function requestBody(request) { try { return await request.json(); } catch { return {}; } }
function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `vitina_session=${token ? encodeURIComponent(token) : ""}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
async function currentUser(request, env) {
  const token = cookieValue(request, "vitina_session");
  if (!token) return null;
  return await env.DB.prepare(`
    SELECT u.id,u.name,u.created_at FROM user_sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?
  `).bind(await sha256(token), Math.floor(Date.now() / 1000)).first();
}
async function createSession(env, userId) {
  const token = randomHex(32), now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("DELETE FROM user_sessions WHERE expires_at<?").bind(now).run();
  await env.DB.prepare("INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha256(token), userId, now + SESSION_SECONDS).run();
  return token;
}
async function rateLimited(env, table, ip, windowSeconds, limit) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM ${table} WHERE attempted_at<?`).bind(now - windowSeconds).run();
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ip=? AND attempted_at>?`).bind(ip, now - windowSeconds).first();
  return Number(row?.count || 0) >= limit;
}
function validName(name) { return /^[\p{L}\p{N} _-]{2,32}$/u.test(name) && !/\s{2,}/.test(name); }
function dateAtMoscow(date) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }

async function archiveFor(env, userId, today) {
  const result = await env.DB.prepare(`
    SELECT d.date,d.statement,d.created_at,COUNT(t.id) AS thought_count,MAX(t.created_at) AS last_activity
    FROM user_days d LEFT JOIN user_thoughts t ON t.user_id=d.user_id AND t.day_date=d.date
    WHERE d.user_id=? GROUP BY d.date ORDER BY d.date DESC
  `).bind(userId).all();
  const days = result.results || [];
  const existing = new Set(days.map(d => d.date));
  let cursor = new Date(`${today}T12:00:00+03:00`), streak = 0;
  while (existing.has(dateAtMoscow(cursor))) { streak++; cursor = new Date(cursor.getTime() - 86400000); }
  return { days, stats: { days: days.length, thoughts: days.reduce((s, d) => s + Number(d.thought_count || 0), 0), streak } };
}

async function api(request, env, url) {
  const path = url.pathname, method = request.method;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if (path === "/api/register" && method === "POST") {
    if (await rateLimited(env, "registration_attempts", ip, 3600, 5)) return json({ error: "Слишком много регистраций. Попробуй позже." }, 429);
    const data = await requestBody(request), name = String(data.name || "").trim();
    if (!validName(name)) return json({ error: "Имя: от 2 до 32 букв, цифр, пробелов или дефисов" }, 400);
    const password = generatedPassword(), salt = randomHex(16), createdAt = new Date().toISOString();
    try {
      const result = await env.DB.prepare("INSERT INTO users(name,password_hash,password_salt,created_at) VALUES(?,?,?,?)")
        .bind(name, await sha256(`${salt}:${password}`), salt, createdAt).run();
      await env.DB.prepare("INSERT INTO registration_attempts(ip,attempted_at) VALUES(?,?)").bind(ip, Math.floor(Date.now() / 1000)).run();
      const userId = Number(result.meta.last_row_id), token = await createSession(env, userId);
      return json({ ok: true, user: { id: userId, name }, password }, 201, { "set-cookie": sessionCookie(token) });
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "Пользователь с таким именем уже существует" }, 409);
      throw error;
    }
  }

  if (path === "/api/login" && method === "POST") {
    if (await rateLimited(env, "login_attempts", ip, 600, 8)) return json({ error: "Слишком много попыток. Повтори позже." }, 429);
    const data = await requestBody(request), name = String(data.name || "").trim(), password = String(data.password || "").trim().toUpperCase();
    const user = await env.DB.prepare("SELECT id,name,password_hash,password_salt FROM users WHERE name=? COLLATE NOCASE").bind(name).first();
    const valid = user && (await sha256(`${user.password_salt}:${password}`)) === user.password_hash;
    if (!valid) {
      await env.DB.prepare("INSERT INTO login_attempts(ip,attempted_at) VALUES(?,?)").bind(ip, Math.floor(Date.now() / 1000)).run();
      return json({ error: "Неверное имя или пароль" }, 401);
    }
    const token = await createSession(env, user.id);
    return json({ ok: true, user: { id: user.id, name: user.name } }, 200, { "set-cookie": sessionCookie(token) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = cookieValue(request, "vitina_session");
    if (token) await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  const user = await currentUser(request, env);
  if (path === "/api/session") return json({ authenticated: Boolean(user), user: user || null });
  if (!user) return json({ error: "Требуется вход" }, 401);
  const today = todayMoscow();

  if (path === "/api/users" && method === "GET") {
    const result = await env.DB.prepare(`
      SELECT u.id,u.name,u.created_at,
        (SELECT COUNT(*) FROM user_days d WHERE d.user_id=u.id) AS days,
        (SELECT COUNT(*) FROM user_thoughts t WHERE t.user_id=u.id) AS thoughts
      FROM users u ORDER BY u.name COLLATE NOCASE
    `).all();
    return json({ users: result.results || [], current_user_id: user.id });
  }

  if (path === "/api/today" && method === "GET") {
    const day = await env.DB.prepare("SELECT date,statement,created_at FROM user_days WHERE user_id=? AND date=?").bind(user.id, today).first();
    return json({ date: today, started: Boolean(day), day: day || null, user });
  }

  if (path === "/api/days" && method === "POST") {
    const data = await requestBody(request), date = String(data.date || ""), statement = String(data.statement || "").trim();
    if (date !== today) return json({ error: "Запись можно создать только за сегодняшний день" }, 400);
    if (!statement || statement.length > 1000) return json({ error: "Напиши фразу длиной от 1 до 1000 символов" }, 400);
    try {
      await env.DB.prepare("INSERT INTO user_days(user_id,date,statement,created_at) VALUES(?,?,?,?)").bind(user.id, date, statement, new Date().toISOString()).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return json({ error: "Сегодняшний день уже отмечен" }, 409);
      throw error;
    }
    return json({ ok: true, date }, 201);
  }

  if (path === "/api/thoughts" && method === "POST") {
    const data = await requestBody(request), date = String(data.date || ""), text = String(data.text || "").trim();
    if (date !== today) return json({ error: "Мысли можно добавлять только в текущий день" }, 400);
    if (!text || text.length > 4000) return json({ error: "Запись должна содержать от 1 до 4000 символов" }, 400);
    const day = await env.DB.prepare("SELECT date FROM user_days WHERE user_id=? AND date=?").bind(user.id, date).first();
    if (!day) return json({ error: "Сначала отметь сегодняшний день" }, 409);
    const createdAt = new Date().toISOString();
    const result = await env.DB.prepare("INSERT INTO user_thoughts(user_id,day_date,text,created_at) VALUES(?,?,?,?)").bind(user.id, date, text, createdAt).run();
    return json({ id: result.meta.last_row_id, text, created_at: createdAt }, 201);
  }

  if (path === "/api/archive" && method === "GET") {
    const selectedId = Number(url.searchParams.get("user_id") || user.id);
    const selected = await env.DB.prepare("SELECT id,name,created_at FROM users WHERE id=?").bind(selectedId).first();
    if (!selected) return json({ error: "Пользователь не найден" }, 404);
    return json({ ...(await archiveFor(env, selectedId, today)), user: selected, is_owner: selectedId === Number(user.id) });
  }

  if (path.startsWith("/api/days/") && method === "GET") {
    const date = decodeURIComponent(path.slice(10)), selectedId = Number(url.searchParams.get("user_id") || user.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Некорректная дата" }, 400);
    const day = await env.DB.prepare("SELECT date,statement,created_at FROM user_days WHERE user_id=? AND date=?").bind(selectedId, date).first();
    if (!day) return json({ error: "В этот день записей нет" }, 404);
    const thoughts = await env.DB.prepare("SELECT id,text,created_at FROM user_thoughts WHERE user_id=? AND day_date=? ORDER BY created_at,id").bind(selectedId, date).all();
    const selected = await env.DB.prepare("SELECT id,name FROM users WHERE id=?").bind(selectedId).first();
    return json({ ...day, thoughts: thoughts.results || [], user: selected });
  }

  return json({ error: "Не найдено" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ status: "ok", storage: "cloudflare-d1", version: 2 });
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "Временная ошибка сервера" }, 500);
    }
  },
};
