// Проверка Worker'а локально (без сети): multipart и режим ссылок с подменой fetch.
import fs from 'node:fs';
import path from 'node:path';
import worker from '../worker/src/index.js';

const SP = process.argv[2];
const idx = JSON.parse(fs.readFileSync(path.join(SP, 'files/index.json'), 'utf8'));
const find = (re) => idx.find((r) => re.test(r.fname));
const bytes = (r) => fs.readFileSync(path.join(SP, 'files', `${r.file}.xlsx`));
const env = { CHECK_KEY: 'k', ALLOWED_DOWNLOAD_HOSTS: 'planfix.ru,planfix.com', MAX_FILE_BYTES: '10485760', MAX_FILES: '10' };
let pass = 0, fail = 0;
const ok = (t, c, x = '') => { (c ? pass++ : fail++); console.log((c ? 'OK   ' : 'FAIL ') + t + (x ? '  → ' + x : '')); };
const post = (body, headers = {}) => worker.fetch(new Request('https://x/check', { method: 'POST', headers: { 'X-Check-Key': 'k', ...headers }, body }), env).then((r) => r.json().then((j) => [r.status, j]));
const multipart = (task, files) => { const fd = new FormData(); fd.set('task', task); for (const [n, b] of files) fd.append('file', new Blob([b]), n); return fd; };

const good = find(/26035_Штуцер/), second = find(/26025_v3/), notCalc = find(/Запрос КП/), v2 = find(/01056/), plain = find(/Объем Сэппра/);
let [s, j] = await post(multipart('98031', [[good.fname, bytes(good)]]));
ok('multipart: калькуляция читается', s === 200 && j.status === 'ok' && j.passed && j.vmYear > 0 && /✅/.test(j.html), `vmYear=${j.vmYear} hoursYear=${j.hoursYear}`);
[s, j] = await post(multipart('98031', [[notCalc.fname, bytes(notCalc)], [good.fname, bytes(good)]]));
ok('посторонний xlsx пропускается, берётся калькуляция', j.status === 'ok' && j.file.name === good.fname && j.skippedFiles.includes(notCalc.fname), j.file && j.file.name);
[s, j] = await post(multipart('98031', [[good.fname, bytes(good)], [second.fname, bytes(second)]]));
ok('несколько калькуляций: берётся последняя', j.file.name === second.fname && j.candidates === 2, j.file.name);
[s, j] = await post(multipart('98031', [[notCalc.fname, bytes(notCalc)], [plain.fname, bytes(plain)]]));
ok('нет калькуляции: ❗ с подсказкой про FS_CLC', j.status === 'error' && /FS_CLC/.test(j.html) && !j.passed, j.errors[0].slice(0, 70));
[s, j] = await post(multipart('98031', [[v2.fname, bytes(v2)]]));
ok('формат 2.0: manual, не passed, ⚠️ и причина без инструкции', j.status === 'manual' && !j.passed && /⚠️/.test(j.html) && /не считаются/.test(j.html) && !/Внесите/.test(j.html) && !/❗/.test(j.html));
{ const fdm = multipart('98031', [[v2.fname, bytes(v2)]]); fdm.set('currentVmYear', '457 072,5'); fdm.set('currentHoursYear', '78,1');
  [s, j] = await post(fdm); ok('формат 2.0 + ВМ и часы внесены вручную: пройдено', j.status === 'ok' && j.passed && j.manualAccepted && j.vmYear === 457073 && /✅/.test(j.html), j.vmYear + ' / ' + j.hoursYear); }
{ const fdm = multipart('98031', [[v2.fname, bytes(v2)]]); fdm.set('currentVmYear', '457072');
  [s, j] = await post(fdm); ok('формат 2.0 + внесена только ВМ: остаётся manual', j.status === 'manual' && !j.passed); }
[s, j] = await post(multipart('98031', []));
ok('нет файлов: ❗', j.status === 'error' && /нет xlsx/.test(j.html));
[s] = await worker.fetch(new Request('https://x/check', { method: 'POST', headers: { 'X-Check-Key': 'bad' }, body: '{}' }), env).then((r) => [r.status]);
ok('неверный ключ: 403', s === 403);

// режим ссылок
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, opt) => {
  if (u.includes('rest/file/1/download')) { return new Response(bytes(good), { headers: { 'content-type': 'application/octet-stream' } }); }
  if (u.includes('login')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
  return new Response('no', { status: 404 });
};
[s, j] = await post(JSON.stringify({ task: 5, files: [{ name: good.fname, url: 'https://seppra.planfix.ru/rest/file/1/download' }] }), { 'content-type': 'application/json', 'X-Download-Authorization': 'Bearer t' });
ok('ссылки: скачивание и проверка', j.status === 'ok' && j.passed, j.status);
[s, j] = await post(JSON.stringify({ task: 5, files: [{ name: good.fname, url: 'https://evil.example.com/a.xlsx' }] }), { 'content-type': 'application/json' });
ok('ссылки: чужой хост запрещён', j.status === 'error' && /не разрешён/.test(j.html), j.errors[0].slice(0, 70));
[s, j] = await post(JSON.stringify({ task: 5, files: [{ name: good.fname, url: 'https://seppra.planfix.ru/login' }] }), { 'content-type': 'application/json' });
ok('ссылки: страница входа вместо файла распознаётся', j.status === 'error' && /страница входа/.test(j.html), j.errors[0].slice(0, 70));
[s, j] = await post('{"task": 5, "files": [{ "url": https://seppra.planfix.ru/x}]}', { 'content-type': 'application/json' });
ok('невалидный JSON: понятное сообщение', j.status === 'error' && /кавычек/.test(j.html), j.errors[0].slice(0, 60));
const many = Array.from({ length: 29 }, (_, i) => ({ name: `Чертёж_${i}.pdf`, url: `https://seppra.planfix.ru/rest/file/${i + 100}/download` }));
many.push({ name: good.fname, url: 'https://seppra.planfix.ru/rest/file/1/download' });
[s, j] = await post(JSON.stringify({ task: 5, files: many }), { 'content-type': 'application/json' });
ok('29 посторонних файлов с именами пропускаются, калькуляция проверена', j.status === 'ok' && j.passed, j.status);
const unnamed = Array.from({ length: 25 }, (_, i) => ({ url: `https://seppra.planfix.ru/rest/file/${i + 100}/download` }));
[s, j] = await post(JSON.stringify({ task: 5, files: unnamed }), { 'content-type': 'application/json' });
ok('25 файлов без имён: понятное требование передать name', j.status === 'error' && /name/.test(j.html), j.errors[0].slice(0, 70));
globalThis.fetch = realFetch;
console.log(`\nпройдено ${pass}, не пройдено ${fail}`); process.exit(fail ? 1 : 0);
