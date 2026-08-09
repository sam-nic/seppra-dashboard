// ============================================================
// ВЕРСИЯ ПРИЛОЖЕНИЯ
// ============================================================
// Порядковый номер + дата правки. Обновляйте вручную при каждом
// значимом изменении index.js — так в комментариях Planfix и
// через GET-запрос всегда видно, какая именно версия задеплоена.
const APP_VERSION = "16-2026-08-09";

export default {
  async fetch(request, env, ctx) {
    // Лёгкий health-check — открыть просто в браузере,
    // чтобы убедиться, какая версия кода сейчас на проде.
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        worker: "seppra-dashboard",
        app_version: APP_VERSION
      });
    }

    // Разрешаем только POST
    if (request.method !== "POST") {
      return jsonResponse(
        {
          success: false,
          error: "Method not allowed"
        },
        405
      );
    }

    try {
      const input = await readSanitizedJson(request);

      const {
        apiKey,
        callback,
        taskNo,
        userEmail,
        files = [],
        rawRequest,
        ...claudeRequest
      } = input;

      // -----------------------------
      // Проверяем обязательные поля
      // -----------------------------
      if (!apiKey) {
        return jsonResponse(
          {
            success: false,
            error: "apiKey is required"
          },
          400
        );
      }

      if (!callback) {
        return jsonResponse(
          {
            success: false,
            error: "callback is required"
          },
          400
        );
      }

      if (!taskNo) {
        return jsonResponse(
          {
            success: false,
            error: "taskNo is required"
          },
          400
        );
      }

      // Сразу отвечаем Planfix, чтобы он не ждал Claude
      // и не получил timeout.
      ctx.waitUntil(
        processClaudeRequest({
          apiKey,
          callback,
          taskNo,
          userEmail,
          files,
          rawRequest,
          claudeRequest
        })
      );

      return jsonResponse({
        success: true,
        taskNo,
        userEmail: userEmail || null,
        accepted: true
      });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error.message
        },
        500
      );
    }
  }
};

// ============================================================
// ОСНОВНАЯ ОБРАБОТКА
// ============================================================
async function processClaudeRequest({
  apiKey,
  callback,
  taskNo,
  userEmail,
  files,
  rawRequest,
  claudeRequest
}) {
  // Сюда сохраним то, что реально отправили в Claude,
  // чтобы вернуть это в колбэк для фиксации в Planfix.
  let sentRequest = null;

  try {
    // --------------------------------------------------------
    // 1. Подготавливаем файлы
    // --------------------------------------------------------
    const fileBlocks = [];

    if (Array.isArray(files)) {
      for (const file of files) {
        if (!file || !file.url) {
          continue;
        }

        try {
          const block = await downloadFileForClaude(file);
          if (block) {
            fileBlocks.push(block);
          }
        } catch (error) {
          console.error(
            `Failed to download file "${file.name || file.url}":`,
            error
          );
        }
      }
    }

    // --------------------------------------------------------
    // 2. Добавляем файлы в первое user-сообщение
    // --------------------------------------------------------
    const messages = Array.isArray(claudeRequest.messages)
      ? structuredClone(claudeRequest.messages)
      : [];

    if (fileBlocks.length > 0) {
      const userMessage = messages.find(
        (message) => message.role === "user"
      );

      if (userMessage) {
        if (typeof userMessage.content === "string") {
          userMessage.content = [
            ...fileBlocks,
            {
              type: "text",
              text: userMessage.content
            }
          ];
        } else if (Array.isArray(userMessage.content)) {
          userMessage.content = [
            ...fileBlocks,
            ...userMessage.content
          ];
        }
      }
    }

    // --------------------------------------------------------
    // 3. Формируем запрос Claude
    // --------------------------------------------------------
    const requestToClaude = {
      ...claudeRequest,
      messages
    };

    // При наличии вложений автоматически включаем code execution —
    // без него Claude не сможет создать файл в ответ (например,
    // PDF-отчёт), даже если попросить об этом текстом. Версия
    // 20250825 — та, что реально поддерживается на всех моделях,
    // включая Haiku 4.5 (в отличие от 20260120).
    if (Array.isArray(files) && files.length > 0) {
      const existingTools = Array.isArray(requestToClaude.tools)
        ? requestToClaude.tools
        : [];

      const alreadyHasCodeExecution = existingTools.some(
        (tool) => tool && tool.name === "code_execution"
      );

      if (!alreadyHasCodeExecution) {
        requestToClaude.tools = [
          ...existingTools,
          { type: "code_execution_20250825", name: "code_execution" }
        ];
      }
    }

    // Что реально отправили в Claude — для колбэка в Planfix.
    // Содержимое файлов (base64) заменяем меткой, чтобы не
    // раздувать вебхук — сам факт и тип вложения сохраняем.
    sentRequest = {
      ...requestToClaude,
      messages: stripFileData(messages)
    };

    // --------------------------------------------------------
    // 4. Отправляем запрос Claude
    // --------------------------------------------------------
    const claudeResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Нужен, чтобы Claude мог создавать файлы через
          // code execution tool, а мы могли их потом скачать.
          "anthropic-beta": FILES_API_BETA_HEADER
        },
        body: JSON.stringify(requestToClaude)
      }
    );

    // --------------------------------------------------------
    // 5. Получаем ответ Claude
    // --------------------------------------------------------
    let response;
    try {
      response = await claudeResponse.json();
    } catch (error) {
      const rawText = await claudeResponse.text();
      throw new Error(
        `Claude returned invalid JSON. Status ${claudeResponse.status}: ${rawText}`
      );
    }

    // --------------------------------------------------------
    // 6. Если Claude вернул ошибку
    // --------------------------------------------------------
    if (!claudeResponse.ok) {
      await sendCallback(callback, {
        taskNo,
        userEmail: userEmail || null,
        success: false,
        status: claudeResponse.status,
        app_version: APP_VERSION,
        request: sentRequest,
        raw_request: rawRequest,
        error:
          response?.error?.message ||
          "Claude API request failed",
        response
      });
      return;
    }

    // --------------------------------------------------------
    // 7. Извлекаем текстовые блоки и usage Claude
    // --------------------------------------------------------
    const claudeText = extractClaudeText(response);
    const usage = extractUsage(response);
    const estimatedCostUsd = estimateCostUsd(
      requestToClaude.model,
      usage
    );

    // --------------------------------------------------------
    // 7.1. Ищем файл, сгенерированный Claude (code execution),
    // и скачиваем его. Пока обрабатываем только первый найденный
    // — поддержка нескольких файлов за раз пока не тестировалась.
    // --------------------------------------------------------
    let generatedFile = null;
    const generatedFileId = findGeneratedFileId(response);
    if (generatedFileId) {
      try {
        generatedFile = await downloadGeneratedFileAsBase64(
          generatedFileId,
          apiKey
        );
      } catch (error) {
        console.error(
          "Failed to download generated file:",
          generatedFileId,
          error
        );
      }
    }

    // --------------------------------------------------------
    // 8. Markdown → HTML для Planfix
    // --------------------------------------------------------
    const html = markdownToHtml(claudeText);

    // --------------------------------------------------------
    // 9. Callback в Planfix
    // --------------------------------------------------------
    await sendCallback(callback, {
      taskNo,
      userEmail: userEmail || null,
      success: true,
      status: claudeResponse.status,
      app_version: APP_VERSION,
      request: sentRequest,
      raw_request: rawRequest,
      html,
      text: claudeText,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      total_tokens: usage.total_tokens,
      estimated_cost_usd: estimatedCostUsd,
      file1: generatedFile ? generatedFile.base64 : null,
      file1_name: generatedFile ? generatedFile.filename : null,
      file1_mime_type: generatedFile ? generatedFile.mimeType : null,
      response
    });
  } catch (error) {
    console.error("processClaudeRequest error:", error);

    // Даже при внутренней ошибке стараемся сообщить Planfix
    try {
      await sendCallback(callback, {
        taskNo,
        userEmail: userEmail || null,
        success: false,
        app_version: APP_VERSION,
        request: sentRequest,
        raw_request: rawRequest,
        error: error.message
      });
    } catch (callbackError) {
      console.error(
        "Failed to send error callback:",
        callbackError
      );
    }
  }
}

// ============================================================
// СКАЧИВАНИЕ ФАЙЛА ИЗ PLANFIX
// ============================================================
async function downloadFileForClaude(file) {
  const response = await fetch(file.url, {
    method: "GET",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `File download failed: HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  if (arrayBuffer.byteLength === 0) {
    throw new Error("Downloaded file is empty");
  }

  const declaredType = normalizeContentType(
    response.headers.get("content-type")
  );
  const extensionType = getMimeTypeFromFilename(file.name);
  const contentType =
    declaredType || extensionType || "application/octet-stream";

  // ----------------------------------------------------------
  // Текстовые файлы (мастер-инструкции, .md, .txt) — передаём
  // как обычный текстовый блок, без base64. Проверяем и
  // заголовок, и расширение отдельно: Planfix нередко отдаёт
  // .md с заголовком application/octet-stream, а не text/markdown.
  // ----------------------------------------------------------
  const isTextFile =
    declaredType === "text/markdown" ||
    declaredType === "text/x-markdown" ||
    declaredType === "application/markdown" ||
    declaredType === "text/plain" ||
    extensionType === "text/markdown" ||
    extensionType === "text/plain";

  if (isTextFile) {
    const text = new TextDecoder("utf-8").decode(arrayBuffer);
    return {
      type: "text",
      text: `Файл "${file.name || "без имени"}":\n\n${text}`
    };
  }

  const base64 = arrayBufferToBase64(arrayBuffer);

  // ----------------------------------------------------------
  // PDF
  // ----------------------------------------------------------
  if (contentType === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: base64
      }
    };
  }

  // ----------------------------------------------------------
  // Изображения
  // ----------------------------------------------------------
  if (
    contentType === "image/jpeg" ||
    contentType === "image/png" ||
    contentType === "image/gif" ||
    contentType === "image/webp"
  ) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: contentType,
        data: base64
      }
    };
  }

  // ----------------------------------------------------------
  // Остальные форматы пока не передаём Claude напрямую
  // ----------------------------------------------------------
  console.warn(
    `Unsupported Claude file type: ${contentType}, file: ${file.name || ""}`
  );
  return null;
}

// ============================================================
// ARRAYBUFFER → BASE64
// ============================================================
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(
      i,
      Math.min(i + chunkSize, bytes.length)
    );
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// ============================================================
// MIME TYPE
// ============================================================
function normalizeContentType(contentType) {
  if (!contentType) {
    return null;
  }
  return contentType
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function getMimeTypeFromFilename(filename) {
  if (!filename) {
    return null;
  }

  const name = filename.toLowerCase();

  if (name.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (name.endsWith(".png")) {
    return "image/png";
  }
  if (
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg")
  ) {
    return "image/jpeg";
  }
  if (name.endsWith(".gif")) {
    return "image/gif";
  }
  if (name.endsWith(".webp")) {
    return "image/webp";
  }
  if (name.endsWith(".md")) {
    return "text/markdown";
  }
  if (name.endsWith(".txt")) {
    return "text/plain";
  }

  return null;
}

// ============================================================
// ФАЙЛЫ, СГЕНЕРИРОВАННЫЕ CLAUDE (CODE EXECUTION / FILES API)
// ============================================================
// Требует beta-заголовка files-api-2025-04-14. Скачать можно
// только файлы, СОЗДАННЫЕ Claude (code execution/skills) — файлы,
// которые загружаем МЫ через Files API, обратно не скачиваются.
const FILES_API_BETA_HEADER = "files-api-2025-04-14";

// Рекурсивно ищем первый попавшийся file_id в ответе Claude,
// не привязываясь к конкретному имени вложенного блока —
// у разных версий code execution tool структура может отличаться.
function findGeneratedFileId(response) {
  if (!response || !Array.isArray(response.content)) {
    return null;
  }

  function search(node) {
    if (!node || typeof node !== "object") {
      return null;
    }
    if (typeof node.file_id === "string") {
      return node.file_id;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = search(item);
          if (found) return found;
        }
      } else if (value && typeof value === "object") {
        const found = search(value);
        if (found) return found;
      }
    }
    return null;
  }

  for (const block of response.content) {
    const found = search(block);
    if (found) return found;
  }

  return null;
}

async function fetchGeneratedFileMetadata(fileId, apiKey) {
  const response = await fetch(
    `https://api.anthropic.com/v1/files/${fileId}`,
    {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FILES_API_BETA_HEADER
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch file metadata: HTTP ${response.status}`
    );
  }

  return response.json();
}

async function fetchGeneratedFileContent(fileId, apiKey) {
  const response = await fetch(
    `https://api.anthropic.com/v1/files/${fileId}/content`,
    {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FILES_API_BETA_HEADER
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to download file content: HTTP ${response.status}`
    );
  }

  return response.arrayBuffer();
}

async function downloadGeneratedFileAsBase64(fileId, apiKey) {
  const [metadata, arrayBuffer] = await Promise.all([
    fetchGeneratedFileMetadata(fileId, apiKey),
    fetchGeneratedFileContent(fileId, apiKey)
  ]);

  return {
    base64: arrayBufferToBase64(arrayBuffer),
    filename: metadata.filename || null,
    mimeType: metadata.mime_type || null
  };
}

// ============================================================
// ЗАМЕНА BASE64 ФАЙЛОВ НА МЕТКУ (ДЛЯ КОЛБЭКА)
// ============================================================
function stripFileData(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map((message) => {
    if (!message || !Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((block) => {
        if (
          block &&
          (block.type === "image" || block.type === "document") &&
          block.source
        ) {
          return {
            ...block,
            source: {
              ...block.source,
              data: "[omitted]"
            }
          };
        }
        return block;
      })
    };
  });
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ТЕКСТА ИЗ ОТВЕТА CLAUDE
// ============================================================
function extractClaudeText(response) {
  if (!response || !Array.isArray(response.content)) {
    return "";
  }

  return response.content
    .filter(
      (block) =>
        block &&
        block.type === "text" &&
        typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n\n");
}

// ============================================================
// ИЗВЛЕЧЕНИЕ USAGE ИЗ ОТВЕТА CLAUDE
// ============================================================
function extractUsage(response) {
  const usage = response?.usage || {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    // Суммарно все токены запроса, во всех категориях.
    // Внимание: это НЕ то же самое, что стоимость — категории
    // оплачиваются по разным ставкам, см. estimateCostUsd().
    total_tokens:
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens
  };
}

// ============================================================
// ЦЕНЫ ЗА МИЛЛИОН ТОКЕНОВ (USD) И РАСЧЁТ СТОИМОСТИ
// ============================================================
// Обновляйте вручную при изменении тарифов Anthropic.
// Множители кэша — стандартные для всех моделей Claude:
// запись в кэш (5 минут) — 1.25x от цены input, чтение — 0.1x.
const PRICING_PER_MILLION_TOKENS = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Вводная цена Sonnet 5 действует до 31.08.2026,
  // дальше стандартная — $3 / $15.
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 }
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function estimateCostUsd(model, usage) {
  const pricing = PRICING_PER_MILLION_TOKENS[model];

  // Неизвестная модель — не считаем, чтобы не показать
  // неверную цифру вместо честного "не знаем".
  if (!pricing) {
    return null;
  }

  const cacheWritePrice = pricing.input * CACHE_WRITE_MULTIPLIER;
  const cacheReadPrice = pricing.input * CACHE_READ_MULTIPLIER;

  const costUsd =
    (usage.input_tokens * pricing.input +
      usage.output_tokens * pricing.output +
      usage.cache_creation_input_tokens * cacheWritePrice +
      usage.cache_read_input_tokens * cacheReadPrice) /
    1_000_000;

  // Округляем до 6 знаков — суммы за один запрос обычно
  // копеечные, важно не терять точность при сложении в Planfix.
  return Math.round(costUsd * 1_000_000) / 1_000_000;
}

// ============================================================
// MARKDOWN → HTML
// ============================================================
function markdownToHtml(markdown) {
  if (!markdown) {
    return "";
  }

  let text = escapeHtml(markdown);

  // ----------------------------------------------------------
  // Code blocks
  // ```code```
  // ----------------------------------------------------------
  const codeBlocks = [];
  text = text.replace(
    /```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g,
    (_, code) => {
      const index = codeBlocks.length;
      codeBlocks.push(
        `<pre><code>${code.trim()}</code></pre>`
      );
      return `___CODE_BLOCK_${index}___`;
    }
  );

  // ----------------------------------------------------------
  // Inline code
  // `code`
  // ----------------------------------------------------------
  text = text.replace(
    /`([^`\n]+)`/g,
    "<code>$1</code>"
  );

  // ----------------------------------------------------------
  // Заголовки
  // ----------------------------------------------------------
  text = text.replace(
    /^######\s+(.+)$/gm,
    "<h6>$1</h6>"
  );
  text = text.replace(
    /^#####\s+(.+)$/gm,
    "<h5>$1</h5>"
  );
  text = text.replace(
    /^####\s+(.+)$/gm,
    "<h4>$1</h4>"
  );
  text = text.replace(
    /^###\s+(.+)$/gm,
    "<h3>$1</h3>"
  );
  text = text.replace(
    /^##\s+(.+)$/gm,
    "<h2>$1</h2>"
  );
  text = text.replace(
    /^#\s+(.+)$/gm,
    "<h1>$1</h1>"
  );

  // ----------------------------------------------------------
  // Bold + italic
  // ***text***
  // ----------------------------------------------------------
  text = text.replace(
    /\*\*\*(.+?)\*\*\*/g,
    "<strong><em>$1</em></strong>"
  );
  text = text.replace(
    /___(.+?)___/g,
    "<strong><em>$1</em></strong>"
  );

  // ----------------------------------------------------------
  // Bold
  // **text**
  // ----------------------------------------------------------
  text = text.replace(
    /\*\*(.+?)\*\*/g,
    "<strong>$1</strong>"
  );
  text = text.replace(
    /__(.+?)__/g,
    "<strong>$1</strong>"
  );

  // ----------------------------------------------------------
  // Italic
  // *text*
  // _text_
  // ----------------------------------------------------------
  text = text.replace(
    /(^|[^\*])\*([^*\n]+)\*/g,
    "$1<em>$2</em>"
  );
  text = text.replace(
    /(^|[^\w])_([^_\n]+)_/g,
    "$1<em>$2</em>"
  );

  // ----------------------------------------------------------
  // Зачёркнутый текст
  // ~~text~~
  // ----------------------------------------------------------
  text = text.replace(
    /~~(.+?)~~/g,
    "<del>$1</del>"
  );

  // ----------------------------------------------------------
  // Подчёркивание
  // ++text++
  // Это не стандартный Markdown,
  // но поддерживаем на всякий случай.
  // ----------------------------------------------------------
  text = text.replace(
    /\+\+(.+?)\+\+/g,
    "<u>$1</u>"
  );

  // ----------------------------------------------------------
  // Markdown links
  // [text](url)
  // ----------------------------------------------------------
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // ----------------------------------------------------------
  // Горизонтальная линия
  // ----------------------------------------------------------
  text = text.replace(
    /^\s*(---|\*\*\*|___)\s*$/gm,
    "<hr>"
  );

  // ----------------------------------------------------------
  // Списки
  // ----------------------------------------------------------
  text = convertLists(text);

  // ----------------------------------------------------------
  // Переносы строк
  // ----------------------------------------------------------
  const blocks = text.split(/\n{2,}/);
  text = blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) {
        return "";
      }

      // Уже HTML-блок
      if (
        /^<(h[1-6]|ul|ol|pre|blockquote|hr)/i.test(
          trimmed
        )
      ) {
        return trimmed.replace(/\n/g, "");
      }

      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  // ----------------------------------------------------------
  // Возвращаем code blocks
  // ----------------------------------------------------------
  codeBlocks.forEach((code, index) => {
    text = text.replace(
      `___CODE_BLOCK_${index}___`,
      code
    );
  });

  return text;
}

// ============================================================
// MARKDOWN LISTS → HTML
// ============================================================
function convertLists(text) {
  const lines = text.split("\n");
  const output = [];
  let listType = null;

  for (const line of lines) {
    const unordered = line.match(
      /^\s*[-*+]\s+(.+)$/
    );
    const ordered = line.match(
      /^\s*\d+\.\s+(.+)$/
    );

    if (unordered) {
      if (listType !== "ul") {
        if (listType) {
          output.push(`</${listType}>`);
        }
        output.push("<ul>");
        listType = "ul";
      }
      output.push(`<li>${unordered[1]}</li>`);
      continue;
    }

    if (ordered) {
      if (listType !== "ol") {
        if (listType) {
          output.push(`</${listType}>`);
        }
        output.push("<ol>");
        listType = "ol";
      }
      output.push(`<li>${ordered[1]}</li>`);
      continue;
    }

    if (listType) {
      output.push(`</${listType}>`);
      listType = null;
    }
    output.push(line);
  }

  if (listType) {
    output.push(`</${listType}>`);
  }

  return output.join("\n");
}

// ============================================================
// HTML ESCAPE
// ============================================================
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================
// CALLBACK В PLANFIX
// ============================================================
async function sendCallback(callback, payload) {
  const response = await fetch(callback, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Planfix callback failed: HTTP ${response.status}: ${body}`
    );
  }

  return response;
}

// ============================================================
// УСТОЙЧИВЫЙ ПАРСИНГ JSON
// ============================================================
// Planfix при подстановке многострочных переменных (например,
// истории переписки) вставляет в JSON-тело сырые переносы строк
// вместо экранированных \n — это ломает JSON.parse с ошибкой
// "Bad control character in string literal". Здесь мы читаем
// тело как текст и экранируем управляющие символы, но только
// внутри строковых литералов, не трогая форматирование самого
// JSON снаружи строк.
async function readSanitizedJson(request) {
  const rawBody = await request.text();
  const sanitized = sanitizeJsonControlChars(rawBody);
  return JSON.parse(sanitized);
}

function sanitizeJsonControlChars(raw) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const code = raw.charCodeAt(i);

    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }

      if (char === "\\") {
        result += char;
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
        result += char;
        continue;
      }

      // Управляющий символ (код < 0x20) внутри строки —
      // невалиден в сыром виде, экранируем.
      if (code < 0x20) {
        switch (char) {
          case "\n":
            result += "\\n";
            break;
          case "\r":
            result += "\\r";
            break;
          case "\t":
            result += "\\t";
            break;
          default:
            result +=
              "\\u" + code.toString(16).padStart(4, "0");
        }
        continue;
      }

      result += char;
      continue;
    }

    // Вне строки — просто отслеживаем вход в строковый литерал
    if (char === '"') {
      inString = true;
    }
    result += char;
  }

  return result;
}

// ============================================================
// JSON RESPONSE
// ============================================================
function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8"
      }
    }
  );
}
