// calc-check-seppra: проверка калькуляций ПМО/ПЛД. Ничего не пишет в Planfix: принимает файл(ы), возвращает результат.
//
// POST /check, заголовок X-Check-Key (секрет CHECK_KEY).
//  Вариант 1: multipart/form-data: поле task, поля file (один или несколько .xlsx).
//  Вариант 2: JSON {"task": 98031, "files": [{"url": "https://…планфикс-ссылка-с-токеном…", "name": "…xlsx (необязательно)"}]}
//             Ссылка со встроенным токеном качается без заголовков; при необходимости можно передать X-Download-Authorization.
// Ответ всегда JSON: { task, status: ok|error|manual, passed, html, vmYear, hoursYear, parts, file, format, flow, checkedAt }.

import { parseCalc } from '../../src/parse.js';
import { formatResult } from '../../src/format.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const isXlsx = (name) => /\.(xlsx|xlsm)$/i.test(name || '');
// Файл калькуляции по имени (правило нейминга пока не утверждено, поэтому ещё и по содержимому).
const looksLikeCalc = (name) => /^(fs_)?clc|калькуляц/i.test(name || '');

function hostAllowed(url, env) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return env.ALLOWED_DOWNLOAD_HOSTS.split(',').map((s) => s.trim()).some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

async function download(f, env, auth) {
  if (!hostAllowed(f.url, env)) throw new Error(`Адрес файла «${f.name || f.url}» не разрешён (только ${env.ALLOWED_DOWNLOAD_HOSTS}).`);
  const r = await fetch(f.url, { headers: auth ? { Authorization: auth } : {}, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) throw new Error(`Файл «${f.name}» не скачался (HTTP ${r.status}).`);
  if (/text\/html/i.test(ct)) throw new Error(`Файл «${f.name}»: вместо файла пришла страница входа Planfix (нужна авторизация).`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > Number(env.MAX_FILE_BYTES)) throw new Error(`Файл «${f.name || f.url}» больше ${Math.round(Number(env.MAX_FILE_BYTES) / 1048576)} МБ.`);
  return { buf, name: f.name || nameFromResponse(r, f.url) };
}

// Имя файла: из заголовка Content-Disposition, иначе из последнего сегмента адреса.
function nameFromResponse(r, url) {
  const cd = r.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* ignore */ } }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (plain) return plain[1];
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { return ''; }
}

// xlsx это zip: первые байты «PK».
const isZip = (buf) => { const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength)); return b[0] === 0x50 && b[1] === 0x4b; };

async function readInput(req, env) {
  const ct = req.headers.get('content-type') || '';
  const out = { task: '', files: [] };
  if (/multipart\/form-data/i.test(ct)) {
    const fd = await req.formData();
    out.task = String(fd.get('task') || '');
    for (const v of fd.getAll('file')) {
      if (typeof v === 'string') continue;
      out.files.push({ name: v.name, buf: await v.arrayBuffer() });
    }
  } else {
    const b = await req.json();
    out.task = String(b.task || '');
    const auth = req.headers.get('X-Download-Authorization') || '';
    const list = Array.isArray(b.files) ? b.files : [];
    if (list.length > Number(env.MAX_FILES)) throw new Error(`Слишком много файлов (больше ${env.MAX_FILES}).`);
    for (const f of list) {
      // файл отбираем по расширению в имени, а если имени нет, по содержимому после скачивания
      if (f.name && !isXlsx(f.name)) continue;
      const d = await download(f, env, auth);
      if (!isZip(d.buf)) { if (f.name) throw new Error(`Файл «${f.name}» не похож на xlsx.`); continue; }
      out.files.push({ name: d.name || 'без имени.xlsx', buf: d.buf });
    }
  }
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' && req.method === 'GET') return json({ service: 'calc-check-seppra' });
    if (url.pathname !== '/check' || req.method !== 'POST') return json({ error: 'not found' }, 404);
    if (!env.CHECK_KEY || !safeEq(req.headers.get('X-Check-Key') || '', env.CHECK_KEY)) return json({ error: 'forbidden' }, 403);

    const checkedAt = new Date();
    let input;
    try { input = await readInput(req, env); } catch (e) {
      return json(fail(null, checkedAt, [String(e.message || e)]), 200);
    }
    const files = input.files.filter((f) => isXlsx(f.name) || isZip(f.buf));
    if (!files.length) return json(fail(input.task, checkedAt, ['В задаче нет xlsx-файлов для проверки.']));

    // Разбираем все xlsx; калькуляцией считаем файл, подходящий по имени или распознанный по содержимому.
    const candidates = [];
    for (const f of files) {
      const res = parseCalc(f.buf);
      const unrecognized = res.errors.length > 0 && res.errors.every((e) => e.code === 'no-names' || e.code === 'no-parts' || e.code === 'open');
      if (looksLikeCalc(f.name) || !unrecognized) candidates.push({ f, res });
    }
    if (!candidates.length) {
      return json(fail(input.task, checkedAt, [`Не найден файл калькуляции среди: ${files.map((f) => `«${f.name}»`).join(', ')}. Название файла калькуляции должно начинаться с FS_CLC.`]));
    }
    // Если файлов несколько, берётся последний в списке (порядок как в задаче).
    const { f, res } = candidates[candidates.length - 1];
    const html = formatResult(res, { fileName: f.name, date: checkedAt });
    return json({
      task: input.task, status: res.status, passed: res.status === 'ok', checkedAt: checkedAt.toISOString(),
      html, file: { name: f.name }, format: res.format, flow: res.flow || 'ПМО',
      vmYear: res.totals ? Math.round(res.totals.vmYear) : null,
      hoursYear: res.totals ? Math.round(res.totals.hoursYear * 10) / 10 : null,
      parts: res.parts.map((p) => ({ sheet: p.sheet, descrip: p.descrip, vmYear: Math.round(p.vmYear), hoursYear: Math.round(p.hoursYear * 10) / 10 })),
      errors: res.errors.map((e) => e.msg), warnings: res.warnings.map((w) => w.msg),
      skippedFiles: candidates.length < files.length ? files.filter((x) => !candidates.some((c) => c.f === x)).map((x) => x.name) : [],
      candidates: candidates.length,
    });
  },
};

function fail(task, checkedAt, messages) {
  const html = `<p>❗ <strong>Не прочитано.</strong></p>\n<p>&nbsp;</p>\n<p>Что не так:</p>\n` + messages.map((m) => `<p>&nbsp;&nbsp;• ${m.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('\n');
  return { task: task ?? '', status: 'error', passed: false, checkedAt: checkedAt.toISOString(), html, file: null, format: 'unknown', flow: null, vmYear: null, hoursYear: null, parts: [], errors: messages, warnings: [], skippedFiles: [], candidates: 0 };
}
