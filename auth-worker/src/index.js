// dashboard-seppra: вход через Planfix OAuth (seppra) + белый список + выдача данных дашборда.
// Секреты (wrangler secret): OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, SESSION_SECRET, ADMIN_KEY.

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uJson = (o) => b64u(enc.encode(JSON.stringify(o)));
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function sign(env, payload) {
  const body = b64uJson(payload);
  return body + "." + (await hmac(env.SESSION_SECRET, body));
}
async function verify(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!safeEq(sig, await hmac(env.SESSION_SECRET, body))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}

const origin = (req) => new URL(req.url).origin;
const pagesBase = (env) => env.PAGES_ORIGIN + env.PAGES_PATH;
const cors = (env) => ({
  "Access-Control-Allow-Origin": env.PAGES_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Vary": "Origin",
});
const json = (env, obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(env) } });
const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? m[1] : null;
}

async function requireUser(req, env) {
  const h = req.headers.get("Authorization") || "";
  const s = await verify(env, h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!s) return null;
  // белый список проверяем при каждом запросе: отзыв доступа действует сразу
  return env.ALLOWED_USERS.split(",").map((x) => x.trim()).includes(s.id) ? s : null;
}

async function handleLogin(req, env) {
  const url = new URL(req.url);
  const ret = url.searchParams.get("return") || pagesBase(env);
  if (!ret.startsWith(pagesBase(env))) return text("Недопустимый адрес возврата", 400);
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64u(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  const state = b64u(crypto.getRandomValues(new Uint8Array(24)));
  const cookie = await sign(env, { state, verifier, ret, exp: Math.floor(Date.now() / 1000) + 600 });
  const auth = new URL(`https://${env.PLANFIX_ACCOUNT}.planfix.ru/api/v2/oauth/authorize`);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: origin(req) + "/callback",
    scope: "openid email userinfo",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: auth.toString(), "Set-Cookie": `pf_oauth=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`, "Cache-Control": "no-store" },
  });
}

async function handleCallback(req, env) {
  const url = new URL(req.url);
  const flow = await verify(env, getCookie(req, "pf_oauth"));
  if (!flow || url.searchParams.get("state") !== flow.state) return text("Сессия входа устарела. Вернитесь на дашборд и нажмите «Войти» ещё раз.", 400);
  const code = url.searchParams.get("code");
  if (!code) return text("Planfix не вернул код входа: " + (url.searchParams.get("error") || "неизвестная ошибка"), 400);

  const tokenRes = await fetch(`https://${env.PLANFIX_ACCOUNT}.planfix.ru/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: origin(req) + "/callback",
      client_id: env.OAUTH_CLIENT_ID,
      client_secret: env.OAUTH_CLIENT_SECRET,
      code_verifier: flow.verifier,
    }),
  });
  if (!tokenRes.ok) return text("Не удалось обменять код на токен (" + tokenRes.status + ").", 502);
  const tok = await tokenRes.json();

  const uiRes = await fetch(`https://${env.PLANFIX_ACCOUNT}.planfix.ru/api/v2/oauth/userinfo`, { headers: { Authorization: "Bearer " + tok.access_token } });
  if (!uiRes.ok) return text("Не удалось получить профиль (" + uiRes.status + ").", 502);
  const ui = await uiRes.json();

  const allowed = env.ALLOWED_USERS.split(",").map((x) => x.trim());
  if (ui.type && ui.type !== "user" && ui.type !== "employee") return text("Доступ только для сотрудников.", 403);
  if (!allowed.includes(String(ui.id))) {
    return text(`<meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>Нет доступа</h2><p>Дашборд открыт только для трёх сотрудников. Вы вошли как ${String(ui.name || ui.email || "").replace(/[<>&]/g, "")}.</p>`, 403);
  }
  const session = await sign(env, { id: String(ui.id), name: ui.name || "", exp: Math.floor(Date.now() / 1000) + Number(env.SESSION_HOURS) * 3600 });
  // токен уходит во фрагмент (#), он не попадает в логи сервера и Referer
  return new Response(null, {
    status: 302,
    headers: { Location: flow.ret.split("#")[0] + "#pf_token=" + session, "Set-Cookie": "pf_oauth=; Path=/; Max-Age=0; HttpOnly; Secure", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (url.pathname === "/login") return handleLogin(req, env);
    if (url.pathname === "/callback") return handleCallback(req, env);

    if (url.pathname === "/me") {
      const u = await requireUser(req, env);
      return u ? json(env, { id: u.id, name: u.name }) : json(env, { error: "unauthorized" }, 401);
    }

    if (url.pathname.startsWith("/data/") && req.method === "GET") {
      const u = await requireUser(req, env);
      if (!u) return json(env, { error: "unauthorized" }, 401);
      const key = url.pathname.slice(6);
      if (!/^[a-z0-9_-]+\.json$/i.test(key)) return json(env, { error: "bad key" }, 400);
      const val = await env.DATA.get(key);
      if (val === null) return json(env, { error: "not found" }, 404);
      return new Response(val, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors(env) } });
    }

    // загрузка данных из GitHub Actions: PUT /admin/<файл>.json с X-Admin-Key
    if (url.pathname.startsWith("/admin/") && req.method === "PUT") {
      const k = req.headers.get("X-Admin-Key") || "";
      if (!env.ADMIN_KEY || !safeEq(k, env.ADMIN_KEY)) return json(env, { error: "forbidden" }, 403);
      const key = url.pathname.slice(7);
      if (!/^[a-z0-9_-]+\.json$/i.test(key)) return json(env, { error: "bad key" }, 400);
      const body = await req.text();
      try { JSON.parse(body); } catch { return json(env, { error: "invalid json" }, 400); }
      await env.DATA.put(key, body);
      return json(env, { ok: true, bytes: body.length });
    }

    return json(env, { service: "dashboard-seppra" });
  },
};
