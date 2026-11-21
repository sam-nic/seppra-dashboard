// Текст для поля «Результат проверки калькуляции» (rich text, HTML).
// Формат: 1) значок, дата-время и в скобках мелким шрифтом файл и версия шаблона;
//         2) предупреждения (если есть) следующей строкой; 3) детали таблицей.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rub = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const dec1 = (n) => n.toFixed(1).replace('.', ',');
const two = (n) => String(n).padStart(2, '0');

/** Дата и время проверки по Москве: 17.11.2026 14:05 */
export function moscow(date = new Date()) {
  const d = new Date(date.getTime() + 3 * 3600 * 1000);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

function head(icon, { fileName, version, date }) {
  const meta = [fileName ? esc(fileName) : null, version ? `версия ${esc(version)}` : null].filter(Boolean).join(', ');
  // Первая строка без абзаца <p>: в динамическом блоке она идёт сразу под меткой, без отступа.
  return `${icon} ${moscow(date)}${meta ? ` <small>(${meta})</small>` : ''}`;
}

/** Сообщения об ошибках без разбора файла (нет файла, не открылся, не JSON и т.п.). */
export function formatErrors(messages, { fileName, version, date } = {}) {
  // Подробности списком: отступ после сводки появляется сам.
  return [head('❗', { fileName, version, date }), `<ul>${messages.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`,
    '<p><small>Исправьте файл и добавьте его заново: проверка запустится сама.</small></p>'].join('\n');
}

export function formatResult(result, { fileName, fileId, date } = {}) {
  const ctx = { fileName, version: result.templateVersion, date };
  if (result.status === 'manual') {
    return [head('⚠️', ctx), '<ul><li>Формат калькуляции 2.0: ВМ и часы автоматически не считаются.</li></ul>'].join('\n');
  }
  if (result.status !== 'ok') return formatErrors(result.errors.map((e) => e.msg), ctx);

  const lines = [head('✅', ctx)];
  const legacy = result.warnings.filter((w) => w.code === 'legacy').length;
  if (legacy) lines.push('<p>⚠️ Прежний шаблон калькуляции: часы наладчика прочитаны по подписи. Расчёт корректен, но лучше перейти на актуальный шаблон.</p>');
  for (const w of result.warnings.filter((w) => w.code !== 'legacy')) lines.push(`<p>⚠️ ${esc(w.msg)}</p>`);

  // Таблица в стиле таблиц Seppra (динамические блоки): класс pf-ckeditor-table, шапка #eeeeee,
  // серый мелкий жирный шрифт заголовков, числа выровнены вправо, жирным только «Итого».
  const machine = result.parts.every((p) => p.hoursKind === 'машино-часы');
  const headCell = (text, w) => `<td style="background-color:#eeeeee${w ? `; text-align:center; width:${w}px` : ''}"><span style="color:#808080"><span style="font-size:12px"><strong>${text}</strong></span></span></td>`;
  const num = (text, w) => `<td style="text-align:right; width:${w}px">${text}</td>`;
  const header = `<tr>${headCell('Деталь')}${headCell('ВМ в год, ₽', 110)}${headCell(machine ? 'Машино-часы в год' : 'Часы наладчика в год', 130)}${headCell('ВМ на час, ₽', 100)}${headCell('Цена', 130)}</tr>`;
  const row = (name, vm, hours, price) => `<tr><td>${name}</td>${num(rub(vm), 110)}${num(dec1(hours), 130)}${num(hours > 0 ? rub(vm / hours) : '—', 100)}<td>${price}</td></tr>`;
  const rows = result.parts.map((p) => row(`${esc(p.sheet)}${p.oneOff ? ' <small>(разовый заказ)</small>' : ''}`, p.vmYear, p.hoursYear, esc(p.priceSource)));
  const t = result.totals;
  if (result.parts.length > 1) rows.push(row('<strong>Итого</strong>', t.vmYear, t.hoursYear, ''));
  lines.push(`<table class="pf-ckeditor-table" style="width:100%"><tbody>${header}${rows.join('')}</tbody></table>`);
  return lines.join('\n');
}

/** Старый формат 2.0, но ВМ и часы уже внесены вручную: проверка пройдена. */
export function formatManualAccepted({ vmYear, hoursYear }, { fileName, version, date } = {}) {
  return [head('✅', { fileName, version, date }),
    `<p>Формат калькуляции 2.0: ВМ и часы внесены вручную. ВМ в год: <strong>${rub(vmYear)} ₽</strong>, часы в год: <strong>${dec1(hoursYear)}</strong>.</p>`].join('\n');
}
