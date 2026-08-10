// ============================================================
// ВЕРСИЯ ПРИЛОЖЕНИЯ
// ============================================================
// Порядковый номер + дата правки. Обновляйте вручную при каждом
// значимом изменении index.js — так в комментариях Planfix и
// через GET-запрос всегда видно, какая именно версия задеплоена.
const APP_VERSION = "30-2026-08-10";

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
        history,
        planfixFileUploadToken,
        planfixDomen,
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

      // Не обрабатываем запрос напрямую — ctx.waitUntil() имеет
      // жёсткий потолок в 30 секунд после ответа, а тяжёлые
      // запросы (несколько файлов, code execution) в него не
      // укладываются. Вместо этого кладём задачу в очередь —
      // у consumer'а лимит уже до 15 минут — и сразу отвечаем
      // Planfix, чтобы он не ждал и не получил timeout.
      await env.TASK_QUEUE.send({
        apiKey,
        callback,
        taskNo,
        userEmail,
        files,
        rawRequest,
        history,
        planfixFileUploadToken,
        planfixDomen,
        claudeRequest
      });

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
  },

  // Consumer очереди: забирает задачи, поставленные в fetch(),
  // и выполняет всю тяжёлую работу без ограничения в 30 секунд
  // (лимит на обработку сообщения очереди — до 15 минут).
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const taskPayload = message.body;
      console.log(
        `[${taskPayload.taskNo}] Забран из очереди, начинаю обработку`
      );
      try {
        await processClaudeRequest(taskPayload);
      } catch (error) {
        // processClaudeRequest сам ловит и обрабатывает свои
        // ошибки (шлёт error-колбэк в Planfix) — сюда долетит
        // только что-то совсем неожиданное. Логируем, но не
        // даём Cloudflare повторить сообщение: повтор означал бы
        // повторный вызов Claude API и повторную загрузку файлов
        // в Planfix — второй платный проход по тому же запросу.
        console.error(
          `[${taskPayload.taskNo}] Необработанная ошибка в queue-consumer:`,
          error
        );
      }
      message.ack();
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
  history,
  planfixFileUploadToken,
  planfixDomen,
  claudeRequest
}) {
  // Сюда сохраним то, что реально отправили в Claude,
  // чтобы вернуть это в колбэк для фиксации в Planfix.
  let sentRequest = null;

  console.log(`[${taskNo}] Старт обработки, файлов на входе: ${Array.isArray(files) ? files.length : 0}`);

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
            console.log(`[${taskNo}] Скачан входной файл: ${file.name}`);
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
    // 2. Строим настоящий многоходовый messages — вместо того,
    // чтобы доверять готовому полю от Planfix (там раньше вся
    // история была склеена текстом в одну user-реплику, из-за
    // чего Claude иногда путал "свой прошлый ответ" с чужим
    // текстом, переданным на проверку). Роль "кто это сказал"
    // теперь задаётся структурой messages, а не текстовой меткой.
    // --------------------------------------------------------
    const historyTurns = parseHistoryToTurns(history);
    const messages = buildMessagesFromHistory(
      historyTurns,
      rawRequest || "",
      fileBlocks
    );

    // --------------------------------------------------------
    // 3. Формируем запрос Claude
    // --------------------------------------------------------
    const requestToClaude = {
      ...claudeRequest,
      messages
    };

    // Всегда включаем code execution — без него Claude не сможет
    // создать файл в ответ (например, PDF-отчёт), даже если
    // попросить об этом текстом, независимо от того, есть ли
    // вложения в текущем запросе. Версия 20250825 — та, что
    // реально поддерживается на всех моделях, включая Haiku 4.5
    // (в отличие от 20260120).
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
    console.log(`[${taskNo}] Отправляю запрос в Claude API (модель: ${requestToClaude.model}, max_tokens: ${requestToClaude.max_tokens})`);

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

    console.log(`[${taskNo}] Ответ от Claude получен, HTTP ${claudeResponse.status}, stop_reason: ${response?.stop_reason}`);

    // --------------------------------------------------------
    // 6. Если Claude вернул ошибку
    // --------------------------------------------------------
    if (!claudeResponse.ok) {
      console.log(`[${taskNo}] Claude вернул ошибку, отправляю error-колбэк`);
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
      console.log(`[${taskNo}] Error-колбэк отправлен`);
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
    // 7.1. Ищем файлы, сгенерированные Claude (code execution),
    // и загружаем каждый в Planfix через REST API — получаем
    // числовой ID на каждый файл.
    // --------------------------------------------------------
    const uploadedFileIds = [];
    const fileDeliveryErrors = [];
    const generatedFileIds = findGeneratedFileIds(response);
    console.log(`[${taskNo}] Найдено сгенерированных файлов в ответе: ${generatedFileIds.length}`);

    for (const fileId of generatedFileIds) {
      let generatedFile;
      try {
        console.log(`[${taskNo}] Скачиваю сгенерированный файл у Claude: ${fileId}`);
        generatedFile = await downloadGeneratedFile(fileId, apiKey);
        console.log(`[${taskNo}] Скачан: ${generatedFile.filename} (${generatedFile.arrayBuffer.byteLength} байт)`);
      } catch (error) {
        fileDeliveryErrors.push(
          `Не удалось скачать файл ${fileId} у Claude: ${error.message}`
        );
        console.error(
          "Failed to download generated file:",
          fileId,
          error
        );
        continue;
      }

      if (!planfixFileUploadToken || !planfixDomen) {
        fileDeliveryErrors.push(
          `Файл "${generatedFile.filename}" сгенерирован, но planfixFileUploadToken/planfixDomen не переданы — загрузить в Planfix нечем`
        );
        continue;
      }

      try {
        console.log(`[${taskNo}] Загружаю "${generatedFile.filename}" в Planfix REST API`);
        const planfixFileId = await uploadFileToPlanfixRest(
          planfixDomen,
          planfixFileUploadToken,
          generatedFile
        );
        uploadedFileIds.push({
          id: planfixFileId,
          name: generatedFile.filename
        });
        console.log(`[${taskNo}] Загружен в Planfix, id: ${planfixFileId}`);
      } catch (error) {
        fileDeliveryErrors.push(
          `Planfix REST API отклонил файл "${generatedFile.filename}": ${error.message}`
        );
        console.error(
          "Failed to upload generated file to Planfix REST API:",
          error
        );
      }
    }

    const fileDeliveryError =
      fileDeliveryErrors.length > 0 ? fileDeliveryErrors.join(" | ") : null;

    // --------------------------------------------------------
    // 7.2. Дописываем в текст ответа явную, машиночитаемую
    // метку о созданных файлах — не полагаемся на то, что
    // Claude сам не забудет упомянуть имя файла. Эта метка
    // попадёт в историю диалога и при следующем вызове Claude
    // однозначно прочитает её как СВОЮ реплику: "я создал этот
    // файл", а не как файл, переданный ему пользователем.
    // --------------------------------------------------------
    let claudeTextWithFileNote = claudeText;
    if (uploadedFileIds.length > 0) {
      const fileNames = uploadedFileIds.map((f) => f.name).join(", ");
      claudeTextWithFileNote +=
        `\n\n[Файл${uploadedFileIds.length > 1 ? "ы" : ""}, созданны${uploadedFileIds.length > 1 ? "е" : "й"} мной в этом ответе: ${fileNames}]`;
    }

    // --------------------------------------------------------
    // 8. Markdown → HTML для Planfix
    // --------------------------------------------------------
    const html = markdownToHtml(claudeTextWithFileNote);

    // --------------------------------------------------------
    // Шаг 2: отправляем текст ответа Claude + собранные ID
    // файлов одним JSON-колбэком на answer_to_task.
    // --------------------------------------------------------
    console.log(`[${taskNo}] Отправляю финальный колбэк на ${callback}`);
    await sendCallback(callback, {
      taskNo,
      userEmail: userEmail || null,
      success: true,
      status: claudeResponse.status,
      app_version: APP_VERSION,
      request: sentRequest,
      raw_request: rawRequest,
      html,
      text: claudeTextWithFileNote,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      total_tokens: usage.total_tokens,
      estimated_cost_usd: estimatedCostUsd,
      files: uploadedFileIds.map((f) => f.id),
      file_delivery_error: fileDeliveryError,
      response
    });
    console.log(`[${taskNo}] Финальный колбэк отправлен успешно`);
  } catch (error) {
    console.error(`[${taskNo}] processClaudeRequest error:`, error);

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
      console.log(`[${taskNo}] Error-колбэк из catch отправлен`);
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

// Рекурсивно ищем ВСЕ file_id в ответе Claude, не привязываясь
// к конкретному имени вложенного блока — у разных версий code
// execution tool структура может отличаться. Дубли не добавляем.
function findGeneratedFileIds(response) {
  if (!response || !Array.isArray(response.content)) {
    return [];
  }

  const found = [];

  function search(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    if (
      typeof node.file_id === "string" &&
      !found.includes(node.file_id)
    ) {
      found.push(node.file_id);
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          search(item);
        }
      } else if (value && typeof value === "object") {
        search(value);
      }
    }
  }

  for (const block of response.content) {
    search(block);
  }

  return found;
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

async function downloadGeneratedFile(fileId, apiKey) {
  const [metadata, arrayBuffer] = await Promise.all([
    fetchGeneratedFileMetadata(fileId, apiKey),
    fetchGeneratedFileContent(fileId, apiKey)
  ]);

  return {
    arrayBuffer,
    filename: metadata.filename || "file",
    mimeType: metadata.mime_type || "application/octet-stream"
  };
}

// ============================================================
// ОТПРАВКА СГЕНЕРИРОВАННОГО ФАЙЛА В PLANFIX
// ============================================================
// Отдельный вебхук Planfix (не тот же, что answer_to_task) —
// принимает файлы только как multipart/form-data, с полями
// taskNo (текст, чтобы автосценарий нашёл нужную задачу) и
// file (сами байты, НЕ base64).
// Собираем multipart/form-data вручную, с полным контролем над
// заголовком Content-Type и границей (boundary). Встроенный
// FormData в Cloudflare Workers формирует Content-Type
// автоматически, и в паре с сервером Planfix (Jetty) это
// привело к 415 Unsupported Media Type — сервер не распознал
// заголовок. Ручная сборка убирает эту неопределённость.
function buildMultipartBody(fields, file) {
  const boundary =
    "----ClaudeWorkerBoundary" +
    crypto.randomUUID().replace(/-/g, "");
  const encoder = new TextEncoder();
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      )
    );
  }

  parts.push(
    encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.mimeType}\r\n\r\n`
    )
  );
  parts.push(new Uint8Array(file.arrayBuffer));
  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const totalLength = parts.reduce(
    (sum, part) => sum + part.byteLength,
    0
  );
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }

  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// Загружаем файл напрямую через Planfix REST API v2:
// POST /rest/file/ — multipart с полем "file", в ответ приходит
// {"id": <fileId>}, который потом можно использовать в других
// вызовах REST API (например, прикрепить к комментарию).
//
// ВАЖНО: имя multipart-поля ("file") взято из общей схемы
// Planfix REST API v2 и генерируемых SDK — если Planfix вернёт
// ошибку про неизвестное поле, смотрите точный текст ошибки в
// file_delivery_error и сверьтесь с интерактивной документацией
// (кнопка "Try it out" на help.planfix.com).
async function uploadFileToPlanfixRest(
  planfixDomen,
  planfixFileUploadToken,
  generatedFile
) {
  // planfixDomen может прийти и как просто домен ("seppra.planfix.ru"),
  // и как полный URL ("https://seppra.planfix.ru/") — приводим
  // к единому виду и убираем хвостовые слэши, чтобы не получить
  // двойной "//rest".
  const normalizedDomen = /^https?:\/\//i.test(planfixDomen)
    ? planfixDomen
    : `https://${planfixDomen}`;
  const apiBase = `${normalizedDomen.replace(/\/+$/, "")}/rest`;

  const { body, contentType } = buildMultipartBody(
    {},
    generatedFile
  );

  const response = await fetch(`${apiBase}/file/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${planfixFileUploadToken}`,
      "content-type": contentType
    },
    body
  });

  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${responseBody}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(responseBody);
  } catch (error) {
    throw new Error(
      `Planfix вернул не-JSON ответ: ${responseBody}`
    );
  }

  if (!parsed.id) {
    throw new Error(
      `В ответе Planfix нет поля id: ${responseBody}`
    );
  }

  return parsed.id;
}

// ============================================================
// РАЗБОР ИСТОРИИ ПЕРЕПИСКИ В ЧЕРЕДУЮЩИЕСЯ РЕПЛИКИ
// ============================================================
// Planfix присылает историю одним HTML-текстом с метками
// "[Вопрос]:" / "[Ответ]:". Разбираем на упорядоченный список
// {role, text} — это и есть основа для настоящего messages.
function parseHistoryToTurns(history) {
  const rawTurns = getRawHistoryTurns(history);

  // Claude API требует строгого чередования ролей — если в
  // истории оказалось два вопроса подряд без ответа (бывает,
  // если сотрудник написал несколько комментариев до того как
  // пришёл предыдущий ответ), склеиваем их в одну реплику.
  const merged = [];
  for (const turn of rawTurns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.text += "\n\n" + turn.text;
    } else {
      merged.push({ role: turn.role, text: turn.text });
    }
  }

  return merged;
}

// Принимает историю в двух форматах:
// 1. Массив [{role, text}, ...] — предпочтительный, структурный,
//    Planfix сам явно указывает роль (см. пример формулы с
//    ДЛЯКАЖДОГО и JSON-объектом на каждой итерации).
// 2. Строка с метками "[Вопрос]:"/"[Ответ]:" — старый формат,
//    оставлен для обратной совместимости.
function getRawHistoryTurns(history) {
  if (Array.isArray(history)) {
    // Формат 1: сырой дамп аналитики Planfix (как отдаёт
    // системная сериализация — например, вся аналитика задачи
    // целиком). Отличаем по наличию поля "analitic" у элементов.
    if (
      history.length > 0 &&
      history[0] &&
      typeof history[0] === "object" &&
      history[0].analitic
    ) {
      return parseAnalyticsHistoryToTurns(history);
    }

    // Формат 2: уже готовый массив {role, text}, собранный
    // formula-строкой в Planfix (ДЛЯКАЖДОГО + JSON-объект).
    return history
      .filter(
        (turn) =>
          turn && typeof turn.text === "string" && turn.text.trim()
      )
      .map((turn) => ({
        role: turn.role === "assistant" ? "assistant" : "user",
        text: stripHtmlToPlainText(turn.text)
      }))
      .filter((turn) => turn.text);
  }

  if (!history || typeof history !== "string") {
    return [];
  }

  const parts = history.split(/(\[Вопрос\]:|\[Ответ\]:)/);
  const rawTurns = [];
  let currentRole = null;
  let buffer = "";

  const flush = () => {
    const clean = stripHtmlToPlainText(buffer);
    if (currentRole && clean) {
      rawTurns.push({ role: currentRole, text: clean });
    }
    buffer = "";
  };

  for (const part of parts) {
    if (part === "[Вопрос]:") {
      flush();
      currentRole = "user";
    } else if (part === "[Ответ]:") {
      flush();
      currentRole = "assistant";
    } else {
      buffer += part;
    }
  }
  flush();

  return rawTurns;
}

// Разбирает сырой дамп аналитики задачи Planfix (массив объектов
// вида {analitic: {name}, data: [{name, value}, ...]}) — находит
// записи "Диалог с ИИ", достаёт "Тип" и "Текст", сортирует по
// "Дата и время" (Planfix может отдавать не в хронологическом
// порядке — в наблюдавшихся примерах было от новых к старым).
function parseAnalyticsHistoryToTurns(analyticsData) {
  const dialogEntries = analyticsData.filter(
    (entry) => entry?.analitic?.name === "Диалог с ИИ"
  );

  const getFieldValue = (fields, name) => {
    const field = Array.isArray(fields)
      ? fields.find((f) => f && f.name === name)
      : null;
    return field ? String(field.value ?? "") : "";
  };

  // "10-08-2026 11:52" -> "202608101152" — строка, по которой
  // можно сравнивать хронологически через localeCompare.
  const toSortableDateTime = (value) => {
    const match = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(
      value
    );
    if (!match) {
      return "";
    }
    const [, dd, mm, yyyy, hh, min] = match;
    return `${yyyy}${mm}${dd}${hh}${min}`;
  };

  const extracted = dialogEntries.map((entry) => {
    const type = getFieldValue(entry.data, "Тип");
    const text = getFieldValue(entry.data, "Текст");
    const dateTime = getFieldValue(entry.data, "Дата и время");
    return {
      role: type === "Вопрос" ? "user" : "assistant",
      text: stripHtmlToPlainText(text),
      sortKey: toSortableDateTime(dateTime)
    };
  });

  extracted.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return extracted
    .filter((turn) => turn.text)
    .map((turn) => ({ role: turn.role, text: turn.text }));
}

function stripHtmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// СБОРКА MESSAGES ИЗ РАЗОБРАННОЙ ИСТОРИИ
// ============================================================
// Файлы (чертёж, мастер-инструкция) прикладываются к первой
// user-реплике — Claude видит их в контексте на протяжении
// всего разговора в рамках одного вызова API, независимо от
// того, к какой именно реплике они формально приложены.
function buildMessagesFromHistory(historyTurns, currentQuestion, fileBlocks) {
  const messages = [];
  let filesAttached = false;

  const pushTurn = (role, contentBlocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content = last.content.concat(contentBlocks);
    } else {
      messages.push({ role, content: contentBlocks });
    }
  };

  historyTurns.forEach((turn, index) => {
    const blocks = [];
    if (index === 0 && turn.role === "user" && fileBlocks.length > 0) {
      blocks.push(...fileBlocks);
      filesAttached = true;
    }
    blocks.push({ type: "text", text: turn.text });
    pushTurn(turn.role, blocks);
  });

  const finalBlocks = [];
  if (!filesAttached) {
    finalBlocks.push(...fileBlocks);
  }
  finalBlocks.push({ type: "text", text: currentQuestion });
  pushTurn("user", finalBlocks);

  return messages;
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
      // @@ вместо ___ — ___X___ совпадает с markdown-паттерном
      // "жирный курсив" ниже и случайно съедался им раньше времени.
      return `@@CLAUDE_CODE_BLOCK_${index}@@`;
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
      `@@CLAUDE_CODE_BLOCK_${index}@@`,
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
