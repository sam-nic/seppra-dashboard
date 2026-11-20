// Скачивает xlsx из задач «Клк …» seppra в указанную папку (только чтение).
// Запуск: PLANFIX_TOKEN=... node test/fetch.mjs <папка>
import fs from 'node:fs';
import path from 'node:path';
const T = process.env.PLANFIX_TOKEN, OUT = process.argv[2];
if (!T || !OUT) { console.error('нужны PLANFIX_TOKEN и папка'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' };
const api = async (p, body) => (await fetch('https://seppra.planfix.ru/rest/' + p, body ? { method: 'POST', headers: H, body: JSON.stringify(body) } : { headers: H })).json();
const tasks = [];
for (const q of ['Клк ПМО', 'Клк ПЛД']) {
  for (let off = 0; ; off += 100) {
    const d = await api('task/list', { offset: off, pageSize: 100, fields: 'id,name', filters: [{ type: 8, operator: 'equal', value: q }] });
    tasks.push(...(d.tasks || []));
    if ((d.tasks || []).length < 100) break;
  }
}
const index = [];
for (const t of tasks) {
  const d = await api(`task/${t.id}/files?fields=id,name,size`);
  for (const f of d.files || []) {
    if (!/\.xlsx?m?$/i.test(f.name) || !/\.xlsx$|\.xlsm$/i.test(f.name)) continue;
    const r = await fetch(`https://seppra.planfix.ru/rest/file/${f.id}/download`, { headers: { Authorization: 'Bearer ' + T } });
    if (!r.ok) continue;
    fs.writeFileSync(path.join(OUT, `${f.id}.xlsx`), Buffer.from(await r.arrayBuffer()));
    index.push({ task: t.id, tname: t.name, file: f.id, fname: f.name });
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log('задач', tasks.length, 'файлов', index.length);
