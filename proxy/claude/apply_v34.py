from pathlib import Path

path = Path('proxy/claude/src/index.js')
s = path.read_text(encoding='utf-8')

s = s.replace(
    'const APP_VERSION = "33-2026-08-13";',
    'const APP_VERSION = "34-2026-08-13";',
    1,
)

start = s.index('async function processApplyMasterUpdates({')
end_marker = '// ============================================================\n// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ НОВОЙ АРХИТЕКТУРЫ\n// ============================================================'
end = s.index(end_marker, start)

new_process = r'''async function processApplyMasterUpdates({
  masterFileCallback,
  taskNo,
  userEmail,
  masterInstructionUrl,
  updates,
  planfixFileUploadToken,
  planfixDomen
}) {
  console.log(
    `[${taskNo}] Детерминированное применение master-updates, утверждённых пунктов: ${updates.length}`
  );

  try {
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
    // 1. Скачиваем актуальный master.md
    // --------------------------------------------------------

    const currentMarkdown =
      await downloadTextFile(
        activeMasterInstructionUrl
      );

    const currentVersion =
      extractMasterInstructionVersion(
        currentMarkdown
      );

    if (!currentVersion) {
      throw new Error(
        "Не удалось определить текущую версию мастер-инструкции по строке **Версия:**"
      );
    }

    const newVersion =
      incrementVersion(
        currentVersion
      );

    const updateDate =
      formatDateRu(
        new Date()
      );

    const normalizedUpdates =
      normalizeMasterUpdates(
        updates
      );

    if (normalizedUpdates.length === 0) {
      throw new Error(
        "Нет утверждённых изменений для применения"
      );
    }

    // --------------------------------------------------------
    // 2. Применяем утверждённые изменения локально, без Claude
    // --------------------------------------------------------

    let updatedMarkdown =
      applyApprovedMasterUpdatesDeterministically(
        currentMarkdown,
        normalizedUpdates
      );

    updatedMarkdown =
      updateMasterInstructionMetadata(
        updatedMarkdown,
        currentVersion,
        newVersion,
        updateDate
      );

    updatedMarkdown =
      addMasterInstructionChangelogEntry(
        updatedMarkdown,
        newVersion,
        updateDate,
        normalizedUpdates
      );

    const returnedVersion =
      extractMasterInstructionVersion(
        updatedMarkdown
      );

    if (returnedVersion !== newVersion) {
      throw new Error(
        `После локального обновления версия мастер-инструкции некорректна: ожидалась ${newVersion}, получена ${returnedVersion || "не определена"}`
      );
    }

    const summary =
      buildMasterUpdateSummary(
        newVersion,
        normalizedUpdates
      );

    // --------------------------------------------------------
    // 3. Формируем .md и загружаем в Planfix REST API
    // --------------------------------------------------------

    const originalFilename =
      getFilenameFromUrl(
        activeMasterInstructionUrl
      );

    const newFilename =
      buildMasterInstructionFilename(
        originalFilename,
        newVersion
      );

    const fileBytes =
      new TextEncoder().encode(
        updatedMarkdown
      );

    const generatedFile = {
      arrayBuffer:
        fileBytes.buffer,

      filename:
        newFilename,

      mimeType:
        "text/markdown"
    };

    console.log(
      `[${taskNo}] Загружаю обновлённую master-инструкцию "${newFilename}" в Planfix REST API`
    );

    const planfixFileId =
      await uploadFileToPlanfixRest(
        planfixDomen,
        planfixFileUploadToken,
        generatedFile
      );

    // --------------------------------------------------------
    // 4. Финальный webhook. Claude не вызывается, поэтому usage=0
    // --------------------------------------------------------

    await sendCallback(
      masterFileCallback,
      {
        taskNo,

        userEmail:
          userEmail || null,

        success: true,

        files: [
          planfixFileId
        ],

        html:
          markdownToHtml(
            summary
          ),

        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        estimated_cost_usd: 0
      }
    );

    console.log(
      `[${taskNo}] Новая master-инструкция загружена локально, id=${planfixFileId}; callback отправлен`
    );
  } catch (error) {
    console.error(
      `[${taskNo}] processApplyMasterUpdates error:`,
      error
    );

    try {
      await sendCallback(
        masterFileCallback,
        {
          taskNo,

          userEmail:
            userEmail || null,

          success: false,

          files: [],

          html:
            markdownToHtml(
              `**Не удалось обновить мастер-инструкцию.**\n\n${error.message}`
            ),

          error:
            error.message
        }
      );
    } catch (callbackError) {
      console.error(
        "Failed to send apply error callback:",
        callbackError
      );
    }
  }
}

'''

s = s[:start] + new_process + s[end:]

# Replace sendClaudeMessagesRequest with HTTP-status-first parsing.
start = s.index('async function sendClaudeMessagesRequest(')
end = s.index('function appendSystemInstruction(', start)
new_sender = r'''async function sendClaudeMessagesRequest(
  apiKey,
  requestToClaude
) {
  const httpResponse =
    await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",

          "x-api-key":
            apiKey,

          "anthropic-version":
            "2023-06-01",

          "anthropic-beta":
            FILES_API_BETA_HEADER
        },

        body:
          JSON.stringify(
            requestToClaude
          )
      }
    );

  const responseText =
    await httpResponse.text();

  let response = null;

  try {
    response = responseText
      ? JSON.parse(
          responseText
        )
      : null;
  } catch (error) {
    if (httpResponse.ok) {
      throw new Error(
        `Claude returned invalid JSON. Status ${httpResponse.status}: ${responseText}`
      );
    }
  }

  if (!httpResponse.ok) {
    const details =
      response?.error?.message ||
      String(
        responseText || ""
      ).trim();

    throw new Error(
      `Claude API request failed: HTTP ${httpResponse.status}${
        details
          ? `: ${details.slice(0, 1000)}`
          : ""
      }`
    );
  }

  return {
    httpResponse,
    response
  };
}

'''
s = s[:start] + new_sender + s[end:]

# Add deterministic apply helpers before master URL normalization.
marker = '// ============================================================\n// НОРМАЛИЗАЦИЯ ССЫЛОК НА MASTER-ФАЙЛЫ\n// ============================================================'
pos = s.index(marker)
helpers = r'''// ============================================================
// ДЕТЕРМИНИРОВАННОЕ ПРИМЕНЕНИЕ MASTER-UPDATES
// ============================================================

function escapeRegExp(
  value
) {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function buildWhitespaceFlexibleRegExp(
  value,
  flags = "g"
) {
  const source =
    String(value)
      .trim()
      .split(/\s+/)
      .map(escapeRegExp)
      .join("\\s+");

  return new RegExp(
    source,
    flags
  );
}

function replaceApprovedRuleUniquely(
  markdown,
  currentText,
  proposedText,
  section
) {
  const exactCount =
    markdown.split(
      currentText
    ).length - 1;

  if (exactCount === 1) {
    return markdown.replace(
      currentText,
      proposedText
    );
  }

  if (exactCount > 1) {
    throw new Error(
      `Раздел "${section}": currentText найден более одного раза; автоматическая замена остановлена`
    );
  }

  const flexiblePattern =
    buildWhitespaceFlexibleRegExp(
      currentText,
      "g"
    );

  const matches = [
    ...markdown.matchAll(
      flexiblePattern
    )
  ];

  if (matches.length !== 1) {
    throw new Error(
      `Раздел "${section}": currentText не найден однозначно (совпадений: ${matches.length})`
    );
  }

  const match = matches[0];
  const start = match.index;
  const end =
    start + match[0].length;

  return (
    markdown.slice(
      0,
      start
    ) +
    proposedText +
    markdown.slice(
      end
    )
  );
}

function normalizeHeadingText(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /[*_`~]/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .toLowerCase();
}

function insertApprovedRuleIntoSection(
  markdown,
  section,
  proposedText
) {
  const headingPattern =
    /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;

  const headings = [];
  let match;

  while (
    (match = headingPattern.exec(
      markdown
    )) !== null
  ) {
    headings.push({
      start: match.index,
      end:
        match.index +
        match[0].length,
      level:
        match[1].length,
      text:
        match[2]
    });
  }

  const wanted =
    normalizeHeadingText(
      section
    );

  const matching =
    headings.filter(
      (heading) =>
        normalizeHeadingText(
          heading.text
        ) === wanted
    );

  if (matching.length !== 1) {
    throw new Error(
      `Раздел "${section}" не найден однозначно для добавления нового правила (совпадений: ${matching.length})`
    );
  }

  const heading =
    matching[0];

  const headingIndex =
    headings.indexOf(
      heading
    );

  let insertionPoint =
    markdown.length;

  for (
    let i = headingIndex + 1;
    i < headings.length;
    i += 1
  ) {
    if (
      headings[i].level <=
      heading.level
    ) {
      insertionPoint =
        headings[i].start;
      break;
    }
  }

  const before =
    markdown
      .slice(
        0,
        insertionPoint
      )
      .replace(
        /\s*$/,
        ""
      );

  const after =
    markdown
      .slice(
        insertionPoint
      )
      .replace(
        /^\s*/,
        ""
      );

  return (
    `${before}\n\n${proposedText.trim()}\n\n` +
    after
  );
}

function applyApprovedMasterUpdatesDeterministically(
  markdown,
  updates
) {
  let result =
    String(
      markdown || ""
    );

  for (
    const update of updates
  ) {
    if (update.currentText) {
      result =
        replaceApprovedRuleUniquely(
          result,
          update.currentText,
          update.proposedText,
          update.section
        );
    } else {
      result =
        insertApprovedRuleIntoSection(
          result,
          update.section,
          update.proposedText
        );
    }
  }

  return result;
}

function updateMasterInstructionMetadata(
  markdown,
  currentVersion,
  newVersion,
  updateDate
) {
  let result =
    String(markdown);

  const versionPatterns = [
    /(\*\*Версия:\*\*\s*)[0-9]+(?:\.[0-9]+)+/i,
    /(Версия:\s*)[0-9]+(?:\.[0-9]+)+/i,
    /(\bversion\s*:?\s*v?)[0-9]+(?:\.[0-9]+)+/i
  ];

  let versionUpdated = false;

  for (
    const pattern of versionPatterns
  ) {
    if (pattern.test(result)) {
      result =
        result.replace(
          pattern,
          `$1${newVersion}`
        );
      versionUpdated = true;
      break;
    }
  }

  if (!versionUpdated) {
    throw new Error(
      `Не удалось заменить версию ${currentVersion} на ${newVersion}`
    );
  }

  const datePatterns = [
    /(\*\*(?:Дата актуализации|Актуализировано|Дата):\*\*\s*)\d{2}\.\d{2}\.\d{4}/i,
    /((?:Дата актуализации|Актуализировано|Дата):\s*)\d{2}\.\d{2}\.\d{4}/i
  ];

  let dateUpdated = false;

  for (
    const pattern of datePatterns
  ) {
    if (pattern.test(result)) {
      result =
        result.replace(
          pattern,
          `$1${updateDate}`
        );
      dateUpdated = true;
      break;
    }
  }

  if (!dateUpdated) {
    const versionLinePattern =
      /^(.*(?:Версия|version).*?)$/im;

    const versionLine =
      result.match(
        versionLinePattern
      );

    if (versionLine) {
      const insertAt =
        versionLine.index +
        versionLine[0].length;

      result =
        result.slice(
          0,
          insertAt
        ) +
        `\n**Дата актуализации:** ${updateDate}` +
        result.slice(
          insertAt
        );
    }
  }

  return result;
}

function buildMasterChangelogLines(
  updates
) {
  return updates.map(
    (update) => {
      const action =
        update.currentText
          ? "Изменён"
          : "Добавлен";

      const reason =
        update.reason
          ? ` — ${update.reason}`
          : "";

      return `- ${action} раздел **${update.section}**${reason}`;
    }
  );
}

function addMasterInstructionChangelogEntry(
  markdown,
  newVersion,
  updateDate,
  updates
) {
  const lines =
    buildMasterChangelogLines(
      updates
    );

  const block =
    `### Версия ${newVersion} — ${updateDate}\n${lines.join("\n")}\n`;

  const changelogPattern =
    /^(#{1,6})[ \t]+(?:История изменений|Changelog|История версий|Изменения версий)[ \t]*$/im;

  const match =
    markdown.match(
      changelogPattern
    );

  if (match) {
    const insertAt =
      match.index +
      match[0].length;

    return (
      markdown.slice(
        0,
        insertAt
      ) +
      `\n\n${block}` +
      markdown
        .slice(
          insertAt
        )
        .replace(
          /^\s*/,
          "\n"
        )
    );
  }

  const metadataDatePattern =
    /^.*(?:Дата актуализации|Актуализировано|Дата):.*$/im;

  const dateLine =
    markdown.match(
      metadataDatePattern
    );

  if (dateLine) {
    const insertAt =
      dateLine.index +
      dateLine[0].length;

    return (
      markdown.slice(
        0,
        insertAt
      ) +
      `\n\n## История изменений\n\n${block}` +
      markdown.slice(
        insertAt
      )
    );
  }

  return (
    `## История изменений\n\n${block}\n` +
    markdown
  );
}

function buildMasterUpdateSummary(
  newVersion,
  updates
) {
  const lines =
    updates.map(
      (update) =>
        `- ${
          update.currentText
            ? "Изменён"
            : "Добавлен"
        } раздел **${update.section}**${
          update.reason
            ? `: ${update.reason}`
            : ""
        }`
    );

  return (
    `**Мастер-инструкция обновлена до версии ${newVersion}.**\n\n` +
    lines.join("\n")
  );
}

'''
s = s[:pos] + helpers + s[pos:]

path.write_text(s, encoding='utf-8')
