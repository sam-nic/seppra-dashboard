// Общий вход дашборда через Planfix OAuth (seppra). Проверку доступа делает Worker dashboard-seppra,
// здесь только хранение сессии и экран входа. Белый список: 3 пользователя, задаётся в Worker.
const WORKER = "https://dashboard-seppra.api.misterfix.net";
const KEY = "pf_session";
const subs = [];
let current = null;

function parse(t) {
  try { return JSON.parse(atob(t.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}
function store(t) { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} }
function stored() { try { return localStorage.getItem(KEY); } catch { return null; } }

function readSession() {
  const m = location.hash.match(/pf_token=([^&]+)/);
  if (m) {
    store(m[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const t = stored();
  const p = t && parse(t);
  if (p && p.exp > Date.now() / 1000) return { token: t, id: p.id, name: p.name || "" };
  store(null);
  return null;
}

function emit() { subs.forEach((cb) => cb(current)); }

export const PF = {
  user: () => current,
  token: () => (current ? current.token : null),
  onChange(cb) { subs.push(cb); cb(current); },
  login() {
    location.href = WORKER + "/login?return=" + encodeURIComponent(location.origin + location.pathname);
  },
  signOut() { store(null); current = null; emit(); },
  async data(name) {
    if (!current) throw new Error("Требуется вход");
    const r = await fetch(`${WORKER}/data/${name}`, { headers: { Authorization: "Bearer " + current.token } });
    if (r.status === 401) { PF.signOut(); throw new Error("Сессия истекла. Войдите снова."); }
    if (!r.ok) throw new Error("Данные недоступны (" + r.status + ")");
    return r.json();
  },
};
window.PF_login = () => PF.login();

current = readSession();
if (current) {
  // сервер — источник истины: он же применяет белый список
  fetch(WORKER + "/me", { headers: { Authorization: "Bearer " + current.token } })
    .then((r) => { if (r.status === 401) PF.signOut(); })
    .catch(() => {});
}
