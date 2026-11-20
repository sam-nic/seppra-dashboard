// Прогон парсера по скачанным файлам (см. test/fetch.mjs).
// Запуск: node test/run.mjs <папка с xlsx и index.json>
import fs from 'node:fs';
import path from 'node:path';
import { parseCalc } from '../src/parse.js';
import { formatResult } from '../src/format.js';

const DIR = process.argv[2];
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const stats = {}, codes = {}, byFlow = {};
const rows = [];
let invariant = 0;
for (const r of index) {
  const res = parseCalc(fs.readFileSync(path.join(DIR, `${r.file}.xlsx`)));
  const flow = /ПЛД/.test(r.tname) ? 'ПЛД' : 'ПМО';
  (byFlow[flow] ||= {})[res.status] = ((byFlow[flow] || {})[res.status] || 0) + 1;
  stats[res.status] = (stats[res.status] || 0) + 1;
  for (const e of res.errors) codes[e.code] = (codes[e.code] || 0) + 1;
  for (const p of res.parts) {
    if (!(p.vmYear > 0 && p.hoursYear > 0 && Math.abs(p.vmPerHour - p.vmYear / p.hoursYear) < 1e-6)) { invariant++; console.log('ИНВАРИАНТ', r.file, p.sheet); }
  }
  rows.push({ файл: r.fname.slice(0, 34), поток: flow, статус: res.status, формат: res.format, листов: res.parts.length, коды: [...new Set(res.errors.map((e) => e.code))].join(',') });
}
console.table(rows);
console.log('статусы:', stats, '\nпо потокам:', byFlow, '\nкоды ошибок:', codes, '\nнарушений инвариантов:', invariant);
const ok = index.find((r) => parseCalc(fs.readFileSync(path.join(DIR, `${r.file}.xlsx`))).status === 'ok');
if (ok) console.log('\n' + formatResult(parseCalc(fs.readFileSync(path.join(DIR, `${ok.file}.xlsx`))), { fileName: ok.fname, fileId: ok.file, date: new Date('2026-11-20T09:00:00Z') }));
