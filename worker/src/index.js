const PLANFIX_BASE = 'https://seppra.planfix.ru/rest';
const FIREBASE_API_KEY = 'AIzaSyBD4R9Z3XYg9djAp3drsooW2SmK3g4o7yc';
const ALLOWED_ORIGINS = new Set([
  'https://sam-nic.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
]);

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://sam-nic.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function isAllowedPlanfixPath(path) {
  if (typeof path !== 'string' || path.length > 500) return false;

  // Для отчёта разрешены только чтение задач и список задач.
  return path === 'task/list' || /^task\/\d+\?fields=[0-9A-Za-z_,.-]+$/.test(path);
}

async function verifyFirebaseUser(idToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) return null;
  const payload = await response.json();
  const user = payload.users?.[0];
  if (!user || user.disabled) return null;

  const email = String(user.email || '').toLowerCase();
  return { uid: user.localId, email };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (!ALLOWED_ORIGINS.has(origin)) {
        return jsonResponse({ error: 'Origin not allowed' }, 403, origin);
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    if (!ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, origin);
    }

    if (!env.PLANFIX_TOKEN) {
      return jsonResponse({ error: 'PLANFIX_TOKEN is not configured' }, 500, origin);
    }

    const authorization = request.headers.get('Authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return jsonResponse({ error: 'Authentication required' }, 401, origin);
    }

    const user = await verifyFirebaseUser(match[1]);
    if (!user) {
      return jsonResponse({ error: 'Invalid or expired Firebase session' }, 401, origin);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, origin);
    }

    const { path, body } = input || {};
    if (!isAllowedPlanfixPath(path)) {
      return jsonResponse({ error: 'Planfix path is not allowed' }, 400, origin);
    }

    const planfixOptions = {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Authorization': `Bearer ${env.PLANFIX_TOKEN}`,
        'Accept': 'application/json'
      }
    };

    if (body !== undefined) {
      planfixOptions.headers['Content-Type'] = 'application/json';
      planfixOptions.body = JSON.stringify(body);
    }

    let planfixResponse;
    try {
      planfixResponse = await fetch(`${PLANFIX_BASE}/${path}`, planfixOptions);
    } catch {
      return jsonResponse({ error: 'Planfix is temporarily unavailable' }, 502, origin);
    }

    const responseText = await planfixResponse.text();
    const responseHeaders = {
      ...corsHeaders(origin),
      'Content-Type': planfixResponse.headers.get('Content-Type') || 'application/json; charset=utf-8'
    };

    if (!planfixResponse.ok) {
      let message = `Planfix returned HTTP ${planfixResponse.status}`;
      try {
        const parsed = JSON.parse(responseText);
        message = parsed.error || parsed.message || message;
      } catch {}
      return jsonResponse({ error: message }, planfixResponse.status, origin);
    }

    return new Response(responseText, {
      status: planfixResponse.status,
      headers: responseHeaders
    });
  }
};
