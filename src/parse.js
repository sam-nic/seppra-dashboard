// Разбор калькуляции ПМО (xlsx) для воронки Seppra.
//
// Принципы (решено 17.11.2026):
//  - читаем только именованные ячейки на листах деталей (область видимости: лист);
//  - если имя потеряно или поломано, не угадываем, а возвращаем ошибку с описанием;
//  - файл разбирается один раз, когда его добавили или заменили в Planfix.
//
// Результат: { status: 'ok' | 'error' | 'manual', format, parts[], errors[], warnings[], totals }
//   ok     — все листы деталей прочитаны;
//   error  — что-то не прочиталось или не прошло проверку, ВМ не считаем;
//   manual — формат 2.0, ВМ вносится вручную.

import * as XLSX from 'xlsx';

// Листы, которые не являются листами деталей.
const SERVICE_SHEETS = new Set(['manual', 'cbd', 'cbd (eng)', 'overview', 'история изменений', 'capacity', 'roi']);

// Обязательные имена нового шаблона (после того как их добавят в шаблон).
// Шаблон ПМО v3.2: Gmargin = ВМ по целевой цене (AP63), price = «Цена КП (факт)» (AT8).
// Новые имена, которые нужно добавить в шаблон: GmarginFact (AP67), SetupLoadYear (AU35), SetupLoadMonth (BC35).
export const REQUIRED_NAMES = [
  'Descrip', 'QtyYear', 'QtyMonth', 'price', 'EXWprice',
  'Gmargin', 'GmarginFact', 'SetupLoadYear', 'SetupLoadMonth',
];
// Имена текущего шаблона 3.0 (одна цена, часы наладчика без имени).
const LEGACY_NAMES = ['Descrip', 'QtyYear', 'QtyMonth', 'price', 'EXWprice', 'Gmargin'];

const HOURS_LABEL = /^загрузка наладчика,?\s*час/i;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** Ячейка по ссылке вида 'Лист'!$B$3 (лист берётся из самого имени). */
function cellByRef(wb, ref) {
  if (!ref || /#REF!/i.test(ref)) return { broken: true };
  const i = ref.lastIndexOf('!');
  if (i < 0) return { broken: true };
  let sheet = ref.slice(0, i);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  const addr = ref.slice(i + 1).replace(/\$/g, '');
  if (!/^[A-Z]+\d+$/.test(addr)) return { broken: true };
  const ws = wb.Sheets[sheet];
  if (!ws) return { broken: true };
  const c = ws[addr];
  return { addr, sheet, value: c ? c.v : undefined };
}

/** Имена, привязанные к листу: { имя: Ref }. */
function sheetNames(wb) {
  const out = {};
  for (const n of (wb.Workbook && wb.Workbook.Names) || []) {
    if (n.Sheet === undefined || n.Sheet === null) continue;
    const sheet = wb.SheetNames[n.Sheet];
    (out[sheet] ||= {})[n.Name] = n.Ref;
  }
  return out;
}

/** Часы наладчика по подписи (запасной разбор для текущего шаблона 3.0). */
function hoursByLabel(ws) {
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const c = ws[addr];
    if (typeof c.v !== 'string' || !HOURS_LABEL.test(c.v.trim())) continue;
    const m = addr.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const row = Number(m[2]);
    const cols = [];
    for (const a of Object.keys(ws)) {
      const mm = a.match(/^([A-Z]+)(\d+)$/);
      if (mm && Number(mm[2]) === row) cols.push({ a, col: XLSX.utils.decode_col(mm[1]), v: ws[a].v });
    }
    cols.sort((x, y) => x.col - y.col);
    const valueAfter = (rx) => {
      const k = cols.findIndex((x) => typeof x.v === 'string' && rx.test(x.v.trim()));
      if (k < 0) return null;
      for (let j = k + 1; j < cols.length; j++) if (num(cols[j].v) !== null) return cols[j].v;
      return null;
    };
    const year = valueAfter(/^год$/i);
    const month = valueAfter(/^мес/i);
    if (year !== null && month !== null) return { year, month, addr };
  }
  return null;
}

export function parseCalc(input) {
  const result = { status: 'ok', format: 'unknown', parts: [], errors: [], warnings: [], totals: null };
  let wb;
  try {
    const isNodeBuffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(input);
    wb = XLSX.read(isNodeBuffer ? input : new Uint8Array(input), { type: isNodeBuffer ? 'buffer' : 'array' });
  } catch (e) {
    result.status = 'error';
    result.errors.push({ code: 'open', msg: 'Файл не открывается как xlsx.' });
    return result;
  }
  if (wb.SheetNames.includes('Overview') && wb.SheetNames.includes('Rates') && wb.SheetNames.some((n) => /^Calc_\d+/.test(n))) {
    return parseInjection(wb, result);
  }
  const names = sheetNames(wb);
  const partSheets = wb.SheetNames.filter((s) => !SERVICE_SHEETS.has(s.trim().toLowerCase()));
  if (!partSheets.length) {
    result.status = 'error';
    result.errors.push({ code: 'no-parts', msg: 'В файле нет листов деталей.' });
    return result;
  }

  const readName = (sheet, name) => {
    const ref = (names[sheet] || {})[name];
    if (!ref) return { missing: true };
    const c = cellByRef(wb, ref);
    if (c.broken) return { broken: true };
    return { value: c.value, addr: c.addr };
  };

  const formats = new Set();
  for (const sheet of partSheets) {
    const ver = wb.Sheets[sheet]['AW4'] && String(wb.Sheets[sheet]['AW4'].v || '').trim();
    const have = (n) => !!(names[sheet] || {})[n];
    const newMode = REQUIRED_NAMES.every(have);
    const legacy3 = !newMode && LEGACY_NAMES.every(have);
    const isV2 = /версия\s*2/i.test(ver || '');

    if (isV2) {
      formats.add('2.0');
      result.errors.push({ code: 'format-2', sheet, msg: `Лист «${sheet}»: формат 2.0 (ВМ в файле не читается), внесите ВМ вручную.`, manual: true });
      continue;
    }
    if (!newMode && !legacy3) {
      // файл похож на текущий шаблон 3.0 (есть Gmargin)? тогда обязательны только его имена
      const expected = have('Gmargin') ? LEGACY_NAMES : REQUIRED_NAMES;
      const missing = expected.filter((n) => !have(n));
      if (!Object.keys(names[sheet] || {}).length) {
        result.errors.push({ code: 'no-names', sheet, msg: `Лист «${sheet}»: нет именованных ячеек (лист пересобран или скопирован без имён).` });
      } else {
        result.errors.push({ code: 'missing-names', sheet, msg: `Лист «${sheet}»: нет имён ${missing.join(', ')}.` });
      }
      continue;
    }
    if (!newMode && have('PriceFact')) {
      const pf = readName(sheet, 'price');
      if (num(pf.value) > 0) {
        result.errors.push({ code: 'missing-names', sheet, msg: `Лист «${sheet}»: введена «Цена КП (факт)», но в шаблоне нет имени GmarginFact (ВМ по цене КП), прочитать нельзя.` });
        continue;
      }
    }
    formats.add(newMode ? 'names' : '3.0-legacy');

    const part = { sheet };
    let bad = false;
    const need = newMode ? REQUIRED_NAMES : LEGACY_NAMES;
    for (const n of need) {
      const r = readName(sheet, n);
      if (r.broken) { result.errors.push({ code: 'broken-name', sheet, name: n, msg: `Лист «${sheet}»: имя ${n} указывает в никуда (#REF!).` }); bad = true; continue; }
      part[n] = r.value;
      part[`${n}_addr`] = r.addr;
    }
    if (bad) continue;

    const qy = num(part.QtyYear), qm = num(part.QtyMonth);
    const priceKp = num(part.price);
    let gm, hoursYear, hoursMonth, source;
    if (newMode) {
      const kp = priceKp !== null && priceKp > 0;
      gm = num(kp ? part.GmarginFact : part.Gmargin);
      source = kp ? 'цена КП' : 'целевая цена';
      hoursYear = num(part.SetupLoadYear);
      hoursMonth = num(part.SetupLoadMonth);
    } else {
      gm = num(part.Gmargin);
      source = 'расчётная цена';
      const h = hoursByLabel(wb.Sheets[sheet]);
      if (!h) {
        result.errors.push({ code: 'no-hours', sheet, msg: `Лист «${sheet}»: не найдена строка «Загрузка наладчика, час».` });
        continue;
      }
      hoursYear = num(h.year);
      hoursMonth = num(h.month);
      result.warnings.push({ code: 'legacy', sheet, msg: `Лист «${sheet}»: часы наладчика прочитаны по подписи (ячейка ${h.addr}); имена воронки в шаблоне не заданы.` });
    }

    const err = (m) => { result.errors.push({ code: 'invalid', sheet, msg: `Лист «${sheet}»: ${m}` }); bad = true; };
    if (qy === null || qy <= 0) err('потребность в год не число или не больше нуля.');
    if (qm === null || qm <= 0) err('потребность в месяц не число или не больше нуля.');
    if (qy !== null && qm !== null && qm > qy) err('потребность в месяц больше потребности в год.');
    if (gm === null || gm <= 0) err(`валовая маржа (${source}) не число или не больше нуля.`);
    if (hoursYear === null || hoursYear <= 0) err('загрузка наладчика в год не число или не больше нуля.');
    if (hoursMonth === null || hoursMonth <= 0) err('загрузка наладчика в месяц не число или не больше нуля.');
    if (bad) continue;

    part.descrip = part.Descrip ? String(part.Descrip).trim() : '';
    part.qtyYear = qy; part.qtyMonth = qm;
    part.priceSource = source;
    // Все показатели годовые (решено 18.11.2026): ВМ в год, часы наладчика в год.
    // Для разового заказа (QtyYear = QtyMonth) это ВМ и часы всего заказа.
    part.vmYear = gm;
    part.hoursYear = hoursYear;
    part.vmPerHour = gm / hoursYear;
    part.oneOff = qy === qm;
    result.parts.push(part);
  }

  // Варианты объёма: одинаковое описание на нескольких листах при разных объёмах.
  const byDescr = new Map();
  for (const p of result.parts) {
    if (!p.descrip) continue;
    const k = p.descrip.toLowerCase();
    (byDescr.get(k) || byDescr.set(k, []).get(k)).push(p);
  }
  for (const group of byDescr.values()) {
    if (group.length > 1 && new Set(group.map((g) => g.qtyYear)).size > 1) {
      result.errors.push({
        code: 'variants',
        msg: `Найдено ${group.length} листа «${group[0].descrip}» с разными объёмами (${group.map((g) => `«${g.sheet}»`).join(', ')}). Оставьте в файле один вариант.`,
      });
    }
  }

  result.format = [...formats].join('+') || 'unknown';
  const manualOnly = result.errors.length > 0 && result.errors.every((e) => e.manual);
  if (result.errors.length) result.status = manualOnly ? 'manual' : 'error';
  if (result.status === 'ok') {
    result.totals = {
      parts: result.parts.length,
      vmYear: result.parts.reduce((s, p) => s + p.vmYear, 0),
      hoursYear: result.parts.reduce((s, p) => s + p.hoursYear, 0),
    };
  }
  return result;
}


// ---------- ПЛД (литьё под давлением), шаблон «упрощённый» от 17.11.2026 ----------
// Источник: лист Overview, строки 5..14 (одна строка = одна позиция = один лист Calc_N).
//   B номер детали, C описание, D годовой объём, E цена ₽/шт, I машино-часы в год, L валовая маржа ₽/год.
// Имена: Margin_N (₽/шт, Calc_N!J22) используем для контроля: Margin_N × объём ≈ L.
// Часы: машино-часы (Overview, столбец I): вопрос к Владимиру, какие часы считать для ПЛД.
function parseInjection(wb, result) {
  result.format = 'injection';
  result.flow = 'ПЛД';
  const ov = wb.Sheets.Overview;
  const val = (a) => (ov[a] ? ov[a].v : undefined);
  const nm = {};
  for (const n of (wb.Workbook && wb.Workbook.Names) || []) if (n.Sheet == null) nm[n.Name] = n.Ref;
  const seen = new Map();
  for (let r = 5; r <= 14; r++) {
    const vol = val(`D${r}`);
    const label = `позиция ${r - 4}`;
    const empty = [val(`B${r}`), val(`C${r}`), vol, val(`L${r}`)].every((v) => v === undefined || v === '' || v === 0);
    if (empty) continue;
    const id = String(val(`B${r}`) ?? '').trim();
    const sheet = wb.SheetNames.find((n) => new RegExp(`^Calc_${r - 4}(\\D|$)`).test(n)) || `Calc_${r - 4}`;
    const err = (m) => result.errors.push({ code: 'invalid', sheet, msg: `Overview, ${label}${id ? ` «${id}»` : ''}: ${m}` });
    const qy = num(vol), vm = num(val(`L${r}`)), mh = num(val(`I${r}`));
    let bad = false;
    if (qy === null || qy <= 0) { err('годовой объём не число или не больше нуля.'); bad = true; }
    if (vm === null || vm <= 0) { err('валовая маржа в год не число или не больше нуля (проверьте, что файл пересчитан в Excel).'); bad = true; }
    if (mh === null || mh <= 0) { err('машино-часы в год не число или не больше нуля.'); bad = true; }
    if (!id) { err('не указан номер детали.'); bad = true; }
    if (id) {
      if (seen.has(id.toLowerCase())) { err(`номер детали «${id}» повторяется: одна деталь, одна калькуляция.`); bad = true; }
      seen.set(id.toLowerCase(), true);
    }
    // контроль по листу детали: Margin_N × объём ≈ ВМ в Overview
    const ref = nm[`Margin_${r - 4}`];
    if (!bad && ref) {
      const c = cellByRef(wb, ref);
      const perPiece = c.broken ? null : num(c.value);
      if (perPiece === null) { result.errors.push({ code: 'broken-name', sheet, name: `Margin_${r - 4}`, msg: `Имя Margin_${r - 4} указывает в никуда или не число.` }); bad = true; }
      else if (Math.abs(perPiece * qy - vm) > Math.max(1, vm * 0.01)) { err(`маржа на листе детали (${Math.round(perPiece * qy)} ₽/год) не совпадает с Overview (${Math.round(vm)} ₽/год).`); bad = true; }
    } else if (!bad && !ref) {
      result.errors.push({ code: 'missing-names', sheet, msg: `Нет имени Margin_${r - 4}.` }); bad = true;
    }
    if (bad) continue;
    result.parts.push({
      sheet, descrip: String(val(`C${r}`) ?? '').trim() || id, partNumber: id,
      qtyYear: qy, priceSource: 'цена из калькуляции', vmYear: vm, hoursYear: mh, hoursKind: 'машино-часы',
      vmPerHour: vm / mh, oneOff: false,
    });
  }
  if (!result.parts.length && !result.errors.length) {
    result.errors.push({ code: 'no-parts', msg: 'В Overview нет заполненных позиций (годовой объём и валовая маржа).' });
  }
  if (result.errors.length) result.status = 'error';
  else result.totals = {
    parts: result.parts.length,
    vmYear: result.parts.reduce((s, p) => s + p.vmYear, 0),
    hoursYear: result.parts.reduce((s, p) => s + p.hoursYear, 0),
  };
  return result;
}
