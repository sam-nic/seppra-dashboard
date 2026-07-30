const PLANFIX_BASE = "https://seppra.planfix.ru/rest";
const FIREBASE_API_KEY = "AIzaSyBD4R9Z3XYg9djAp3drsooW2SmK3g4o7yc";
const CACHE_TTL_SECONDS = 15;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const ALLOWED_ORIGINS = new Set([
  "https://sam-nic.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
]);

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://sam-nic.github.io";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

// Разрешены только методы чтения, которые реально использует дашборд.
// Так авторизованный пользователь не сможет через прокси вызвать произвольный
// изменяющий метод Planfix API.
function isAllowedPlanfixPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 500) {
    return false;
  }

  if (path.includes("..") || path.startsWith("/") || /^https?:\/\//i.test(path)) {
    return false;
  }

  return (
    path === "task/list" ||
    /^task\/\d+\?fields=[0-9A-Za-z_,.-]+$/.test(path) ||
    /^datatag\/\d+\/entry\/list$/.test(path)
  );
}

async function verifyFirebaseUser(idToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) return null;

  const payload = await response.json();
  const user = payload.users?.[0];
  if (!user || user.disabled) return null;

  return {
    uid: user.localId,
    email: String(user.email || "").toLowerCase()
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function buildCacheRequest(origin, path, body) {
  const hash = await sha256Hex(`${origin}\n${path}\n${stableStringify(body)}`);
  return new Request(`https://worker-cache.invalid/planfix/${hash}`, {
    method: "GET"
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPlanfix(path, body, token) {
  const options = {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json"
    }
  };

  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${PLANFIX_BASE}/${path}`, options);
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(attempt === 0 ? 400 : 900);
      continue;
    }

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 2) {
      return response;
    }

    // Эти маршруты только читают данные, поэтому повтор запроса безопасен.
    await response.arrayBuffer().catch(() => {});
    await sleep(attempt === 0 ? 400 : 900);
  }

  return response;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return jsonResponse({ error: "Origin not allowed" }, 403, origin);
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: "Origin not allowed" }, 403, origin);
    }

    if (!env.PLANFIX_TOKEN) {
      return jsonResponse({ error: "PLANFIX_TOKEN is not configured" }, 500, origin);
    }

    const authorization = request.headers.get("Authorization") || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return jsonResponse({ error: "Authentication required" }, 401, origin);
    }

    const user = await verifyFirebaseUser(match[1]);
    if (!user) {
      return jsonResponse({ error: "Invalid or expired Firebase session" }, 401, origin);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, origin);
    }

    const { path, body } = input || {};
    if (!isAllowedPlanfixPath(path)) {
      console.warn("Blocked Planfix path", { path, uid: user.uid, email: user.email });
      return jsonResponse({ error: "Planfix path is not allowed" }, 400, origin);
    }

    const cache = caches.default;
    const cacheRequest = await buildCacheRequest(origin, path, body);
    const cached = await cache.match(cacheRequest);
    if (cached) {
      return cached;
    }

    let planfixResponse;
    try {
      planfixResponse = await fetchPlanfix(path, body, env.PLANFIX_TOKEN);
    } catch (error) {
      console.error("Planfix network error", {
        path,
        uid: user.uid,
        message: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse({ error: "Planfix is temporarily unavailable" }, 502, origin);
    }

    const responseText = await planfixResponse.text();

    if (!planfixResponse.ok) {
      let message = `Planfix returned HTTP ${planfixResponse.status}`;
      try {
        const parsed = JSON.parse(responseText);
        message = parsed.error || parsed.message || message;
      } catch {
        // Planfix мог вернуть не-JSON ответ.
      }

      console.error("Planfix API error", {
        path,
        status: planfixResponse.status,
        uid: user.uid,
        message
      });

      return jsonResponse({ error: message }, planfixResponse.status, origin);
    }

    const response = new Response(responseText, {
      status: planfixResponse.status,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": planfixResponse.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": `private, max-age=${CACHE_TTL_SECONDS}`,
        "X-Worker-Cache": "MISS"
      }
    });

    const cacheCopy = new Response(responseText, {
      status: planfixResponse.status,
      headers: {
        ...corsHeaders(origin),
        "Content-Type": planfixResponse.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "X-Worker-Cache": "HIT"
      }
    });

    ctx.waitUntil(cache.put(cacheRequest, cacheCopy));
    return response;
  }
};
