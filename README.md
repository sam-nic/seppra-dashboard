# calc-checker

Разбор и проверка калькуляций ПМО (xlsx) для воронки Seppra. Читает именованные ячейки на листах деталей, ничего не угадывает.

- `src/parse.js`: `parseCalc(buffer)` возвращает `{status: ok|error|manual, parts, errors, warnings, totals}`.
- `src/format.js`: `formatResult(result, {fileName, fileId})` возвращает HTML для поля «Результат проверки калькуляции» (✅ / ❗).
- Режимы: имена воронки (после обновления шаблона), текущий шаблон 3.0 (часы наладчика по подписи, с предупреждением), формат 2.0 (ВМ вручную).
- Проверка: `node test/run.mjs <папка с калькуляциями и parsed.json>`; на 34 реальных файлах 74 листа совпали с независимым расчётом.
- Дальше: endpoint `POST /check?task=ID` (скачать файл, запустить, записать поля 33636 и 33638). В Planfix пока ничего не пишется.

## Endpoint проверки (Worker `calc-check-seppra`)

`POST https://calc-check-seppra.api.misterfix.net/check` (до выпуска сертификата: `https://calc-check-seppra.lesha-suschits.workers.dev/check`).
Заголовок `X-Check-Key` (секрет, файл `~/.config/calc-check/key`, в Worker: `CHECK_KEY`). Worker ничего не пишет в Planfix: возвращает результат, поля заполняет сценарий.

Вариант 1, файл в запросе (`multipart/form-data`): поля `task` и `file` (один или несколько xlsx).
Вариант 2, ссылки со встроенным токеном (JSON): `{"task": 98031, "files": [{"url": "https://…"}]}`; имя файла необязательно (берётся из ответа сервера), заголовки не нужны; при необходимости можно передать `X-Download-Authorization`. Проверено на подписанной ссылке с `dcru.planfix.ru`. Разрешены только хосты planfix.ru / planfix.com, до 10 МБ и 10 файлов.

Ответ (JSON, статус 200): `status` (`ok` / `error` / `manual`), `passed` (true только при `ok`), `html` (текст для поля «Результат проверки калькуляции»), `vmYear`, `hoursYear`, `parts[]`, `file.name`, `errors[]`, `warnings[]`, `checkedAt`. Для `manual` (формат 2.0) поле «ВМ в год» заполняется вручную, сценарий его не трогает.
Выбор файла: берутся xlsx, подходящие по имени (начало `FS_CLC` / `CLC`, слово «калькуляция») или распознанные по содержимому; если таких несколько, берётся последний в списке. Тесты: `node test/worker.mjs <папка>`.
