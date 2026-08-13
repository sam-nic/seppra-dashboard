from pathlib import Path

path = Path('proxy/claude/src/index.js')
s = path.read_text()


def replace_once(old, new):
    global s
    if old not in s:
        raise SystemExit('Expected block not found:\n' + old[:300])
    s = s.replace(old, new, 1)


replace_once(
    'const APP_VERSION = "32-2026-08-13";',
    'const APP_VERSION = "33-2026-08-13";'
)

replace_once(
r'''        if (!masterInstructionUrl) {
          return jsonResponse(
            {
              success: false,
              error:
                "masterInstructionUrl is required for apply_master_updates"
            },
            400
          );
        }''',
r'''        if (
          normalizeMasterInstructionUrls(
            masterInstructionUrl
          ).length === 0
        ) {
          return jsonResponse(
            {
              success: false,
              error:
                "masterInstructionUrl must contain at least one URL (string or array) for apply_master_updates"
            },
            400
          );
        }'''
)

replace_once(
r'''  try {
    // --------------------------------------------------------
    // 1. Скачиваем актуальный .md как UTF-8 текст
    // --------------------------------------------------------

    const currentMarkdown =
      await downloadTextFile(
        masterInstructionUrl
      );''',
r'''  try {
    // Planfix отдаёт файловые поля массивом ссылок. Для обратной
    // совместимости принимаем и одну строку. Текущая операция
    // обновляет один master-файл, поэтому используем первую
    // непустую ссылку; остальные сохраняются как допустимый
    // входной формат на будущее.
    const masterInstructionUrls =
      normalizeMasterInstructionUrls(
        masterInstructionUrl
      );

    const activeMasterInstructionUrl =
      masterInstructionUrls[0];

    if (masterInstructionUrls.length > 1) {
      console.warn(
        `[${taskNo}] Получено ${masterInstructionUrls.length} master-файлов; для apply_master_updates используется первый URL`
      );
    }

    // --------------------------------------------------------
    // 1. Скачиваем актуальный .md как UTF-8 текст
    // --------------------------------------------------------

    const currentMarkdown =
      await downloadTextFile(
        activeMasterInstructionUrl
      );'''
)

replace_once(
r'''    const originalFilename =
      getFilenameFromUrl(
        masterInstructionUrl
      );''',
r'''    const originalFilename =
      getFilenameFromUrl(
        activeMasterInstructionUrl
      );'''
)

replace_once(
r'''    // Вертикальные разделители таблиц
    .replace(
      /\s*\|\|\s*/g,
      " "
    )
    .replace(
      /\s+\|\s+/g,
      " "
    )''',
r'''    // Вертикальные разделители таблиц. В master-updates символ "|"
    // не несёт полезного смысла и не должен попадать в HTML Planfix.
    .replace(
      /\|+/g,
      " "
    )'''
)

replace_once(
r'''    // Лишние пробелы
    .replace(
      /[ \t]{2,}/g,
      " "
    )''',
r'''    // Убираем хвостовые пробелы, но сохраняем переносы строк —
    // они будут преобразованы в <br> при сборке HTML.
    .replace(
      /[ \t]+$/gm,
      ""
    )
    .replace(
      /^[ \t]+/gm,
      ""
    )
    .replace(
      /[ \t]{2,}/g,
      " "
    )'''
)

replace_once(
r'''function formatMasterUpdatesHtml(
  updates
) {''',
r'''function masterUpdateTextToHtml(
  value
) {
  const cleaned =
    cleanMasterUpdateText(
      value
    );

  if (!cleaned) {
    return "";
  }

  return escapeHtml(
    cleaned
  )
    .replace(
      /\r?\n/g,
      "<br>"
    );
}

function formatMasterUpdatesHtml(
  updates
) {'''
)

replace_once(
r'''        const section =
          escapeHtml(
            cleanMasterUpdateText(
              update.section
            )
          );

        const current =
          escapeHtml(
            cleanMasterUpdateText(
              update.currentText
            )
          );

        const proposed =
          escapeHtml(
            cleanMasterUpdateText(
              update.proposedText
            )
          );

        const reason =
          escapeHtml(
            cleanMasterUpdateText(
              update.reason
            )
          );''',
r'''        const section =
          masterUpdateTextToHtml(
            update.section
          );

        const current =
          masterUpdateTextToHtml(
            update.currentText
          );

        const proposed =
          masterUpdateTextToHtml(
            update.proposedText
          );

        const reason =
          masterUpdateTextToHtml(
            update.reason
          );'''
)

replace_once(
r'''        if (current) {
          html +=
            `<p><strong>Сейчас:</strong><br>${current}</p>`;
        }

        html +=
          `<p><strong>Предлагается:</strong><br>${proposed}</p>`;

        if (reason) {
          html +=
            `<p><em>Причина: ${reason}</em></p>`;
        }''',
r'''        if (current) {
          html +=
            `<p><strong>Сейчас:</strong><br>${current}</p>`;
        } else {
          html +=
            `<p><strong>Сейчас:</strong><br><em>Новое правило</em></p>`;
        }

        html +=
          `<p><strong>Предлагается:</strong><br>${proposed}</p>`;

        if (reason) {
          html +=
            `<p><strong>Почему:</strong><br>${reason}</p>`;
        }'''
)

replace_once(
r'''// ============================================================
// СКАЧИВАНИЕ ТЕКСТОВОГО MASTER.MD
// ============================================================

async function downloadTextFile(''',
r'''// ============================================================
// НОРМАЛИЗАЦИЯ ССЫЛОК НА MASTER-ФАЙЛЫ
// ============================================================

function normalizeMasterInstructionUrls(
  value
) {
  const values = Array.isArray(value)
    ? value
    : [value];

  return values
    .map((item) =>
      typeof item === "string"
        ? item.trim()
        : ""
    )
    .filter(Boolean);
}

// ============================================================
// СКАЧИВАНИЕ ТЕКСТОВОГО MASTER.MD
// ============================================================

async function downloadTextFile('''
)

path.write_text(s)
