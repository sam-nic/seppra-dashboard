// Supabase Edge Function: прокси к Planfix REST API.
// Токен Planfix хранится в секретах Supabase (PLANFIX_TOKEN) и не попадает в браузер.
// Запросы принимаются только от авторизованных пользователей @seppra.ru (+ whitelist).

import { createClient } from "jsr:@supabase/supabase-js@2";

const PLANFIX_TOKEN = Deno.env.get("PLANFIX_TOKEN")!;
const PLANFIX_BASE = "https://seppra.planfix.ru/rest";
const ALLOWED_DOMAIN = "@seppra.ru";
const ALLOWED_EMAILS = new Set(["lesha.suschits@gmail.com"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    // Проверяем сессию Supabase из заголовка Authorization
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    const email = (user?.email ?? "").toLowerCase();
    if (!user || !(email.endsWith(ALLOWED_DOMAIN) || ALLOWED_EMAILS.has(email))) {
      return json({ error: "unauthorized" }, 401);
    }

    const { path, body } = await req.json();
    if (typeof path !== "string" || path.includes("..") || path.includes("://")) {
      return json({ error: "bad path" }, 400);
    }

    const r = await fetch(`${PLANFIX_BASE}/${path}`, body != null
      ? {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${PLANFIX_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
      : { headers: { "Authorization": `Bearer ${PLANFIX_TOKEN}` } });

    return new Response(await r.text(), {
      status: r.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
