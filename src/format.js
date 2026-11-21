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
  return `<p>${icon} ${moscow(date)}${meta ? ` <small>(${meta})</small>` : ''}</p>`;
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

  const machine = result.parts.every((p) => p.hoursKind === 'машино-часы');
  const th = ['Деталь', 'ВМ в год, ₽', machine ? 'Машино-часы в год' : 'Часы наладчика в год', 'ВМ на час, ₽', 'Цена'].map((h) => `<th>${h}</th>`).join('');
  const row = (name, vm, hours, price) => `<tr><td>${name}</td><td align="right">${rub(vm)}</td><td align="right">${dec1(hours)}</td><td align="right">${hours > 0 ? rub(vm / hours) : '—'}</td><td>${price}</td></tr>`;
  const rows = result.parts.map((p) => row(`${esc(p.sheet)}${p.oneOff ? ' <small>(разовый заказ)</small>' : ''}`, p.vmYear, p.hoursYear, esc(p.priceSource)));
  const t = result.totals;
  if (result.parts.length > 1) rows.push(row('<strong>Итого</strong>', t.vmYear, t.hoursYear, ''));
  lines.push(`<table border="1" cellpadding="4" cellspacing="0"><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
  return lines.join('\n');
}

/** Старый формат 2.0, но ВМ и часы уже внесены вручную: проверка пройдена. */
export function formatManualAccepted({ vmYear, hoursYear }, { fileName, version, date } = {}) {
  return [head('✅', { fileName, version, date }),
    `<p>Формат калькуляции 2.0: ВМ и часы внесены вручную. ВМ в год: <strong>${rub(vmYear)} ₽</strong>, часы в год: <strong>${dec1(hoursYear)}</strong>.</p>`].join('\n');
}
