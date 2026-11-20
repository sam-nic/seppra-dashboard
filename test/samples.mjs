// Проверки на образцах нового шаблона (ПМО v3.2 и ПЛД) и синтетических вариантах.
// Запуск: node test/samples.mjs <папка с 5853952.xlsx и 5853954.xlsx>
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseCalc } from '../src/parse.js';

const DIR = process.argv[2];
const load = (id) => XLSX.read(fs.readFileSync(path.join(DIR, `${id}.xlsx`)), { cellFormula: false });
const toBuf = (wb) => XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const put = (wb, sheet, addr, v) => { wb.Sheets[sheet][addr] = { t: typeof v === 'number' ? 'n' : 's', v }; };
const addName = (wb, name, sheet, ref) => { wb.Workbook.Names.push({ Name: name, Ref: `${sheet}!${ref}`, Sheet: wb.SheetNames.indexOf(sheet) }); };
let pass = 0, fail = 0;
const check = (title, cond, extra = '') => { (cond ? pass++ : fail++); console.log((cond ? 'OK   ' : 'FAIL ') + title + (extra ? '  → ' + extra : '')); };

// --- образцы как есть (пустые шаблоны)
let r = parseCalc(fs.readFileSync(path.join(DIR, '5853952.xlsx')));
check('ПМО v3.2 пустой образец: ошибка, не «ok»', r.status === 'error', r.errors.map((e) => e.msg).join(' / ').slice(0, 160));
r = parseCalc(fs.readFileSync(path.join(DIR, '5853954.xlsx')));
check('ПЛД пустой образец: «нет заполненных позиций»', r.status === 'error' && r.format === 'injection' && r.errors[0].code === 'no-parts', r.errors[0] && r.errors[0].msg);

// --- ПМО v3.2 с заполненными значениями
const pmo = (mut) => { const wb = load('5853952'); for (const [n, ref] of [['GmarginFact', '$AP$67'], ['SetupLoadYear', '$AU$35'], ['SetupLoadMonth', '$BC$35']]) addName(wb, n, 'CLC', ref);
  const f = { AN14: 'Деталь А', CM22: 24000, CM23: 2000, AT8: 0, AC63: 50, AP63: 480000, AP67: 0, AU35: 100, BC35: 8.33 }; Object.assign(f, mut || {});
  for (const [a, v] of Object.entries(f)) put(wb, 'CLC', a, v); return wb; };
r = parseCalc(toBuf(pmo()));
check('ПМО v3.2: цена КП не введена, ВМ по целевой', r.status === 'ok' && r.parts[0].vmYear === 480000 && r.parts[0].priceSource === 'целевая цена', JSON.stringify(r.totals));
r = parseCalc(toBuf(pmo({ AT8: 60, AP67: 600000 })));
check('ПМО v3.2: цена КП введена, ВМ по КП', r.status === 'ok' && r.parts[0].vmYear === 600000 && r.parts[0].priceSource === 'цена КП');
r = parseCalc(toBuf(pmo({ CM23: 30000 })));
check('ПМО v3.2: объём в месяц больше годового, ошибка', r.status === 'error');
{ const wb = load('5853952'); const f = { AN14: 'Д', CM22: 24000, CM23: 2000, AT8: 60, AC63: 50, AP63: 480000 }; for (const [a, v] of Object.entries(f)) put(wb, 'CLC', a, v);
  r = parseCalc(toBuf(wb)); check('ПМО v3.2: цена КП введена, а имён воронки нет, ошибка (не молча по целевой)', r.status === 'error' && /GmarginFact/.test(r.errors[0].msg), r.errors[0].msg.slice(0, 90)); }

// --- ПЛД
const inj = (rows, margins) => { const wb = load('5853954');
  rows.forEach((row, i) => { const R = 5 + i; put(wb, 'Overview', `B${R}`, row.id); put(wb, 'Overview', `C${R}`, 'Деталь'); put(wb, 'Overview', `D${R}`, row.vol); put(wb, 'Overview', `I${R}`, row.mh); put(wb, 'Overview', `L${R}`, row.vm); put(wb, `Calc_${i + 1}`, 'J22', margins[i]); });
  return wb; };
r = parseCalc(toBuf(inj([{ id: 'К-1', vol: 10000, mh: 500, vm: 250000 }, { id: 'К-2', vol: 5000, mh: 200, vm: 100000 }], [25, 20])));
check('ПЛД: две позиции согласованы, ok', r.status === 'ok' && r.parts.length === 2 && r.totals.vmYear === 350000 && r.parts[0].hoursKind === 'машино-часы', JSON.stringify(r.totals));
r = parseCalc(toBuf(inj([{ id: 'К-1', vol: 10000, mh: 500, vm: 250000 }], [30])));
check('ПЛД: маржа на листе и в Overview расходятся, ошибка', r.status === 'error' && /не совпадает/.test(r.errors[0].msg), r.errors[0].msg);
r = parseCalc(toBuf(inj([{ id: 'К-1', vol: 10000, mh: 500, vm: 250000 }, { id: 'К-1', vol: 5000, mh: 200, vm: 100000 }], [25, 20])));
check('ПЛД: повтор номера детали, ошибка', r.status === 'error' && /повторяется/.test(r.errors.map((e) => e.msg).join()), r.errors[0].msg);
r = parseCalc(toBuf(inj([{ id: 'К-1', vol: 10000, mh: 0, vm: 250000 }], [25])));
check('ПЛД: нулевые машино-часы, ошибка', r.status === 'error');
console.log(`\nпройдено ${pass}, не пройдено ${fail}`); process.exit(fail ? 1 : 0);
