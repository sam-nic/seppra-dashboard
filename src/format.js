// Текст для поля «Результат проверки калькуляции» (rich text, HTML: один абзац = одна строка).

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rub = (n) => Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ');
const two = (n) => String(n).padStart(2, '0');

/** Дата и время проверки по Москве: 17.11.2026 14:05 */
export function moscow(date = new Date()) {
  const d = new Date(date.getTime() + 3 * 3600 * 1000);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export function formatResult(result, { fileName, fileId, date } = {}) {
  const when = moscow(date);
  const file = fileName ? `файл ${esc(fileName)}${fileId ? ` (id ${esc(fileId)})` : ''}` : 'файл';
  // Блоки отделяются пустым абзацем, строки внутри блока идут подряд.
  const blocks = [];
  if (result.status === 'ok') {
    const t = result.totals;
    blocks.push([`<p>✅ <strong>Всё окей.</strong> Проверено ${when}, ${file}.</p>`]);
    blocks.push([`<p>Деталей: <strong>${t.parts}</strong>, ВМ в год: <strong>${rub(t.vmYear)} ₽</strong>, ${result.parts.every((p) => p.hoursKind === 'машино-часы') ? 'машино-часы' : 'наладчик'}: <strong>${t.hoursYear.toFixed(1).replace('.', ',')} ч</strong> в год.</p>`,
      ...result.parts.map((p) => `<p>&nbsp;&nbsp;«${esc(p.sheet)}»: ${rub(p.vmYear)} ₽ в год${p.oneOff ? ' (разовый заказ, ВМ всего заказа)' : ''}, ${p.priceSource}</p>`)]);
    const legacy = result.warnings.filter((w) => w.code === 'legacy').length;
    const warn = [];
    if (legacy) warn.push(`<p>⚠️ Часы наладчика прочитаны по подписи (листов: ${legacy}): имена воронки в шаблоне ещё не заданы.</p>`);
    for (const w of result.warnings.filter((w) => w.code !== 'legacy')) warn.push(`<p>⚠️ ${esc(w.msg)}</p>`);
    if (warn.length) blocks.push(warn);
  } else if (result.status === 'manual') {
    blocks.push([`<p>❗ <strong>Нужен ручной ввод.</strong> Проверено ${when}, ${file}.</p>`]);
    blocks.push(['<p>Формат калькуляции 2.0: ВМ автоматически не читается. Внесите «ВМ в год» вручную.</p>']);
  } else {
    blocks.push([`<p>❗ <strong>Не прочитано.</strong> Проверено ${when}, ${file}.</p>`]);
    blocks.push(['<p>Что не так:</p>', ...result.errors.map((e) => `<p>&nbsp;&nbsp;• ${esc(e.msg)}</p>`)]);
    blocks.push(['<p>Исправьте файл и добавьте его заново: проверка запустится сама.</p>']);
  }
  return blocks.map((b) => b.join('\n')).join('\n<p>&nbsp;</p>\n');
}
