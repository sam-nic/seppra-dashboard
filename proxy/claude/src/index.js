// ============================================================
// ВЕРСИЯ ПРИЛОЖЕНИЯ
// ============================================================
// Порядковый номер + дата правки. Обновляйте вручную при каждом
// значимом изменении index.js — так в комментариях Planfix и
// через GET-запрос всегда видно, какая именно версия задеплоена.
const APP_VERSION = "48-2026-08-19";

// Специальные операции. Если operation отсутствует — это обычный
// диалог, полностью совместимый со старым форматом запросов.
const OP_REVISE_MASTER_UPDATES = "revise_master_updates";
const OP_APPLY_MASTER_UPDATES = "apply_master_updates";

// Клиентский tool: Claude использует его только тогда, когда в
// обычном диалоге действительно появились предлагаемые изменения
// мастер-инструкции. Worker не исполняет tool — он забирает
// структурированный input и отправляет его отдельным webhook'ом.
const MASTER_UPDATE_PROPOSAL_TOOL = {
  name: "propose_master_instruction_updates",
  description:
    "Используй этот tool только если по текущему диалогу действительно требуется предложить одно или несколько изменений мастер-инструкции. Передавай сразу полный набор предлагаемых изменений. Если изменения мастер-инструкции не нужны — не вызывай tool.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description:
                "Раздел мастер-инструкции, к которому относится изменение."
            },
            currentText: {
              type: "string",
              description:
                "Только точная существующая формулировка ОДНОГО правила, которое необходимо изменить. Не включай название раздела, Markdown-заголовки, таблицы, символы |, ### и соседние правила. Если добавляется новое правило — пустая строка."
            },
            proposedText: {
              type: "string",
              description:
                "Только готовая новая формулировка ОДНОГО конкретного правила. Не включай название раздела, Markdown-заголовки, номера разделов, таблицы, символы | и соседние правила."
            },
            reason: {
              type: "string",
              description:
                "Краткое объяснение, какое замечание/новый класс ошибки потребовал изменения."
            }
          },
          required: [
            "section",
            "currentText",
            "proposedText",
            "reason"
          ],
          additionalProperties: false
        }
      }
    },
    required: ["updates"],
    additionalProperties: false
  }
};

// Страховочный tool. Используется только если Claude в основном ответе
// сформулировал предложение изменить master текстом, но не вызвал
// propose_master_instruction_updates (tool_choice там "auto" — модель
// иногда об этом забывает). В отличие от основного tool, updates может
// быть пустым: это валидный исход, если сработала ложная эвристика.
const MASTER_UPDATE_RECOVERY_TOOL = {
  name: "extract_missed_master_update",
  description:
    "Проверь показанный тебе предыдущий ответ технологу: если в нём есть явное предложение изменить или дополнить мастер-инструкцию, которое не было оформлено через tool — оформи его сейчас. Если явного предложения нет, верни пустой массив updates.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      updates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description:
                "Раздел мастер-инструкции, к которому относится изменение."
            },
            currentText: {
              type: "string",
              description:
                "Только точная существующая формулировка ОДНОГО правила, которое необходимо изменить. Пустая строка, если добавляется новое правило."
            },
            proposedText: {
              type: "string",
              description:
                "Только готовая новая формулировка ОДНОГО конкретного правила."
            },
            reason: {
              type: "string",
              description:
                "Краткое объяснение, какое замечание потребовало изменения."
            }
          },
          required: [
            "section",
            "currentText",
            "proposedText",
            "reason"
          ],
          additionalProperties: false
        }
      }
    },
    required: ["updates"],
    additionalProperties: false
  }
};

// Признаки того, что в тексте ответа есть предложение изменить
// мастер-инструкцию, оформленное прозой, а не через tool. Эвристика
// намеренно с запасом по ложным срабатываниям — цена ложного
// срабатывания это один дешёвый дополнительный запрос к Claude, а не
// потерянное предложение.
const MISSED_MASTER_UPDATE_MARKERS =
  /предлага[а-яё]*\s+(изменени|добав|уточнен|скорректир)|предлагаемое изменение|добавить пункт|добавить правило|скорректировать (правило|формулировку)/i;

function looksLikeMissedMasterUpdateProposal(
  text
) {
  return (
    Boolean(text) &&
    MISSED_MASTER_UPDATE_MARKERS.test(
      text
    )
  );
}

async function recoverMissedMasterUpdate({
  apiKey,
  model,
  maxTokens,
  previousAnswerText,
  taskNo
}) {
  const requestToClaude = {
    model,

    max_tokens: Math.min(
      maxTokens || 4000,
      4000
    ),

    system: `
Ты не ведёшь новый диалог с технологом. Тебе показывают твой же предыдущий
ответ. Проверь: есть ли там явное предложение изменить или дополнить
мастер-инструкцию (обычно оформляется фразами вроде "Предлагаемое изменение
в раздел...", "предлагаю добавить пункт..." и т.п.), которое не было оформлено
как отдельный tool call.
Если такое предложение есть — извлеки его и оформи через tool
extract_missed_master_update. Каждое логически отдельное изменение — отдельный
элемент массива updates. Если явного предложения нет — верни пустой массив.
Правила заполнения currentText/proposedText/section/reason такие же, как для
propose_master_instruction_updates: без Markdown-разметки, без названия
раздела внутри текста правила, без объединения нескольких правил в один update.
`,

    messages: [
      {
        role: "user",

        content: [
          {
            type: "text",

            text: `ТВОЙ ПРЕДЫДУЩИЙ ОТВЕТ ТЕХНОЛОГУ:\n\n${previousAnswerText}`
          }
        ]
      }
    ],

    tools: [
      MASTER_UPDATE_RECOVERY_TOOL
    ],

    tool_choice: {
      type: "tool",

      name: "extract_missed_master_update"
    }
  };

  const {
    httpResponse,
    response
  } =
    await sendClaudeMessagesRequest(
      apiKey,
      requestToClaude
    );

  if (!httpResponse.ok) {
    throw new Error(
      response?.error
        ?.message ||
        `Claude API request failed: HTTP ${httpResponse.status}`
    );
  }

  const recoveredUpdates =
    extractForcedToolInput(
      response,
      "extract_missed_master_update"
    )?.updates;

  if (
    !Array.isArray(
      recoveredUpdates
    )
  ) {
    throw new Error(
      "Claude did not return recovery updates array"
    );
  }

  return {
    updates:
      normalizeMasterUpdates(
        recoveredUpdates
      ),

    usage:
      extractUsage(
        response
      )
  };
}

const MASTER_UPDATE_PROTOCOL = `
ДОПОЛНИТЕЛЬНЫЙ ПРОТОКОЛ ИНТЕГРАЦИИ С MASTER-ИНСТРУКЦИЕЙ:
Если в текущем диалоге замечание технолога/метролога выявляет новый класс ошибки или требует уточнить существующее правило мастер-инструкции, сформулируй конкретные предлагаемые изменения и вызови tool propose_master_instruction_updates.
В tool передавай полный набор изменений, относящихся к текущему замечанию.
Если изменение инструкции не требуется (например, замечание уже полностью покрывается существующим правилом), tool не вызывай.
Обычный ответ пользователю формируй как обычно. Если вызываешь tool, сначала закончи содержательный текстовый ответ пользователю, затем вызови tool.
Не вставляй служебный JSON updates в обычный текст ответа.

Каждый элемент updates должен описывать одно логически отдельное изменение.

В currentText и proposedText передавай только текст самого правила.
Не копируй Markdown-разметку документа:
- не добавляй ### и другие заголовки;
- не добавляй символы таблиц | или ||;
- не включай название раздела внутрь текста правила;
- не объединяй несколько независимых правил в один update.
`;

export default {
  async fetch(request, env, ctx) {
    // Поиск лидов — отдельный синхронный маршрут для браузера
    // (не через очередь: очередь заточена под Planfix-callback,
    // здесь нужен обычный JSON-ответ прямо в интерфейс дашборда).
    const url = new URL(request.url);
    if (
      url.pathname === "/lead-search/query" ||
      url.pathname === "/lead-search/upload" ||
      url.pathname === "/lead-search/check"
    ) {
      return handleLeadSearchRoute(
        request,
        env,
        url.pathname
      );
    }

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
        operation,
        apiKey,
        callback,
        updatesCallback,
        masterFileCallback,
        taskNo,
        userEmail,
        files = [],
        rawRequest,
        history,
        planfixFileUploadToken,
        planfixDomen,
        masterInstructionUrl,
        currentUpdates,
        updates,
        technologistComment,
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

      if (!taskNo) {
        return jsonResponse(
          {
            success: false,
            error: "taskNo is required"
          },
          400
        );
      }

      if (
        operation &&
        operation !== OP_REVISE_MASTER_UPDATES &&
        operation !== OP_APPLY_MASTER_UPDATES
      ) {
        return jsonResponse(
          {
            success: false,
            error: `Unsupported operation: ${operation}`
          },
          400
        );
      }

      // Обычный диалог — старое поведение: operation отсутствует.
      if (!operation && !callback) {
        return jsonResponse(
          {
            success: false,
            error: "callback is required for dialog requests"
          },
          400
        );
      }

      if (operation === OP_REVISE_MASTER_UPDATES) {
        if (!updatesCallback) {
          return jsonResponse(
            {
              success: false,
              error:
                "updatesCallback is required for revise_master_updates"
            },
            400
          );
        }

        if (!Array.isArray(currentUpdates)) {
          return jsonResponse(
            {
              success: false,
              error: "currentUpdates must be an array"
            },
            400
          );
        }

        if (
          !technologistComment ||
          !String(technologistComment).trim()
        ) {
          return jsonResponse(
            {
              success: false,
              error:
                "technologistComment is required for revise_master_updates"
            },
            400
          );
        }
      }

      if (operation === OP_APPLY_MASTER_UPDATES) {
        if (!masterFileCallback) {
          return jsonResponse(
            {
              success: false,
              error:
                "masterFileCallback is required for apply_master_updates"
            },
            400
          );
        }

        if (
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
        }

        if (!Array.isArray(updates)) {
          return jsonResponse(
            {
              success: false,
              error: "updates must be an array"
            },
            400
          );
        }

        if (!planfixFileUploadToken || !planfixDomen) {
          return jsonResponse(
            {
              success: false,
              error:
                "planfixFileUploadToken and planfixDomen are required for apply_master_updates"
            },
            400
          );
        }
      }

      // Не обрабатываем запрос напрямую — тяжёлые операции идут
      // через Cloudflare Queue. Planfix сразу получает accepted.
      await env.TASK_QUEUE.send({
        operation: operation || null,
        apiKey,
        callback,
        updatesCallback,
        masterFileCallback,
        taskNo,
        userEmail,
        files,
        rawRequest,
        history,
        planfixFileUploadToken,
        planfixDomen,
        masterInstructionUrl,
        currentUpdates,
        updates,
        technologistComment,
        claudeRequest
      });

      return jsonResponse({
        success: true,
        taskNo,
        userEmail: userEmail || null,
        operation: operation || null,
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

  // Consumer очереди: выбирает обработчик по operation.
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const taskPayload = message.body;
      const operation = taskPayload.operation || "dialog";

      console.log(
        `[${taskPayload.taskNo}] Забран из очереди, режим: ${operation}`
      );

      try {
        if (
          taskPayload.operation ===
          OP_REVISE_MASTER_UPDATES
        ) {
          await processReviseMasterUpdates(
            taskPayload
          );
        } else if (
          taskPayload.operation ===
          OP_APPLY_MASTER_UPDATES
        ) {
          await processApplyMasterUpdates(
            taskPayload
          );
        } else {
          await processClaudeRequest(
            taskPayload
          );
        }
      } catch (error) {
        // Каждый обработчик сам старается отправить error-callback.
        // Здесь только последний предохранитель; повтор не запускаем,
        // чтобы не получить двойной платный вызов Claude/API Planfix.
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
// ОБЫЧНЫЙ ДИАЛОГ
// ============================================================

async function processClaudeRequest({
  apiKey,
  callback,
  updatesCallback,
  taskNo,
  userEmail,
  files,
  rawRequest,
  history,
  planfixFileUploadToken,
  planfixDomen,
  masterInstructionUrl,
  claudeRequest
}) {
  // Сюда сохраним то, что реально отправили в Claude,
  // чтобы вернуть это в колбэк для фиксации в Planfix.
  let sentRequest = null;

  console.log(
    `[${taskNo}] Старт диалога, файлов на входе: ${
      Array.isArray(files)
        ? files.length
        : 0
    }`
  );

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
          const block =
            await downloadFileForClaude(
              file
            );

          if (block) {
            fileBlocks.push(
              block
            );

            console.log(
              `[${taskNo}] Скачан входной файл: ${file.name}`
            );
          }
        } catch (error) {
          console.error(
            `Failed to download file "${
              file.name ||
              file.url
            }":`,
            error
          );
        }
      }
    }

    // --------------------------------------------------------
    // 2. Строим настоящий многоходовый messages
    // --------------------------------------------------------

    const historyTurns =
      parseHistoryToTurns(
        history
      );

    const messages =
      buildMessagesFromHistory(
        historyTurns,
        rawRequest || "",
        fileBlocks
      );

    // --------------------------------------------------------
    // 3. Формируем запрос Claude
    // --------------------------------------------------------

    const requestToClaude = {
      ...claudeRequest,

      messages,

      system:
        appendSystemInstruction(
          claudeRequest.system,
          MASTER_UPDATE_PROTOCOL
        )
    };

    // Code execution сохраняем как было: он нужен для создания
    // файлов в обычном диалоге.
    const existingTools =
      Array.isArray(
        requestToClaude.tools
      )
        ? requestToClaude.tools
        : [];

    const tools = [
      ...existingTools
    ];

    if (
      !tools.some(
        (tool) =>
          tool &&
          tool.name ===
            "code_execution"
      )
    ) {
      tools.push({
        type:
          "code_execution_20250825",

        name:
          "code_execution"
      });
    }

    // Добавляем наш структурированный канал предложений по master.
    if (
      !tools.some(
        (tool) =>
          tool &&
          tool.name ===
            MASTER_UPDATE_PROPOSAL_TOOL.name
      )
    ) {
      tools.push(
        MASTER_UPDATE_PROPOSAL_TOOL
      );
    }

    requestToClaude.tools =
      tools;

    // Что реально отправили в Claude — для колбэка в Planfix.
    // Содержимое файлов (base64) заменяем меткой, чтобы не
    // раздувать вебхук — сам факт и тип вложения сохраняем.
    sentRequest = {
      ...requestToClaude,

      messages:
        stripFileData(
          messages
        )
    };

    // --------------------------------------------------------
    // 4. Отправляем запрос Claude
    // --------------------------------------------------------

    console.log(
      `[${taskNo}] Отправляю запрос в Claude API (модель: ${requestToClaude.model}, max_tokens: ${requestToClaude.max_tokens})`
    );

    const {
      httpResponse:
        claudeResponse,

      response
    } =
      await sendClaudeMessagesRequest(
        apiKey,
        requestToClaude
      );

    console.log(
      `[${taskNo}] Ответ от Claude получен, HTTP ${claudeResponse.status}, stop_reason: ${response?.stop_reason}`
    );

    // --------------------------------------------------------
    // 5. Если Claude вернул ошибку
    // --------------------------------------------------------

    if (!claudeResponse.ok) {
      console.log(
        `[${taskNo}] Claude вернул ошибку, отправляю error-колбэк`
      );

      await sendCallback(
        callback,
        {
          taskNo,

          userEmail:
            userEmail || null,

          success: false,

          status:
            claudeResponse.status,

          app_version:
            APP_VERSION,

          request:
            sentRequest,

          raw_request:
            rawRequest,

          error:
            response?.error
              ?.message ||
            "Claude API request failed",

          response
        }
      );

      console.log(
        `[${taskNo}] Error-колбэк отправлен`
      );

      return;
    }

    // --------------------------------------------------------
    // 6. Извлекаем текст, usage и предлагаемые master-updates
    // --------------------------------------------------------

    const claudeText =
      extractClaudeText(
        response
      );

    const usage =
      extractUsage(
        response
      );

    const estimatedCostUsd =
      estimateCostUsd(
        requestToClaude.model,
        usage
      );

    let masterUpdates =
      extractMasterInstructionUpdates(
        response
      );

    // Claude иногда формулирует предложение изменить master прозой в
    // обычном ответе, но не вызывает propose_master_instruction_updates
    // (tool_choice там "auto"). Если тула не было, но текст похож на
    // такое предложение — делаем страховочный forced-tool запрос,
    // чтобы не потерять предложение молча.
    let masterUpdateRecoveryUsage =
      null;

    if (
      masterUpdates.length ===
        0 &&
      looksLikeMissedMasterUpdateProposal(
        claudeText
      )
    ) {
      console.warn(
        `[${taskNo}] Похоже, Claude предложил изменение мастер-инструкции текстом, но не вызвал tool. Пробую восстановить страховочным запросом.`
      );

      try {
        const recovered =
          await recoverMissedMasterUpdate(
            {
              apiKey,
              model:
                requestToClaude.model,
              maxTokens:
                requestToClaude.max_tokens,
              previousAnswerText:
                claudeText,
              taskNo
            }
          );

        masterUpdates =
          recovered.updates;

        masterUpdateRecoveryUsage =
          recovered.usage;

        console.log(
          `[${taskNo}] Страховочный запрос завершён, восстановлено updates: ${masterUpdates.length}`
        );
      } catch (error) {
        console.error(
          `[${taskNo}] Страховочный запрос не удался:`,
          error
        );
      }
    }

    // --------------------------------------------------------
    // 6.1. Ищем файлы, сгенерированные Claude, и загружаем
    // каждый в Planfix — ЭТА ЛОГИКА И ФОРМАТ files НЕ МЕНЯЮТСЯ.
    // --------------------------------------------------------

    const uploadedFileIds =
      [];

    const fileDeliveryErrors =
      [];

    const generatedFileIds =
      findGeneratedFileIds(
        response
      );

    console.log(
      `[${taskNo}] Найдено сгенерированных файлов в ответе: ${generatedFileIds.length}`
    );

    for (
      const fileId of
      generatedFileIds
    ) {
      let generatedFile;

      try {
        console.log(
          `[${taskNo}] Скачиваю сгенерированный файл у Claude: ${fileId}`
        );

        generatedFile =
          await downloadGeneratedFile(
            fileId,
            apiKey
          );

        console.log(
          `[${taskNo}] Скачан: ${generatedFile.filename} (${generatedFile.arrayBuffer.byteLength} байт)`
        );
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

      if (
        !planfixFileUploadToken ||
        !planfixDomen
      ) {
        fileDeliveryErrors.push(
          `Файл "${generatedFile.filename}" сгенерирован, но planfixFileUploadToken/planfixDomen не переданы — загрузить в Planfix нечем`
        );

        continue;
      }

      try {
        console.log(
          `[${taskNo}] Загружаю "${generatedFile.filename}" в Planfix REST API`
        );

        const planfixFileId =
          await uploadFileToPlanfixRest(
            planfixDomen,
            planfixFileUploadToken,
            generatedFile
          );

        uploadedFileIds.push({
          id:
            planfixFileId,

          name:
            generatedFile.filename
        });

        console.log(
          `[${taskNo}] Загружен в Planfix, id: ${planfixFileId}`
        );
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
      fileDeliveryErrors.length >
      0
        ? fileDeliveryErrors.join(
            " | "
          )
        : null;

    // --------------------------------------------------------
    // 6.2. Сохраняем прежнюю машиночитаемую заметку о файлах
    // --------------------------------------------------------

    let claudeTextWithFileNote =
      claudeText;

    if (
      uploadedFileIds.length >
      0
    ) {
      const fileNames =
        uploadedFileIds
          .map(
            (f) =>
              f.name
          )
          .join(", ");

      claudeTextWithFileNote +=
        `\n\n[Файл${
          uploadedFileIds.length >
          1
            ? "ы"
            : ""
        }, созданны${
          uploadedFileIds.length >
          1
            ? "е"
            : "й"
        } мной в этом ответе: ${fileNames}]`;
    }

    // --------------------------------------------------------
    // 7. Markdown → HTML для обычного ответа
    // --------------------------------------------------------

    const html =
      markdownToHtml(
        claudeTextWithFileNote
      );

    // --------------------------------------------------------
    // 8. Основной callback — формат files оставляем как был
    // --------------------------------------------------------

    console.log(
      `[${taskNo}] Отправляю финальный колбэк на ${callback}`
    );

    await sendCallback(
      callback,
      {
        taskNo,

        userEmail:
          userEmail || null,

        success: true,

        status:
          claudeResponse.status,

        app_version:
          APP_VERSION,

        request:
          sentRequest,

        raw_request:
          rawRequest,

        html,

        text:
          claudeTextWithFileNote,

        input_tokens:
          usage.input_tokens,

        output_tokens:
          usage.output_tokens,

        cache_creation_input_tokens:
          usage.cache_creation_input_tokens,

        cache_read_input_tokens:
          usage.cache_read_input_tokens,

        total_tokens:
          usage.total_tokens,

        estimated_cost_usd:
          estimatedCostUsd,

        files:
          uploadedFileIds.map(
            (f) => f.id
          ),

        file_delivery_error:
          fileDeliveryError,

        response
      }
    );

    console.log(
      `[${taskNo}] Финальный колбэк отправлен успешно`
    );

    // --------------------------------------------------------
    // 9. Если Claude предложил изменения мастер-инструкции —
    // отдельный callback.
    // --------------------------------------------------------

    if (
      masterUpdates.length >
      0
    ) {
      if (!updatesCallback) {
        console.warn(
          `[${taskNo}] Claude предложил ${masterUpdates.length} master-update(s), но updatesCallback не передан`
        );
      } else {
        console.log(
          `[${taskNo}] Отправляю ${masterUpdates.length} master-update(s) на ${updatesCallback}`
        );

        // Версия master.md на момент формирования предложения. Кладём
        // её в каждый элемент updates (а не отдельным полем), чтобы
        // Planfix ничего не дорабатывал — он и так хранит и возвращает
        // updates как есть в revise_master_updates/apply_master_updates.
        // Нужна, чтобы при apply_master_updates обнаружить, что
        // документ уже успели изменить параллельно, и не применять
        // устаревшее предложение вслепую.
        const baseMasterVersion =
          await resolveBaseMasterVersion(
            masterInstructionUrl,
            taskNo
          );

        const updatesWithBaseVersion =
          masterUpdates.map(
            (update) => ({
              ...update,
              baseMasterVersion
            })
          );

        // Если предложение восстановлено страховочным запросом — его
        // usage и есть реальная стоимость получения этого updates;
        // иначе (обычный путь через tool в основном ответе) берём
        // usage основного запроса, как и раньше.
        const masterUpdateUsage =
          masterUpdateRecoveryUsage ||
          usage;

        const masterUpdateCostUsd =
          masterUpdateRecoveryUsage
            ? estimateCostUsd(
                requestToClaude.model,
                masterUpdateRecoveryUsage
              )
            : estimatedCostUsd;

        await sendCallback(
          updatesCallback,
          {
            taskNo,

            userEmail:
              userEmail || null,

            success: true,

            updates:
              updatesWithBaseVersion,

            html:
              formatMasterUpdatesHtml(
                masterUpdates
              ),

            input_tokens:
              masterUpdateUsage.input_tokens,

            output_tokens:
              masterUpdateUsage.output_tokens,

            total_tokens:
              masterUpdateUsage.total_tokens,

            estimated_cost_usd:
              masterUpdateCostUsd
          }
        );

        console.log(
          `[${taskNo}] Master-updates callback отправлен`
        );
      }
    }
  } catch (error) {
    console.error(
      `[${taskNo}] processClaudeRequest error:`,
      error
    );

    try {
      await sendCallback(
        callback,
        {
          taskNo,

          userEmail:
            userEmail || null,

          success: false,

          app_version:
            APP_VERSION,

          request:
            sentRequest,

          raw_request:
            rawRequest,

          error:
            error.message
        }
      );

      console.log(
        `[${taskNo}] Error-колбэк из catch отправлен`
      );
    } catch (callbackError) {
      console.error(
        "Failed to send error callback:",
        callbackError
      );
    }
  }
}

// ============================================================
// КОРРЕКТИРОВКА ПРЕДЛОЖЕННЫХ ИЗМЕНЕНИЙ MASTER-ИНСТРУКЦИИ
// ============================================================

async function processReviseMasterUpdates({
  apiKey,
  updatesCallback,
  taskNo,
  userEmail,
  currentUpdates,
  technologistComment,
  claudeRequest
}) {
  console.log(
    `[${taskNo}] Корректировка master-updates, текущих пунктов: ${currentUpdates.length}`
  );

  // currentUpdates — тот же массив, что Worker когда-то отправил в
  // updatesCallback, Planfix хранит и возвращает его как есть, поэтому
  // baseMasterVersion читаем прямо из него, а не из отдельного поля.
  const baseMasterVersion =
    currentUpdates.find(
      (item) =>
        item &&
        item.baseMasterVersion
    )?.baseMasterVersion ||
    null;

  try {
    const returnTool = {
      name:
        "return_revised_master_updates",

      description:
        "Верни полную новую редакцию массива предложенных изменений мастер-инструкции после замечания технолога.",

      strict: true,

      input_schema: {
        type: "object",

        properties: {
          updates: {
            type: "array",

            items: {
              type: "object",

              properties: {
                section: {
                  type: "string"
                },

                currentText: {
                  type: "string"
                },

                proposedText: {
                  type: "string"
                },

                reason: {
                  type: "string"
                }
              },

              required: [
                "section",
                "currentText",
                "proposedText",
                "reason"
              ],

              additionalProperties:
                false
            }
          }
        },

        required: [
          "updates"
        ],

        additionalProperties:
          false
      }
    };

    const requestToClaude = {
      model:
        claudeRequest.model,

      max_tokens:
        claudeRequest.max_tokens,

      system: `
Ты редактируешь ТОЛЬКО проект изменений мастер-инструкции, а не сам файл инструкции.
Технолог уже увидел предыдущую редакцию предложений и дал замечание.
Твоя задача — понять замечание технолога и вернуть ПОЛНУЮ новую редакцию updates.
Новая редакция полностью заменит старую в Planfix.
Если технолог просит удалить пункт — исключи его из нового массива.
Если просит изменить формулировку — измени соответствующий proposedText.
Если добавляет новое требование — добавь новый объект.
Не придумывай требований, которых нет ни в текущих updates, ни в замечании технолога.
Поле currentText описывает текст, который сейчас есть в мастер-инструкции; не превращай туда proposedText.
Если это добавление нового правила — currentText оставляй пустой строкой.

Каждый элемент updates должен описывать только одно логически отдельное изменение.
В currentText и proposedText передавай только текст самого правила:
- без Markdown-заголовков;
- без символов таблиц | и ||;
- без названия раздела;
- без соседних правил.
`,

      messages: [
        {
          role: "user",

          content: [
            {
              type: "text",

              text:
                `ТЕКУЩАЯ РЕДАКЦИЯ ПРЕДЛАГАЕМЫХ ИЗМЕНЕНИЙ:\n` +
                `${JSON.stringify(
                  currentUpdates,
                  null,
                  2
                )}\n\n` +
                `ЗАМЕЧАНИЕ ТЕХНОЛОГА:\n${technologistComment}\n\n` +
                `Верни полную скорректированную редакцию через tool return_revised_master_updates.`
            }
          ]
        }
      ],

      tools: [
        returnTool
      ],

      tool_choice: {
        type: "tool",

        name:
          "return_revised_master_updates"
      }
    };

    const {
      httpResponse,
      response
    } =
      await sendClaudeMessagesRequest(
        apiKey,
        requestToClaude
      );

    if (!httpResponse.ok) {
      throw new Error(
        response?.error?.message ||
          `Claude API request failed: HTTP ${httpResponse.status}`
      );
    }

    const revisedUpdates =
      extractForcedToolInput(
        response,
        "return_revised_master_updates"
      )?.updates;

    if (
      !Array.isArray(
        revisedUpdates
      )
    ) {
      throw new Error(
        "Claude did not return revised updates array"
      );
    }

    const normalizedUpdates =
      normalizeMasterUpdates(
        revisedUpdates
      ).map(
        (update) => ({
          ...update,
          baseMasterVersion
        })
      );

    const usage =
      extractUsage(
        response
      );

    const estimatedCostUsd =
      estimateCostUsd(
        requestToClaude.model,
        usage
      );

    await sendCallback(
      updatesCallback,
      {
        taskNo,

        userEmail:
          userEmail || null,

        success: true,

        // baseMasterVersion уже встроен в каждый элемент normalizedUpdates
        // (см. выше) — технолог правит только формулировки, сам master.md
        // не трогается, поэтому версия остаётся прежней.
        updates:
          normalizedUpdates,

        html:
          formatMasterUpdatesHtml(
            normalizedUpdates
          ),

        input_tokens:
          usage.input_tokens,

        output_tokens:
          usage.output_tokens,

        total_tokens:
          usage.total_tokens,

        estimated_cost_usd:
          estimatedCostUsd
      }
    );

    console.log(
      `[${taskNo}] Скорректированные master-updates отправлены`
    );
  } catch (error) {
    console.error(
      `[${taskNo}] processReviseMasterUpdates error:`,
      error
    );

    try {
      await sendCallback(
        updatesCallback,
        {
          taskNo,

          userEmail:
            userEmail || null,

          success: false,

          error:
            error.message
        }
      );
    } catch (callbackError) {
      console.error(
        "Failed to send revise error callback:",
        callbackError
      );
    }
  }
}

// ============================================================
// ПРИМЕНЕНИЕ УТВЕРЖДЁННЫХ ИЗМЕНЕНИЙ К MASTER.MD
// ============================================================

async function processApplyMasterUpdates({
  apiKey,
  masterFileCallback,
  updatesCallback,
  taskNo,
  userEmail,
  masterInstructionUrl,
  updates,
  planfixFileUploadToken,
  planfixDomen,
  claudeRequest
}) {
  // updates — тот же массив, что был отправлен в updatesCallback при
  // формировании предложения; baseMasterVersion лежит в его элементах
  // (Planfix хранит и возвращает updates как есть, без доработок).
  const baseMasterVersion =
    Array.isArray(updates)
      ? updates.find(
          (item) =>
            item &&
            item.baseMasterVersion
        )?.baseMasterVersion ||
        null
      : null;
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

    console.log(
      `[${taskNo}][MASTER APPLY] DOWNLOAD START`,
      JSON.stringify({
        master_files: masterInstructionUrls.length,
        filename: getFilenameFromUrl(activeMasterInstructionUrl)
      })
    );

    const currentMarkdown =
      await downloadTextFile(
        activeMasterInstructionUrl
      );

    console.log(
      `[${taskNo}][MASTER APPLY] DOWNLOAD OK`,
      JSON.stringify({
        chars: currentMarkdown.length,
        bytes_utf8: new TextEncoder().encode(currentMarkdown).byteLength
      })
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

    // --------------------------------------------------------
    // 1.5. Master мог измениться параллельно, пока предложение
    // согласовывалось (другой технолог уже применил свой apply).
    // Если версия разъехалась — не пытаемся матчить currentText
    // вслепую, а просим Claude пересобрать предложение относительно
    // актуального текста и возвращаем его технологу на повторное
    // подтверждение вместо того, чтобы применять устаревшие правки.
    // baseMasterVersion не передан — считаем, что вызывающая сторона
    // ещё не обновлена под эту проверку, и работаем по-старому.
    // --------------------------------------------------------

    if (
      baseMasterVersion &&
      baseMasterVersion !== currentVersion
    ) {
      console.warn(
        `[${taskNo}][MASTER APPLY] VERSION MISMATCH`,
        JSON.stringify({
          base: baseMasterVersion,
          current: currentVersion
        })
      );

      await resyncStaleMasterUpdates({
        apiKey,
        claudeRequest,
        taskNo,
        userEmail,
        updates,
        currentMarkdown,
        currentVersion,
        baseMasterVersion,
        updatesCallback,
        masterFileCallback
      });

      return;
    }

    const newVersion =
      incrementVersion(
        currentVersion
      );

    console.log(
      `[${taskNo}][MASTER APPLY] VERSION`,
      JSON.stringify({
        current: currentVersion,
        next: newVersion
      })
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
        normalizedUpdates,
        taskNo
      );

    console.log(
      `[${taskNo}][MASTER APPLY] RULES APPLIED`,
      JSON.stringify({ count: normalizedUpdates.length })
    );

    updatedMarkdown =
      updateMasterInstructionMetadata(
        updatedMarkdown,
        currentVersion,
        newVersion,
        updateDate
      );

    console.log(
      `[${taskNo}][MASTER APPLY] METADATA UPDATED`,
      JSON.stringify({ version: newVersion, date: updateDate })
    );

    updatedMarkdown =
      addMasterInstructionChangelogEntry(
        updatedMarkdown,
        newVersion,
        updateDate,
        normalizedUpdates
      );

    console.log(
      `[${taskNo}][MASTER APPLY] CHANGELOG UPDATED`
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

    console.log(
      `[${taskNo}][MASTER APPLY] UPLOAD OK`,
      JSON.stringify({
        filename: newFilename,
        planfix_file_id: planfixFileId
      })
    );

    // --------------------------------------------------------
    // 4. Финальный webhook. Claude не вызывается, поэтому usage=0
    // --------------------------------------------------------

    console.log(
      `[${taskNo}][MASTER APPLY] CALLBACK START`
    );

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
      `[${taskNo}][MASTER APPLY] ERROR MESSAGE: ${error?.message || String(error)}`
    );

    console.error(
      `[${taskNo}][MASTER APPLY] ERROR STACK: ${error?.stack || "[no stack]"}`
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

// ============================================================
// РЕСИНК УТВЕРЖДЁННЫХ MASTER-UPDATES ПОСЛЕ ГОНКИ ВЕРСИЙ
// ============================================================
//
// Вызывается, только когда baseMasterVersion (версия, на которой
// технолог согласовывал предложение) разошлась с фактической текущей
// версией master.md — то есть кто-то другой уже применил apply, пока
// это предложение ждало подтверждения. Ничего не применяем вслепую:
// просим Claude сверить старые updates с актуальным текстом и
// отправляем пересобранное предложение обратно на подтверждение.

async function resyncStaleMasterUpdates({
  apiKey,
  claudeRequest,
  taskNo,
  userEmail,
  updates,
  currentMarkdown,
  currentVersion,
  baseMasterVersion,
  updatesCallback,
  masterFileCallback
}) {
  try {
    const resyncTool = {
      name:
        "resync_master_updates",

      description:
        "Верни предложенные изменения мастер-инструкции, сверенные с её актуальным текстом.",

      strict: true,

      input_schema: {
        type: "object",

        properties: {
          updates: {
            type: "array",

            items: {
              type: "object",

              properties: {
                section: {
                  type: "string"
                },

                currentText: {
                  type: "string"
                },

                proposedText: {
                  type: "string"
                },

                reason: {
                  type: "string"
                }
              },

              required: [
                "section",
                "currentText",
                "proposedText",
                "reason"
              ],

              additionalProperties:
                false
            }
          }
        },

        required: [
          "updates"
        ],

        additionalProperties:
          false
      }
    };

    const requestToClaude = {
      model:
        claudeRequest?.model,

      max_tokens:
        claudeRequest?.max_tokens,

      system: `
Пока предложенные изменения мастер-инструкции согласовывались, документ уже успел
измениться — его применил кто-то другой. Тебе даны:
1. Ранее одобренные изменения (section/currentText/proposedText/reason).
2. Актуальный полный текст мастер-инструкции.

Твоя задача — для КАЖДОГО пункта проверить currentText против актуального текста:
- Если currentText дословно (или почти дословно) присутствует в актуальном тексте —
  оставь пункт как есть.
- Если формулировка в документе немного изменилась, но правка по смыслу всё ещё
  актуальна — скорректируй currentText под реальный текст документа; proposedText
  и reason по смыслу не меняй.
- Если пункт описывал добавление нового правила (currentText пустой) и это правило
  ещё не появилось в документе — оставь currentText пустым.
- Если правку уже нет смысла применять (например, кто-то другой уже внёс именно
  это изменение, или раздел был удалён) — исключи пункт из результата.
Не добавляй пунктов, которых не было в исходном списке. Не переписывай части
документа, не относящиеся к этим пунктам — ты только сверяешь и правишь сами
объекты updates, а не документ целиком.
`,

      messages: [
        {
          role: "user",

          content: [
            {
              type: "text",

              text:
                `РАНЕЕ ОДОБРЕННЫЕ ИЗМЕНЕНИЯ (основаны на версии ${baseMasterVersion}):\n` +
                `${JSON.stringify(
                  updates,
                  null,
                  2
                )}\n\n` +
                `АКТУАЛЬНЫЙ ТЕКСТ МАСТЕР-ИНСТРУКЦИИ (версия ${currentVersion}):\n\n` +
                `${currentMarkdown}\n\n` +
                `Верни сверенный список через tool resync_master_updates.`
            }
          ]
        }
      ],

      tools: [
        resyncTool
      ],

      tool_choice: {
        type: "tool",

        name:
          "resync_master_updates"
      }
    };

    const {
      httpResponse,
      response
    } =
      await sendClaudeMessagesRequest(
        apiKey,
        requestToClaude
      );

    if (!httpResponse.ok) {
      throw new Error(
        response?.error?.message ||
          `Claude API request failed: HTTP ${httpResponse.status}`
      );
    }

    const resyncedUpdates =
      extractForcedToolInput(
        response,
        "resync_master_updates"
      )?.updates;

    if (
      !Array.isArray(
        resyncedUpdates
      )
    ) {
      throw new Error(
        "Claude did not return resynced updates array"
      );
    }

    // Пересобранное предложение основано на currentVersion (то, что
    // сейчас реально лежит в master.md) — эта версия и станет новой
    // baseMasterVersion для повторного согласования.
    const normalizedUpdates =
      normalizeMasterUpdates(
        resyncedUpdates
      ).map(
        (update) => ({
          ...update,

          baseMasterVersion:
            currentVersion
        })
      );

    const usage =
      extractUsage(
        response
      );

    const estimatedCostUsd =
      estimateCostUsd(
        requestToClaude.model,
        usage
      );

    console.log(
      `[${taskNo}][MASTER APPLY] RESYNC DONE`,
      JSON.stringify({
        base: baseMasterVersion,
        current: currentVersion,
        before: updates.length,
        after: normalizedUpdates.length
      })
    );

    if (normalizedUpdates.length === 0) {
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
              `**Мастер-инструкция изменилась с версии ${baseMasterVersion} на ${currentVersion}, пока предложение согласовывалось.**\n\n` +
              `После сверки с актуальным текстом ни один из ранее одобренных пунктов больше не применим — вероятно, эти изменения уже внёс кто-то другой. Новое предложение не сформировано.`
            ),

          error: `Master изменился (${baseMasterVersion} → ${currentVersion}); after resync 0 updates remain applicable`
        }
      );

      return;
    }

    if (!updatesCallback) {
      console.warn(
        `[${taskNo}][MASTER APPLY] RESYNC OK, но updatesCallback не передан — предложение не отправлено`
      );
    } else {
      await sendCallback(
        updatesCallback,
        {
          taskNo,

          userEmail:
            userEmail || null,

          success: true,

          updates:
            normalizedUpdates,

          html:
            formatMasterUpdatesHtml(
              normalizedUpdates
            ),

          input_tokens:
            usage.input_tokens,

          output_tokens:
            usage.output_tokens,

          total_tokens:
            usage.total_tokens,

          estimated_cost_usd:
            estimatedCostUsd
        }
      );
    }

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
            `**Мастер-инструкция изменилась с версии ${baseMasterVersion} на ${currentVersion}, пока предложение согласовывалось.**\n\n` +
            `Изменения не применены. Предложение пересобрано относительно актуального текста и отправлено на повторное подтверждение.`
          ),

        error: `Master изменился (${baseMasterVersion} → ${currentVersion}); resynced proposal sent for reconfirmation`
      }
    );
  } catch (error) {
    console.error(
      `[${taskNo}][MASTER APPLY] RESYNC ERROR: ${error?.message || String(error)}`
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
              `**Не удалось обновить мастер-инструкцию.**\n\nМастер изменился с версии ${baseMasterVersion} на ${currentVersion}, но пересобрать предложение автоматически не получилось: ${error.message}`
            ),

          error:
            error.message
        }
      );
    } catch (callbackError) {
      console.error(
        "Failed to send resync error callback:",
        callbackError
      );
    }
  }
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ НОВОЙ АРХИТЕКТУРЫ
// ============================================================

// Собирает Server-Sent Events потокового ответа Anthropic обратно в тот
// же объект { id, model, content, stop_reason, usage, ... }, который
// раньше приходил одним JSON. Весь остальной код (extractClaudeText,
// extractMasterInstructionUpdates, findGeneratedFileIds, extractUsage
// и т.д.) работает с этим объектом как раньше, ничего не зная о том,
// что ответ теперь стримится.
async function parseAnthropicMessageStream(
  body,
  requestId
) {
  const reader =
    body.getReader();

  const decoder =
    new TextDecoder(
      "utf-8"
    );

  let buffer = "";
  let message = null;
  const blocks = [];
  const partialJson = {};
  let usage = null;

  function handleEvent(
    event
  ) {
    switch (event.type) {
      case "message_start":
        message =
          event.message;
        usage =
          message?.usage ||
          null;
        break;

      case "content_block_start":
        blocks[
          event.index
        ] = {
          ...event.content_block
        };

        if (
          blocks[event.index]
            ?.type ===
          "tool_use"
        ) {
          partialJson[
            event.index
          ] = "";
        }
        break;

      case "content_block_delta":
        if (
          event.delta
            ?.type ===
          "text_delta"
        ) {
          blocks[
            event.index
          ].text =
            (blocks[
              event.index
            ].text ||
              "") +
            event.delta
              .text;
        } else if (
          event.delta
            ?.type ===
          "input_json_delta"
        ) {
          partialJson[
            event.index
          ] =
            (partialJson[
              event.index
            ] || "") +
            event.delta
              .partial_json;
        }
        break;

      case "content_block_stop":
        if (
          partialJson[
            event.index
          ] !==
          undefined
        ) {
          try {
            blocks[
              event.index
            ].input =
              JSON.parse(
                partialJson[
                  event
                    .index
                ] || "{}"
              );
          } catch {
            blocks[
              event.index
            ].input =
              {};
          }
        }
        break;

      case "message_delta":
        if (message) {
          message.stop_reason =
            event.delta
              ?.stop_reason ??
            message.stop_reason;

          message.stop_sequence =
            event.delta
              ?.stop_sequence ??
            message.stop_sequence;
        }

        if (
          event.usage
        ) {
          usage = {
            ...usage,
            ...event.usage
          };
        }
        break;

      case "error":
        throw new Error(
          event.error
            ?.message ||
            "Claude stream returned an error event"
        );

      default:
        break;
    }
  }

  while (true) {
    const {
      value,
      done
    } =
      await reader.read();

    if (done) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream: true
        }
      );

    let separatorIndex;

    while (
      (separatorIndex =
        buffer.indexOf(
          "\n\n"
        )) !== -1
    ) {
      const rawEvent =
        buffer.slice(
          0,
          separatorIndex
        );

      buffer =
        buffer.slice(
          separatorIndex +
            2
        );

      const dataLine =
        rawEvent
          .split("\n")
          .find((line) =>
            line.startsWith(
              "data:"
            )
          );

      if (!dataLine) {
        continue;
      }

      const jsonStr =
        dataLine
          .slice(5)
          .trim();

      if (!jsonStr) {
        continue;
      }

      let event;

      try {
        event =
          JSON.parse(
            jsonStr
          );
      } catch {
        console.warn(
          `[CLAUDE][${requestId}] Не удалось разобрать SSE-событие, пропускаю:`,
          jsonStr.slice(
            0,
            500
          )
        );

        continue;
      }

      handleEvent(
        event
      );
    }
  }

  if (!message) {
    throw new Error(
      "Claude stream ended without a message_start event"
    );
  }

  return {
    ...message,

    content: blocks,

    usage:
      usage ||
      message.usage
  };
}

async function sendClaudeMessagesRequest(
  apiKey,
  requestToClaude
) {
  const requestId =
    crypto.randomUUID();

  const startedAt =
    Date.now();

  const systemLength =
    typeof requestToClaude?.system === "string"
      ? requestToClaude.system.length
      : JSON.stringify(
          requestToClaude?.system || ""
        ).length;

  const messagesJson =
    JSON.stringify(
      requestToClaude?.messages || []
    );

  const toolNames =
    Array.isArray(
      requestToClaude?.tools
    )
      ? requestToClaude.tools
          .map((tool) =>
            tool?.name || null
          )
          .filter(Boolean)
      : [];

  console.log(
    `[CLAUDE][${requestId}] REQUEST`,
    JSON.stringify(
      {
        model:
          requestToClaude?.model || null,
        max_tokens:
          requestToClaude?.max_tokens || null,
        system_chars:
          systemLength,
        messages_chars:
          messagesJson.length,
        message_count:
          Array.isArray(
            requestToClaude?.messages
          )
            ? requestToClaude.messages.length
            : 0,
        tools:
          toolNames,
        tool_choice:
          requestToClaude?.tool_choice || null
      },
      null,
      2
    )
  );

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
            {
              ...requestToClaude,
              stream: true
            }
          )
      }
    );

  // На ошибку (4xx/5xx, включая 524 от Cloudflare перед стартом
  // стрима) Anthropic отвечает обычным телом, не SSE — читаем как
  // текст, как и раньше.
  if (!httpResponse.ok) {
    const responseText =
      await httpResponse.text();

    const durationMs =
      Date.now() -
      startedAt;

    let errorPayload = null;

    try {
      errorPayload =
        JSON.parse(
          responseText
        );
    } catch {
      // Не JSON — логируем исходный ответ ниже.
    }

    console.error(
      `[CLAUDE][${requestId}] HTTP ERROR`,
      JSON.stringify(
        {
          status:
            httpResponse.status,
          duration_ms:
            durationMs,
          body:
            errorPayload ||
            responseText
        },
        null,
        2
      )
    );

    throw new Error(
      errorPayload?.error?.message ||
        `Claude API request failed: HTTP ${httpResponse.status}: ${responseText.slice(0, 5000)}`
    );
  }

  // Стрим включён специально, чтобы Cloudflare-фронт перед Anthropic
  // видел первые байты ответа задолго до 100-секундного порога, даже
  // если сама генерация (например, code_execution с созданием файла)
  // займёт намного дольше. Без stream: true долгие ответы падали с
  // HTTP 524 (Cloudflare "origin didn't respond in time").
  let response;

  try {
    response =
      await parseAnthropicMessageStream(
        httpResponse.body,
        requestId
      );
  } catch (error) {
    const durationMs =
      Date.now() -
      startedAt;

    console.error(
      `[CLAUDE][${requestId}] STREAM ERROR`,
      JSON.stringify(
        {
          status:
            httpResponse.status,
          duration_ms:
            durationMs,
          message:
            error?.message ||
            String(error)
        },
        null,
        2
      )
    );

    throw error;
  }

  const durationMs =
    Date.now() -
    startedAt;

  console.log(
    `[CLAUDE][${requestId}] RESPONSE`,
    JSON.stringify(
      {
        status:
          httpResponse.status,
        duration_ms:
          durationMs,
        response_chars:
          JSON.stringify(
            response
          ).length,
        id:
          response?.id || null,
        model:
          response?.model || null,
        stop_reason:
          response?.stop_reason || null,
        usage:
          response?.usage || null,
        content:
          response?.content || null
      },
      null,
      2
    )
  );

  return {
    httpResponse,
    response
  };
}

function appendSystemInstruction(
  system,
  extraText
) {
  if (!system) {
    return extraText.trim();
  }

  if (
    typeof system ===
    "string"
  ) {
    return `${system}\n\n${extraText.trim()}`;
  }

  if (
    Array.isArray(system)
  ) {
    return [
      ...system,

      {
        type: "text",

        text:
          extraText.trim()
      }
    ];
  }

  return `${String(
    system
  )}\n\n${extraText.trim()}`;
}

function extractMasterInstructionUpdates(
  response
) {
  if (
    !response ||
    !Array.isArray(
      response.content
    )
  ) {
    return [];
  }

  const updates = [];

  for (
    const block of
    response.content
  ) {
    if (
      block?.type ===
        "tool_use" &&
      block?.name ===
        MASTER_UPDATE_PROPOSAL_TOOL.name &&
      Array.isArray(
        block?.input?.updates
      )
    ) {
      updates.push(
        ...block.input
          .updates
      );
    }
  }

  return normalizeMasterUpdates(
    updates
  );
}

function decodeHtmlEntities(
  value
) {
  let result =
    String(value ?? "");

  const named = {
    gt: ">",
    lt: "<",
    amp: "&",
    quot: '"',
    apos: "'",
    nbsp: " "
  };

  // Planfix/HTML может прислать текст как &gt; или даже как
  // &amp;gt;. Делаем несколько безопасных проходов, чтобы внутри
  // Worker всегда сравнивался обычный plain text.
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded =
      result.replace(
        /&(#\d+|#x[0-9a-f]+|gt|lt|amp|quot|apos|nbsp);/gi,
        (match, entity) => {
          const lower =
            String(entity).toLowerCase();

          if (lower.startsWith("#x")) {
            const code =
              parseInt(lower.slice(2), 16);

            return Number.isFinite(code)
              ? String.fromCodePoint(code)
              : match;
          }

          if (lower.startsWith("#")) {
            const code =
              parseInt(lower.slice(1), 10);

            return Number.isFinite(code)
              ? String.fromCodePoint(code)
              : match;
          }

          return Object.prototype.hasOwnProperty.call(
            named,
            lower
          )
            ? named[lower]
            : match;
        }
      );

    if (decoded === result) {
      break;
    }

    result = decoded;
  }

  return result;
}

function normalizeMasterUpdates(
  updates
) {
  if (
    !Array.isArray(
      updates
    )
  ) {
    return [];
  }

  return updates
    .filter(
      (item) =>
        item &&
        typeof item ===
          "object"
    )
    .map(
      (item) => ({
        section:
          decodeHtmlEntities(
            item.section ??
              ""
          ).trim(),

        currentText:
          decodeHtmlEntities(
            item.currentText ??
              ""
          ).trim(),

        proposedText:
          decodeHtmlEntities(
            item.proposedText ??
              ""
          ).trim(),

        reason:
          decodeHtmlEntities(
            item.reason ??
              ""
          ).trim()
      })
    )
    .filter(
      (item) =>
        item.section &&
        item.proposedText
    );
}

function extractForcedToolInput(
  response,
  toolName
) {
  if (
    !response ||
    !Array.isArray(
      response.content
    )
  ) {
    return null;
  }

  const block =
    response.content.find(
      (item) =>
        item?.type ===
          "tool_use" &&
        item?.name ===
          toolName
    );

  return block?.input ||
    null;
}

// ============================================================
// ОЧИСТКА MASTER UPDATE ДЛЯ ПОКАЗА ТЕХНОЛОГУ
// ============================================================

function cleanMasterUpdateText(
  value
) {
  return String(
    value || ""
  )
    // Markdown-заголовки
    .replace(
      /^#{1,6}\s*/gm,
      ""
    )

    // Строки-разделители Markdown-таблиц
    .replace(
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm,
      ""
    )

    // Вертикальные разделители таблиц. В master-updates символ "|"
    // не несёт полезного смысла и не должен попадать в HTML Planfix.
    .replace(
      /\|+/g,
      " "
    )

    // Markdown bold / italic
    .replace(
      /\*\*(.*?)\*\*/g,
      "$1"
    )
    .replace(
      /__(.*?)__/g,
      "$1"
    )
    .replace(
      /\*(.*?)\*/g,
      "$1"
    )

    // Убираем хвостовые пробелы, но сохраняем переносы строк —
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
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

function masterUpdateTextToHtml(
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
) {
  if (
    !Array.isArray(
      updates
    ) ||
    updates.length ===
      0
  ) {
    return "";
  }

  const blocks =
    updates.map(
      (
        update,
        index
      ) => {
        const section =
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
          );

        let html =
          `<p><strong>${index + 1}). п. ${section}</strong></p>`;

        if (current) {
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
        }

        if (
          index <
          updates.length - 1
        ) {
          html +=
            "<hr>";
        }

        return html;
      }
    );

  return (
    "<p><strong>Предлагаемые изменения мастер-инструкции</strong></p>" +
    blocks.join("")
  );
}

// ============================================================
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

function buildMarkdownListAwareRegExp(
  value,
  flags = "g"
) {
  const lines = String(value || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const optionalListPrefix =
    "(?:[ \\t]*(?:[-*+]\\s+|\\d+[.)]\\s+))?";

  const source = lines
    .map((line) =>
      optionalListPrefix +
      line
        .split(/\s+/)
        .map(escapeRegExp)
        .join("\\s+")
    )
    .join("\\s*(?:\\r?\\n)+\\s*");

  return new RegExp(source, flags);
}

function getMarkdownLinePrefix(line) {
  const match = String(line || "").match(
    /^([ \t]*(?:[-*+]\s+|\d+[.)]\s+))/
  );

  return match ? match[1] : "";
}

function formatProposedTextForMatchedMarkdown(
  matchedMarkdown,
  proposedText
) {
  const matchedLines = String(matchedMarkdown || "")
    .split(/\r?\n/)
    .filter((line) => line.trim());

  const proposedLines = String(proposedText || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (proposedLines.length === 0) {
    return "";
  }

  const prefixes = matchedLines
    .map(getMarkdownLinePrefix)
    .filter(Boolean);

  if (prefixes.length === 0) {
    return proposedText;
  }

  const defaultPrefix = prefixes[0];

  return proposedLines
    .map((line, index) =>
      `${prefixes[index] || defaultPrefix}${line}`
    )
    .join("\n");
}

function getMasterSectionDiagnosticSnippet(
  markdown,
  section
) {
  const source = String(markdown || "");
  const wanted = normalizeHeadingText(section);
  if (!source) return "[master is empty]";

  const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gm;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(source)) !== null) {
    headings.push({
      start: match.index,
      level: match[1].length,
      text: match[2]
    });
  }

  const matching = headings.filter(
    (heading) => normalizeHeadingText(heading.text) === wanted
  );
  if (matching.length !== 1) {
    return "[section heading matches: " + matching.length + "]";
  }

  const heading = matching[0];
  const headingIndex = headings.indexOf(heading);
  let sectionEnd = source.length;
  for (let i = headingIndex + 1; i < headings.length; i += 1) {
    if (headings[i].level <= heading.level) {
      sectionEnd = headings[i].start;
      break;
    }
  }

  return source.slice(heading.start, sectionEnd).trim();
}

function replaceApprovedRuleUniquely(
  markdown,
  currentText,
  proposedText,
  section,
  taskNo = "?"
) {
  const exactCount =
    markdown.split(
      currentText
    ).length - 1;

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

  const markdownListPattern =
    buildMarkdownListAwareRegExp(
      currentText,
      "g"
    );

  const markdownListMatches =
    markdownListPattern
      ? [...markdown.matchAll(markdownListPattern)]
      : [];

  console.log(
    `[${taskNo}][MASTER APPLY] MATCH CHECK`,
    JSON.stringify(
      {
        section,
        current_text_chars: currentText.length,
        proposed_text_chars: proposedText.length,
        exact_matches: exactCount,
        flexible_matches: matches.length,
        markdown_list_matches: markdownListMatches.length,
        currentText
      },
      null,
      2
    )
  );

  if (exactCount === 1) {
    console.log(
      `[${taskNo}][MASTER APPLY] MATCH MODE: exact`
    );

    return markdown.replace(
      currentText,
      proposedText
    );
  }

  if (exactCount > 1) {
    console.error(
      `[${taskNo}][MASTER APPLY] MATCH AMBIGUOUS`,
      JSON.stringify({
        section,
        exact_matches: exactCount
      })
    );

    throw new Error(
      `Раздел "${section}": currentText найден более одного раза; автоматическая замена остановлена`
    );
  }

  if (matches.length !== 1) {
    if (markdownListMatches.length === 1) {
      console.log(
        `${taskNo}[MASTER APPLY] MATCH MODE: markdown-list-aware`
      );

      const markdownMatch = markdownListMatches[0];
      const markdownStart = markdownMatch.index;
      const markdownEnd =
        markdownStart + markdownMatch[0].length;

      const formattedProposedText =
        formatProposedTextForMatchedMarkdown(
          markdownMatch[0],
          proposedText
        );

      return (
        markdown.slice(0, markdownStart) +
        formattedProposedText +
        markdown.slice(markdownEnd)
      );
    }

    console.error(
      `[${taskNo}][MASTER APPLY] MATCH FAILED`,
      JSON.stringify(
        {
          section,
          exact_matches: exactCount,
          flexible_matches: matches.length,
          markdown_list_matches: markdownListMatches.length,
          currentText,
          section_snippet:
            getMasterSectionDiagnosticSnippet(
              markdown,
              section
            )
        },
        null,
        2
      )
    );

    throw new Error(
      `Раздел "${section}": currentText не найден однозначно (совпадений: ${matches.length})`
    );
  }

  console.log(
    `[${taskNo}][MASTER APPLY] MATCH MODE: whitespace-flexible`
  );

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
  updates,
  taskNo = "?"
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
          update.section,
          taskNo
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

// ============================================================
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
// ВЕРСИЯ MASTER.MD НА МОМЕНТ ФОРМИРОВАНИЯ ПРЕДЛОЖЕНИЯ
// ============================================================

async function resolveBaseMasterVersion(
  masterInstructionUrl,
  taskNo
) {
  const urls =
    normalizeMasterInstructionUrls(
      masterInstructionUrl
    );

  if (urls.length === 0) {
    return null;
  }

  try {
    const markdown =
      await downloadTextFile(
        urls[0]
      );

    return (
      extractMasterInstructionVersion(
        markdown
      ) || null
    );
  } catch (error) {
    console.warn(
      `[${taskNo}] Не удалось определить baseMasterVersion:`,
      error
    );

    return null;
  }
}

// ============================================================
// СКАЧИВАНИЕ ТЕКСТОВОГО MASTER.MD
// ============================================================

async function downloadTextFile(
  url
) {
  const response =
    await fetch(
      url,
      {
        method: "GET",

        redirect:
          "follow"
      }
    );

  if (!response.ok) {
    throw new Error(
      `File download failed: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  if (
    arrayBuffer.byteLength ===
    0
  ) {
    throw new Error(
      "Downloaded file is empty"
    );
  }

  return new TextDecoder(
    "utf-8"
  ).decode(
    arrayBuffer
  );
}

// ============================================================
// ВЕРСИЯ MASTER-INSTRUCTION
// ============================================================

function extractMasterInstructionVersion(
  markdown
) {
  if (!markdown) {
    return null;
  }

  const patterns = [
    /\*\*Версия:\*\*\s*([0-9]+(?:\.[0-9]+)+)/i,

    /Версия:\s*([0-9]+(?:\.[0-9]+)+)/i,

    /\bversion\s*:?\s*v?([0-9]+(?:\.[0-9]+)+)/i
  ];

  for (
    const pattern of
    patterns
  ) {
    const match =
      markdown.match(
        pattern
      );

    if (match) {
      return match[1];
    }
  }

  return null;
}

function incrementVersion(
  version
) {
  const parts =
    String(version)
      .split(".")
      .map(
        (part) =>
          Number(part)
      );

  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        !Number.isInteger(
          part
        )
    )
  ) {
    throw new Error(
      `Invalid master instruction version: ${version}`
    );
  }

  parts[
    parts.length - 1
  ] += 1;

  return parts.join(".");
}

function formatDateRu(
  date
) {
  const dd =
    String(
      date.getDate()
    ).padStart(
      2,
      "0"
    );

  const mm =
    String(
      date.getMonth() +
        1
    ).padStart(
      2,
      "0"
    );

  const yyyy =
    date.getFullYear();

  return `${dd}.${mm}.${yyyy}`;
}

function getFilenameFromUrl(
  url
) {
  try {
    const parsed =
      new URL(url);

    const last =
      parsed.pathname
        .split("/")
        .filter(Boolean)
        .pop();

    if (!last) {
      return "";
    }

    return decodeURIComponent(
      last.replace(
        /\+/g,
        " "
      )
    );
  } catch {
    return "";
  }
}

function buildMasterInstructionFilename(
  originalFilename,
  version
) {
  return `Мастер-инструкция_v${version.replace(
    /\./g,
    "_"
  )}.md`;
}

// ============================================================
// СКАЧИВАНИЕ ФАЙЛА ИЗ PLANFIX
// ============================================================

async function downloadFileForClaude(
  file
) {
  const response =
    await fetch(
      file.url,
      {
        method: "GET",

        redirect:
          "follow"
      }
    );

  if (!response.ok) {
    throw new Error(
      `File download failed: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  if (
    arrayBuffer.byteLength ===
    0
  ) {
    throw new Error(
      "Downloaded file is empty"
    );
  }

  const declaredType =
    normalizeContentType(
      response.headers.get(
        "content-type"
      )
    );

  const extensionType =
    getMimeTypeFromFilename(
      file.name
    );

  const contentType =
    declaredType ||
    extensionType ||
    "application/octet-stream";

  const isTextFile =
    declaredType ===
      "text/markdown" ||
    declaredType ===
      "text/x-markdown" ||
    declaredType ===
      "application/markdown" ||
    declaredType ===
      "text/plain" ||
    extensionType ===
      "text/markdown" ||
    extensionType ===
      "text/plain";

  if (isTextFile) {
    const text =
      new TextDecoder(
        "utf-8"
      ).decode(
        arrayBuffer
      );

    return {
      type: "text",

      text:
        `Файл "${file.name || "без имени"}":\n\n${text}`
    };
  }

  const base64 =
    arrayBufferToBase64(
      arrayBuffer
    );

  if (
    contentType ===
    "application/pdf"
  ) {
    return {
      type: "document",

      source: {
        type: "base64",

        media_type:
          "application/pdf",

        data:
          base64
      }
    };
  }

  if (
    contentType ===
      "image/jpeg" ||
    contentType ===
      "image/png" ||
    contentType ===
      "image/gif" ||
    contentType ===
      "image/webp"
  ) {
    return {
      type: "image",

      source: {
        type: "base64",

        media_type:
          contentType,

        data:
          base64
      }
    };
  }

  console.warn(
    `Unsupported Claude file type: ${contentType}, file: ${file.name || ""}`
  );

  return null;
}

// ============================================================
// ARRAYBUFFER → BASE64
// ============================================================

function arrayBufferToBase64(
  buffer
) {
  const bytes =
    new Uint8Array(
      buffer
    );

  const chunkSize =
    0x8000;

  let binary =
    "";

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    const chunk =
      bytes.subarray(
        i,
        Math.min(
          i + chunkSize,
          bytes.length
        )
      );

    binary +=
      String.fromCharCode(
        ...chunk
      );
  }

  return btoa(
    binary
  );
}

// ============================================================
// MIME TYPE
// ============================================================

function normalizeContentType(
  contentType
) {
  if (!contentType) {
    return null;
  }

  return contentType
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function getMimeTypeFromFilename(
  filename
) {
  if (!filename) {
    return null;
  }

  const name =
    filename.toLowerCase();

  if (
    name.endsWith(
      ".pdf"
    )
  ) {
    return "application/pdf";
  }

  if (
    name.endsWith(
      ".png"
    )
  ) {
    return "image/png";
  }

  if (
    name.endsWith(
      ".jpg"
    ) ||
    name.endsWith(
      ".jpeg"
    )
  ) {
    return "image/jpeg";
  }

  if (
    name.endsWith(
      ".gif"
    )
  ) {
    return "image/gif";
  }

  if (
    name.endsWith(
      ".webp"
    )
  ) {
    return "image/webp";
  }

  if (
    name.endsWith(
      ".md"
    )
  ) {
    return "text/markdown";
  }

  if (
    name.endsWith(
      ".txt"
    )
  ) {
    return "text/plain";
  }

  return null;
}

// ============================================================
// ФАЙЛЫ, СГЕНЕРИРОВАННЫЕ CLAUDE
// ============================================================

const FILES_API_BETA_HEADER =
  "files-api-2025-04-14";

function findGeneratedFileIds(
  response
) {
  if (
    !response ||
    !Array.isArray(
      response.content
    )
  ) {
    return [];
  }

  const found =
    [];

  function search(
    node
  ) {
    if (
      !node ||
      typeof node !==
        "object"
    ) {
      return;
    }

    if (
      typeof node.file_id ===
        "string" &&
      !found.includes(
        node.file_id
      )
    ) {
      found.push(
        node.file_id
      );
    }

    for (
      const key of
      Object.keys(
        node
      )
    ) {
      const value =
        node[key];

      if (
        Array.isArray(
          value
        )
      ) {
        for (
          const item of
          value
        ) {
          search(
            item
          );
        }
      } else if (
        value &&
        typeof value ===
          "object"
      ) {
        search(
          value
        );
      }
    }
  }

  for (
    const block of
    response.content
  ) {
    search(
      block
    );
  }

  return found;
}

async function fetchGeneratedFileMetadata(
  fileId,
  apiKey
) {
  const response =
    await fetch(
      `https://api.anthropic.com/v1/files/${fileId}`,
      {
        method: "GET",

        headers: {
          "x-api-key":
            apiKey,

          "anthropic-version":
            "2023-06-01",

          "anthropic-beta":
            FILES_API_BETA_HEADER
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

async function fetchGeneratedFileContent(
  fileId,
  apiKey
) {
  const response =
    await fetch(
      `https://api.anthropic.com/v1/files/${fileId}/content`,
      {
        method: "GET",

        headers: {
          "x-api-key":
            apiKey,

          "anthropic-version":
            "2023-06-01",

          "anthropic-beta":
            FILES_API_BETA_HEADER
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

async function downloadGeneratedFile(
  fileId,
  apiKey
) {
  const [
    metadata,
    arrayBuffer
  ] =
    await Promise.all([
      fetchGeneratedFileMetadata(
        fileId,
        apiKey
      ),

      fetchGeneratedFileContent(
        fileId,
        apiKey
      )
    ]);

  return {
    arrayBuffer,

    filename:
      metadata.filename ||
      "file",

    mimeType:
      metadata.mime_type ||
      "application/octet-stream"
  };
}

// ============================================================
// MULTIPART ДЛЯ PLANFIX
// ============================================================

function buildMultipartBody(
  fields,
  file
) {
  const boundary =
    "----ClaudeWorkerBoundary" +
    crypto
      .randomUUID()
      .replace(
        /-/g,
        ""
      );

  const encoder =
    new TextEncoder();

  const parts =
    [];

  for (
    const [
      name,
      value
    ] of Object.entries(
      fields
    )
  ) {
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

  parts.push(
    new Uint8Array(
      file.arrayBuffer
    )
  );

  parts.push(
    encoder.encode(
      `\r\n--${boundary}--\r\n`
    )
  );

  const totalLength =
    parts.reduce(
      (
        sum,
        part
      ) =>
        sum +
        part.byteLength,
      0
    );

  const body =
    new Uint8Array(
      totalLength
    );

  let offset =
    0;

  for (
    const part of
    parts
  ) {
    body.set(
      part,
      offset
    );

    offset +=
      part.byteLength;
  }

  return {
    body,

    contentType:
      `multipart/form-data; boundary=${boundary}`
  };
}

// ============================================================
// ЗАГРУЗКА ФАЙЛА В PLANFIX
// ============================================================

async function uploadFileToPlanfixRest(
  planfixDomen,
  planfixFileUploadToken,
  generatedFile
) {
  const normalizedDomen =
    /^https?:\/\//i.test(
      planfixDomen
    )
      ? planfixDomen
      : `https://${planfixDomen}`;

  const apiBase =
    `${normalizedDomen.replace(
      /\/+$/,
      ""
    )}/rest`;

  const {
    body,
    contentType
  } =
    buildMultipartBody(
      {},
      generatedFile
    );

  const response =
    await fetch(
      `${apiBase}/file/`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${planfixFileUploadToken}`,

          "content-type":
            contentType
        },

        body
      }
    );

  const responseBody =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${responseBody}`
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(
        responseBody
      );
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
// РАЗБОР ИСТОРИИ ПЕРЕПИСКИ
// ============================================================

function parseHistoryToTurns(
  history
) {
  const rawTurns =
    getRawHistoryTurns(
      history
    );

  const merged =
    [];

  for (
    const turn of
    rawTurns
  ) {
    const last =
      merged[
        merged.length - 1
      ];

    if (
      last &&
      last.role ===
        turn.role
    ) {
      last.text +=
        "\n\n" +
        turn.text;
    } else {
      merged.push({
        role:
          turn.role,

        text:
          turn.text
      });
    }
  }

  return merged;
}

function getRawHistoryTurns(
  history
) {
  if (
    Array.isArray(
      history
    )
  ) {
    if (
      history.length >
        0 &&
      history[0] &&
      typeof history[0] ===
        "object" &&
      history[0].analitic
    ) {
      return parseAnalyticsHistoryToTurns(
        history
      );
    }

    return history
      .filter(
        (turn) =>
          turn &&
          typeof turn.text ===
            "string" &&
          turn.text.trim()
      )
      .map(
        (turn) => ({
          role:
            turn.role ===
            "assistant"
              ? "assistant"
              : "user",

          text:
            stripHtmlToPlainText(
              turn.text
            )
        })
      )
      .filter(
        (turn) =>
          turn.text
      );
  }

  if (
    !history ||
    typeof history !==
      "string"
  ) {
    return [];
  }

  const parts =
    history.split(
      /(\[Вопрос\]:|\[Ответ\]:)/
    );

  const rawTurns =
    [];

  let currentRole =
    null;

  let buffer =
    "";

  const flush =
    () => {
      const clean =
        stripHtmlToPlainText(
          buffer
        );

      if (
        currentRole &&
        clean
      ) {
        rawTurns.push({
          role:
            currentRole,

          text:
            clean
        });
      }

      buffer =
        "";
    };

  for (
    const part of
    parts
  ) {
    if (
      part ===
      "[Вопрос]:"
    ) {
      flush();

      currentRole =
        "user";
    } else if (
      part ===
      "[Ответ]:"
    ) {
      flush();

      currentRole =
        "assistant";
    } else {
      buffer +=
        part;
    }
  }

  flush();

  return rawTurns;
}

function parseAnalyticsHistoryToTurns(
  analyticsData
) {
  const dialogEntries =
    analyticsData.filter(
      (entry) =>
        entry?.analitic
          ?.name ===
        "Диалог с ИИ"
    );

  const getFieldValue =
    (
      fields,
      name
    ) => {
      const field =
        Array.isArray(
          fields
        )
          ? fields.find(
              (f) =>
                f &&
                f.name ===
                  name
            )
          : null;

      return field
        ? String(
            field.value ??
              ""
          )
        : "";
    };

  const toSortableDateTime =
    (value) => {
      const match =
        /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(
          value
        );

      if (!match) {
        return "";
      }

      const [
        ,
        dd,
        mm,
        yyyy,
        hh,
        min
      ] = match;

      return `${yyyy}${mm}${dd}${hh}${min}`;
    };

  const extracted =
    dialogEntries.map(
      (entry) => {
        const type =
          getFieldValue(
            entry.data,
            "Тип"
          );

        const text =
          getFieldValue(
            entry.data,
            "Текст"
          );

        const dateTime =
          getFieldValue(
            entry.data,
            "Дата и время"
          );

        return {
          role:
            type ===
            "Вопрос"
              ? "user"
              : "assistant",

          text:
            stripHtmlToPlainText(
              text
            ),

          sortKey:
            toSortableDateTime(
              dateTime
            )
        };
      }
    );

  extracted.sort(
    (
      a,
      b
    ) =>
      a.sortKey.localeCompare(
        b.sortKey
      )
  );

  return extracted
    .filter(
      (turn) =>
        turn.text
    )
    .map(
      (turn) => ({
        role:
          turn.role,

        text:
          turn.text
      })
    );
}

function stripHtmlToPlainText(
  html
) {
  return String(
    html || ""
  )
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<\/p>/gi,
      "\n\n"
    )
    .replace(
      /<[^>]+>/g,
      ""
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

// ============================================================
// СБОРКА MESSAGES ИЗ РАЗОБРАННОЙ ИСТОРИИ
// ============================================================

function buildMessagesFromHistory(
  historyTurns,
  currentQuestion,
  fileBlocks
) {
  const messages =
    [];

  let filesAttached =
    false;

  const pushTurn =
    (
      role,
      contentBlocks
    ) => {
      const last =
        messages[
          messages.length -
            1
        ];

      if (
        last &&
        last.role ===
          role
      ) {
        last.content =
          last.content.concat(
            contentBlocks
          );
      } else {
        messages.push({
          role,

          content:
            contentBlocks
        });
      }
    };

  historyTurns.forEach(
    (
      turn,
      index
    ) => {
      const blocks =
        [];

      if (
        index === 0 &&
        turn.role ===
          "user" &&
        fileBlocks.length >
          0
      ) {
        blocks.push(
          ...fileBlocks
        );

        filesAttached =
          true;
      }

      blocks.push({
        type: "text",

        text:
          turn.text
      });

      pushTurn(
        turn.role,
        blocks
      );
    }
  );

  const finalBlocks =
    [];

  if (!filesAttached) {
    finalBlocks.push(
      ...fileBlocks
    );
  }

  finalBlocks.push({
    type: "text",

    text:
      currentQuestion
  });

  pushTurn(
    "user",
    finalBlocks
  );

  return messages;
}

// ============================================================
// ЗАМЕНА BASE64 ФАЙЛОВ НА МЕТКУ
// ============================================================

function stripFileData(
  messages
) {
  if (
    !Array.isArray(
      messages
    )
  ) {
    return messages;
  }

  return messages.map(
    (message) => {
      if (
        !message ||
        !Array.isArray(
          message.content
        )
      ) {
        return message;
      }

      return {
        ...message,

        content:
          message.content.map(
            (block) => {
              if (
                block &&
                (
                  block.type ===
                    "image" ||
                  block.type ===
                    "document"
                ) &&
                block.source
              ) {
                return {
                  ...block,

                  source: {
                    ...block.source,

                    data:
                      "[omitted]"
                  }
                };
              }

              return block;
            }
          )
      };
    }
  );
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ТЕКСТА ИЗ ОТВЕТА CLAUDE
// ============================================================

function extractClaudeText(
  response
) {
  if (
    !response ||
    !Array.isArray(
      response.content
    )
  ) {
    return "";
  }

  return response.content
    .filter(
      (block) =>
        block &&
        block.type ===
          "text" &&
        typeof block.text ===
          "string"
    )
    .map(
      (block) =>
        block.text
    )
    .join(
      "\n\n"
    );
}

// ============================================================
// ИЗВЛЕЧЕНИЕ USAGE
// ============================================================

function extractUsage(
  response
) {
  const usage =
    response?.usage ||
    {};

  const inputTokens =
    usage.input_tokens ??
    0;

  const outputTokens =
    usage.output_tokens ??
    0;

  const cacheCreationTokens =
    usage.cache_creation_input_tokens ??
    0;

  const cacheReadTokens =
    usage.cache_read_input_tokens ??
    0;

  return {
    input_tokens:
      inputTokens,

    output_tokens:
      outputTokens,

    cache_creation_input_tokens:
      cacheCreationTokens,

    cache_read_input_tokens:
      cacheReadTokens,

    total_tokens:
      inputTokens +
      outputTokens +
      cacheCreationTokens +
      cacheReadTokens
  };
}

// ============================================================
// ЦЕНЫ ЗА МИЛЛИОН ТОКЕНОВ
// ============================================================

const PRICING_PER_MILLION_TOKENS = {
  "claude-haiku-4-5-20251001": {
    input: 1,
    output: 5
  },

  "claude-haiku-4-5": {
    input: 1,
    output: 5
  },

  "claude-sonnet-5": {
    input: 2,
    output: 10
  },

  "claude-opus-5": {
    input: 5,
    output: 25
  },

  "claude-fable-5": {
    input: 10,
    output: 50
  },

  "claude-mythos-5": {
    input: 10,
    output: 50
  }
};

const CACHE_WRITE_MULTIPLIER =
  1.25;

const CACHE_READ_MULTIPLIER =
  0.1;

function estimateCostUsd(
  model,
  usage
) {
  const pricing =
    PRICING_PER_MILLION_TOKENS[
      model
    ];

  if (!pricing) {
    return null;
  }

  const cacheWritePrice =
    pricing.input *
    CACHE_WRITE_MULTIPLIER;

  const cacheReadPrice =
    pricing.input *
    CACHE_READ_MULTIPLIER;

  const costUsd =
    (
      usage.input_tokens *
        pricing.input +

      usage.output_tokens *
        pricing.output +

      usage.cache_creation_input_tokens *
        cacheWritePrice +

      usage.cache_read_input_tokens *
        cacheReadPrice
    ) /
    1_000_000;

  return (
    Math.round(
      costUsd *
        1_000_000
    ) /
    1_000_000
  );
}

// ============================================================
// MARKDOWN → HTML
// ============================================================

function markdownToHtml(
  markdown
) {
  if (!markdown) {
    return "";
  }

  let text =
    escapeHtml(
      markdown
    );

  const codeBlocks =
    [];

  text =
    text.replace(
      /```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g,
      (
        _,
        code
      ) => {
        const index =
          codeBlocks.length;

        codeBlocks.push(
          `<pre><code>${code.trim()}</code></pre>`
        );

        return `@@CLAUDE_CODE_BLOCK_${index}@@`;
      }
    );

  text =
    text.replace(
      /`([^`\n]+)`/g,
      "<code>$1</code>"
    );

  text =
    text.replace(
      /^######\s+(.+)$/gm,
      "<h6>$1</h6>"
    );

  text =
    text.replace(
      /^#####\s+(.+)$/gm,
      "<h5>$1</h5>"
    );

  text =
    text.replace(
      /^####\s+(.+)$/gm,
      "<h4>$1</h4>"
    );

  text =
    text.replace(
      /^###\s+(.+)$/gm,
      "<h3>$1</h3>"
    );

  text =
    text.replace(
      /^##\s+(.+)$/gm,
      "<h2>$1</h2>"
    );

  text =
    text.replace(
      /^#\s+(.+)$/gm,
      "<h1>$1</h1>"
    );

  text =
    text.replace(
      /\*\*\*(.+?)\*\*\*/g,
      "<strong><em>$1</em></strong>"
    );

  text =
    text.replace(
      /___(.+?)___/g,
      "<strong><em>$1</em></strong>"
    );

  text =
    text.replace(
      /\*\*(.+?)\*\*/g,
      "<strong>$1</strong>"
    );

  text =
    text.replace(
      /__(.+?)__/g,
      "<strong>$1</strong>"
    );

  text =
    text.replace(
      /(^|[^\*])\*([^*\n]+)\*/g,
      "$1<em>$2</em>"
    );

  text =
    text.replace(
      /(^|[^\w])_([^_\n]+)_/g,
      "$1<em>$2</em>"
    );

  text =
    text.replace(
      /~~(.+?)~~/g,
      "<del>$1</del>"
    );

  text =
    text.replace(
      /\+\+(.+?)\+\+/g,
      "<u>$1</u>"
    );

  text =
    text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2">$1</a>'
    );

  text =
    text.replace(
      /^\s*(---|\*\*\*|___)\s*$/gm,
      "<hr>"
    );

  text =
    convertLists(
      text
    );

  const blocks =
    text.split(
      /\n{2,}/
    );

  text =
    blocks
      .map(
        (block) => {
          const trimmed =
            block.trim();

          if (!trimmed) {
            return "";
          }

          if (
            /^<(h[1-6]|ul|ol|pre|blockquote|hr)/i.test(
              trimmed
            )
          ) {
            return trimmed.replace(
              /\n/g,
              ""
            );
          }

          return `<p>${trimmed.replace(
            /\n/g,
            "<br>"
          )}</p>`;
        }
      )
      .join("\n");

  codeBlocks.forEach(
    (
      code,
      index
    ) => {
      text =
        text.replace(
          `@@CLAUDE_CODE_BLOCK_${index}@@`,
          code
        );
    }
  );

  return text;
}

// ============================================================
// MARKDOWN LISTS → HTML
// ============================================================

function convertLists(
  text
) {
  const lines =
    text.split("\n");

  const output =
    [];

  let listType =
    null;

  for (
    const line of
    lines
  ) {
    const unordered =
      line.match(
        /^\s*[-*+]\s+(.+)$/
      );

    const ordered =
      line.match(
        /^\s*\d+\.\s+(.+)$/
      );

    if (unordered) {
      if (
        listType !==
        "ul"
      ) {
        if (listType) {
          output.push(
            `</${listType}>`
          );
        }

        output.push(
          "<ul>"
        );

        listType =
          "ul";
      }

      output.push(
        `<li>${unordered[1]}</li>`
      );

      continue;
    }

    if (ordered) {
      if (
        listType !==
        "ol"
      ) {
        if (listType) {
          output.push(
            `</${listType}>`
          );
        }

        output.push(
          "<ol>"
        );

        listType =
          "ol";
      }

      output.push(
        `<li>${ordered[1]}</li>`
      );

      continue;
    }

    if (listType) {
      output.push(
        `</${listType}>`
      );

      listType =
        null;
    }

    output.push(
      line
    );
  }

  if (listType) {
    output.push(
      `</${listType}>`
    );
  }

  return output.join(
    "\n"
  );
}

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(
  value
) {
  return String(
    value
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

// ============================================================
// CALLBACK В PLANFIX
// ============================================================

async function sendCallback(
  callback,
  payload
) {
  const response =
    await fetch(
      callback,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            payload
          )
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Planfix callback failed: HTTP ${response.status}: ${body}`
    );
  }

  return response;
}

// ============================================================
// УСТОЙЧИВЫЙ ПАРСИНГ JSON
// ============================================================

async function readSanitizedJson(
  request
) {
  const rawBody =
    await request.text();

  const sanitized =
    sanitizeJsonControlChars(
      rawBody
    );

  return JSON.parse(
    sanitized
  );
}

function sanitizeJsonControlChars(
  raw
) {
  let result =
    "";

  let inString =
    false;

  let escaped =
    false;

  for (
    let i = 0;
    i < raw.length;
    i++
  ) {
    const char =
      raw[i];

    const code =
      raw.charCodeAt(i);

    if (inString) {
      if (escaped) {
        result +=
          char;

        escaped =
          false;

        continue;
      }

      if (
        char === "\\"
      ) {
        result +=
          char;

        escaped =
          true;

        continue;
      }

      if (
        char === '"'
      ) {
        inString =
          false;

        result +=
          char;

        continue;
      }

      if (
        code < 0x20
      ) {
        switch (char) {
          case "\n":
            result +=
              "\\n";
            break;

          case "\r":
            result +=
              "\\r";
            break;

          case "\t":
            result +=
              "\\t";
            break;

          default:
            result +=
              "\\u" +
              code
                .toString(
                  16
                )
                .padStart(
                  4,
                  "0"
                );
        }

        continue;
      }

      result +=
        char;

      continue;
    }

    if (
      char === '"'
    ) {
      inString =
        true;
    }

    result +=
      char;
  }

  return result;
}

// ============================================================
// ПОИСК ЛИДОВ (браузер дашборда → воркер, синхронно, без очереди)
// ============================================================
// Очередь TASK_QUEUE заточена под Planfix-callback флоу (задача →
// вебхук). Эта фича вызывается напрямую из браузера и должна сразу
// вернуть JSON, поэтому идёт отдельным путём мимо очереди.

const LEAD_SEARCH_ALLOWED_ORIGIN = "https://sam-nic.github.io";

const LEAD_SEARCH_CORS_HEADERS = {
  "Access-Control-Allow-Origin": LEAD_SEARCH_ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function leadSearchJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...LEAD_SEARCH_CORS_HEADERS
    }
  });
}

// Planfix REST — id полей/справочников, найденные и закреплённые
// вручную в аккаунте seppra в переписке с технологом.
const PLANFIX_BASE = "https://seppra.planfix.ru/rest";
const PF_FIELD_INN = 32804;
const PF_FIELD_GROUPS = 32950;
const PF_FIELD_SOURCE = 33380;
const PF_FIELD_MANAGER = 33226;
const PF_FIELD_REGION = 33508;
const PF_MANAGER_USER_ID = "user:32"; // Андрей Надысин
const PF_GROUP_CLIENT_ID = 1; // "Клиент" в справочнике групп (2096)
const PF_DIR_SOURCE_ID = 2164; // "Источники входа и каналы коммуникаций"
const PF_DIR_SOURCE_NAME_FIELD = 5544;
const PF_DIR_REGION_ID = 2166; // "Регионы"
const PF_DIR_REGION_NAME_FIELD = 5552;
const PF_MAIN_FIELD_CLAUDE_TOKEN = 33572; // общее поле "Claude Token"
const PF_MAIN_FIELD_CLAUDE_MODEL = 33580; // "Claude model COMPANY_UPLOAD"
const PF_TASK_TEMPLATE_CLIENT_REQUEST = 127492; // шаблон "Запрос клиента"

async function planfixRequest(token, method, path, body) {
  const response = await fetch(`${PLANFIX_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}

async function getPlanfixMainFieldValue(token, fieldId) {
  const data = await planfixRequest(
    token,
    "GET",
    "/customfield/main?fields=id,name,mainValue"
  );
  const field = (data.customfields || []).find(
    (f) => f.id === fieldId
  );
  return field ? field.mainValue || "" : "";
}

async function fetchClientProfileKeywords(token) {
  // Дёшево: только имена задач "Запрос клиента" (без полного
  // описания) — из названия уже видно товарную категорию и клиента.
  const data = await planfixRequest(token, "POST", "/task/list", {
    offset: 0,
    pageSize: 80,
    filters: [
      {
        type: 51,
        operator: "equal",
        value: PF_TASK_TEMPLATE_CLIENT_REQUEST
      }
    ],
    fields: "id,name"
  });
  return (data.tasks || [])
    .map((t) => t.name)
    .filter(Boolean)
    .slice(0, 80);
}

async function fetchPlanfixDirectoryEntries(
  token,
  directoryId,
  nameFieldId
) {
  const data = await planfixRequest(
    token,
    "POST",
    `/directory/${directoryId}/entry/list`,
    { offset: 0, pageSize: 100, fields: `key,${nameFieldId}` }
  );
  return (data.directoryEntries || [])
    .map((e) => {
      const cf = (e.customFieldData || [])[0];
      return cf ? { id: e.key, name: cf.value } : null;
    })
    .filter(Boolean);
}

async function findPlanfixDuplicateByInn(token, inn) {
  if (!inn) return null;
  const data = await planfixRequest(token, "POST", "/contact/list", {
    offset: 0,
    pageSize: 5,
    filters: [
      {
        type: 4102,
        field: PF_FIELD_INN,
        operator: "equal",
        value: inn
      }
    ],
    fields: "id,name"
  });
  return (data.contacts || [])[0] || null;
}

function isValidRussianInn(inn) {
  if (!/^\d{10}$/.test(inn || "")) return false;
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const digits = inn.split("").map(Number);
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  return (sum % 11) % 10 === digits[9];
}

const LEAD_CANDIDATES_TOOL = {
  name: "return_lead_candidates",
  description:
    "Верни итоговый список найденных компаний-кандидатов после веб-поиска. Вызывай ровно один раз, когда поиск закончен.",
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description:
          "Короткое сообщение пользователю (1-3 предложения) о том, что нашли и почему."
      },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            inn: {
              type: "string",
              description:
                "10-значный ИНН российского юрлица, если удалось найти. Пустая строка, если не найден — НЕ придумывай."
            },
            site: { type: "string" },
            phones: {
              type: "array",
              items: { type: "string" }
            },
            email: { type: "string" },
            region_guess: {
              type: "string",
              description:
                "Регион РФ по адресу компании (например: 'Свердловская обл', 'Москва')."
            },
            fit: {
              type: "string",
              enum: ["ok", "medium", "risky"]
            },
            fit_reason: {
              type: "string",
              description:
                "Одна короткая фраза — почему такая оценка соответствия профилю."
            }
          },
          required: ["name", "fit"]
        }
      }
    },
    required: ["reply", "candidates"]
  }
};

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search"
};

function buildLeadSearchSystemPrompt(
  profileKeywords,
  activities,
  regions,
  nomenclature
) {
  let prompt =
    "Ты помогаешь отделу продаж компании Seppra искать новых потенциальных клиентов (лидов) в интернете.\n\n" +
    "Seppra — контрактный производитель точных металлических деталей (втулки, гайки, шпильки, оси, фланцы, корпуса — токарная/фрезерная обработка, часто из давальческого сырья заказчика). Клиенты Seppra — производители приборов, авиатехники, автокомпонентов, газового оборудования, часть — с гособоронзаказом.\n\n" +
    "Правила:\n" +
    "- Ищи через web_search реальные российские компании (юрлица), похожие по профилю на клиентов Seppra.\n" +
    "- Для каждой компании старайся найти официальный сайт, реальный ИНН (10 цифр), телефон и/или email, регион.\n" +
    "- НИКОГДА не придумывай ИНН, телефоны и email — если не нашёл, оставь поле пустым.\n" +
    "- Пометь fit='risky' для компаний, которые больше похожи на НИОКР-организацию, дистрибьютора или оптового торговца, а не на серийного производителя.\n" +
    "- Когда поиск закончен, вызови tool return_lead_candidates ровно один раз со всем списком.\n";

  if (profileKeywords && profileKeywords.length) {
    prompt +=
      "\nДля ориентира — реальные названия недавних запросов от клиентов Seppra (товарная категория | название клиента):\n" +
      profileKeywords.slice(0, 60).join("\n");
  }
  if (activities && activities.length) {
    prompt += `\n\nИщи только среди компаний со следующими видами деятельности: ${activities.join(
      ", "
    )}.`;
  }
  if (regions && regions.length) {
    prompt += `\n\nИщи только среди компаний из следующих регионов: ${regions.join(
      ", "
    )}.`;
  }
  if (nomenclature && nomenclature.length) {
    prompt += `\n\nИщи только компании, которым может понадобиться следующая номенклатура работ Seppra: ${nomenclature.join(
      ", "
    )}.`;
  }
  return prompt;
}

async function handleLeadSearchRoute(request, env, pathname) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: LEAD_SEARCH_CORS_HEADERS
    });
  }
  if (request.method !== "POST") {
    return leadSearchJsonResponse(
      { success: false, error: "Method not allowed" },
      405
    );
  }

  const planfixToken = env.PLANFIX_COMPANY_UPLOAD_KEY;
  if (!planfixToken) {
    return leadSearchJsonResponse(
      {
        success: false,
        error:
          "PLANFIX_COMPANY_UPLOAD_KEY не настроен в секретах воркера"
      },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return leadSearchJsonResponse(
      { success: false, error: "Invalid JSON body" },
      400
    );
  }

  try {
    if (pathname === "/lead-search/query") {
      return await handleLeadSearchQuery(body, planfixToken);
    }
    if (pathname === "/lead-search/check") {
      return await handleLeadSearchCheck(body, planfixToken);
    }
    return await handleLeadSearchUpload(body, planfixToken);
  } catch (error) {
    console.error("[lead-search] error:", error);
    return leadSearchJsonResponse(
      { success: false, error: error.message || String(error) },
      500
    );
  }
}

async function handleLeadSearchQuery(body, planfixToken) {
  const {
    message,
    history = [],
    useProfile = false,
    activities = [],
    regions = [],
    nomenclature = []
  } = body || {};

  if (!message || !String(message).trim()) {
    return leadSearchJsonResponse(
      { success: false, error: "message is required" },
      400
    );
  }

  const [claudeToken, claudeModel] = await Promise.all([
    getPlanfixMainFieldValue(planfixToken, PF_MAIN_FIELD_CLAUDE_TOKEN),
    getPlanfixMainFieldValue(planfixToken, PF_MAIN_FIELD_CLAUDE_MODEL)
  ]);

  if (!claudeToken) {
    return leadSearchJsonResponse(
      {
        success: false,
        error:
          "Не удалось прочитать ключ Claude из общего поля Planfix (id 33572)"
      },
      500
    );
  }

  let profileKeywords = [];
  if (useProfile) {
    try {
      profileKeywords = await fetchClientProfileKeywords(planfixToken);
    } catch (error) {
      console.error("[lead-search] profile fetch failed:", error);
    }
  }

  const system = buildLeadSearchSystemPrompt(
    profileKeywords,
    activities,
    regions,
    nomenclature
  );

  const messages = [
    ...history.map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content
    })),
    { role: "user", content: message }
  ];

  const { response: claudeResponse } = await sendClaudeMessagesRequest(
    claudeToken,
    {
      model: claudeModel || "claude-sonnet-5",
      max_tokens: 4096,
      system,
      messages,
      tools: [WEB_SEARCH_TOOL, LEAD_CANDIDATES_TOOL],
      tool_choice: { type: "auto" }
    }
  );

  const toolInput = extractForcedToolInput(
    claudeResponse,
    "return_lead_candidates"
  );

  if (!toolInput) {
    // Модель не вызвала итоговый tool (например, задала уточняющий
    // вопрос текстом) — просто возвращаем её текст в чат.
    return leadSearchJsonResponse({
      success: true,
      reply:
        extractClaudeText(claudeResponse) ||
        "Не удалось получить ответ, попробуйте переформулировать запрос.",
      candidates: []
    });
  }

  const rawCandidates = Array.isArray(toolInput.candidates)
    ? toolInput.candidates
    : [];

  // Детерминированная проверка: контрольная сумма ИНН + дубли в Planfix.
  const candidates = await Promise.all(
    rawCandidates.map(async (c) => {
      const inn = (c.inn || "").replace(/\D/g, "");
      const innValid = inn ? isValidRussianInn(inn) : null;
      let duplicate = null;
      if (inn && innValid) {
        try {
          duplicate = await findPlanfixDuplicateByInn(
            planfixToken,
            inn
          );
        } catch (error) {
          console.error("[lead-search] dedup check failed:", error);
        }
      }
      return {
        name: c.name || "",
        inn,
        innValid,
        site: c.site || "",
        phones: Array.isArray(c.phones) ? c.phones : [],
        email: c.email || "",
        regionGuess: c.region_guess || "",
        fit: c.fit || "medium",
        fitReason: c.fit_reason || "",
        isDuplicate: Boolean(duplicate),
        duplicateOf: duplicate
          ? { id: duplicate.id, name: duplicate.name }
          : null
      };
    })
  );

  return leadSearchJsonResponse({
    success: true,
    reply: toolInput.reply || "",
    candidates
  });
}

async function handleLeadSearchCheck(body, planfixToken) {
  const { inns = [] } = body || {};
  if (!Array.isArray(inns) || inns.length === 0) {
    return leadSearchJsonResponse({ success: true, results: [] });
  }

  const results = await Promise.all(
    inns.map(async (rawInn) => {
      const inn = String(rawInn || "").replace(/\D/g, "");
      if (!inn) return { inn: rawInn, isDuplicate: false, duplicateOf: null };
      let duplicate = null;
      try {
        duplicate = await findPlanfixDuplicateByInn(planfixToken, inn);
      } catch (error) {
        console.error("[lead-search] check failed:", error);
      }
      return {
        inn,
        isDuplicate: Boolean(duplicate),
        duplicateOf: duplicate
          ? { id: duplicate.id, name: duplicate.name }
          : null
      };
    })
  );

  return leadSearchJsonResponse({ success: true, results });
}

async function findOrCreatePlanfixDirectoryEntry(
  token,
  directoryId,
  nameFieldId,
  name
) {
  const entries = await fetchPlanfixDirectoryEntries(
    token,
    directoryId,
    nameFieldId
  );
  const existing = entries.find(
    (e) => e.name && e.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing.id;

  const created = await planfixRequest(
    token,
    "POST",
    `/directory/${directoryId}/entry`,
    {
      customFieldData: [{ field: { id: nameFieldId }, value: name }]
    }
  );
  if (created.result !== "success" || !created.key) {
    throw new Error(
      `Не удалось создать значение справочника "${name}": ${
        created.error || "unknown"
      }`
    );
  }
  return created.key;
}

async function handleLeadSearchUpload(body, planfixToken) {
  const { companies = [], source } = body || {};

  if (!Array.isArray(companies) || companies.length === 0) {
    return leadSearchJsonResponse(
      { success: false, error: "companies must be a non-empty array" },
      400
    );
  }
  if (!source || !String(source).trim()) {
    return leadSearchJsonResponse(
      { success: false, error: "source is required" },
      400
    );
  }

  const [sourceId, regionEntries] = await Promise.all([
    findOrCreatePlanfixDirectoryEntry(
      planfixToken,
      PF_DIR_SOURCE_ID,
      PF_DIR_SOURCE_NAME_FIELD,
      source.trim()
    ),
    fetchPlanfixDirectoryEntries(
      planfixToken,
      PF_DIR_REGION_ID,
      PF_DIR_REGION_NAME_FIELD
    )
  ]);

  const results = [];
  for (const company of companies) {
    try {
      const inn = (company.inn || "").replace(/\D/g, "");
      const cfd = [
        {
          field: { id: PF_FIELD_GROUPS },
          value: [{ id: PF_GROUP_CLIENT_ID }]
        },
        { field: { id: PF_FIELD_SOURCE }, value: { id: sourceId } },
        {
          field: { id: PF_FIELD_MANAGER },
          value: { id: PF_MANAGER_USER_ID }
        }
      ];
      if (inn) {
        cfd.push({ field: { id: PF_FIELD_INN }, value: inn });
      }
      const regionMatch = regionEntries.find(
        (r) =>
          r.name &&
          company.regionGuess &&
          r.name.toLowerCase() ===
            String(company.regionGuess).toLowerCase().trim()
      );
      if (regionMatch) {
        cfd.push({
          field: { id: PF_FIELD_REGION },
          value: { id: regionMatch.id }
        });
      }

      const createBody = {
        template: { id: 2 },
        name: company.name,
        isCompany: true,
        customFieldData: cfd
      };
      if (company.site) createBody.site = company.site;
      if (company.email) createBody.email = company.email;
      if (Array.isArray(company.phones) && company.phones.length) {
        createBody.phones = company.phones.map((p) => ({
          number: p,
          type: 4
        }));
      }

      const created = await planfixRequest(
        planfixToken,
        "POST",
        "/contact",
        createBody
      );

      if (created.result === "success") {
        results.push({ name: company.name, status: "created", id: created.id });
      } else {
        results.push({
          name: company.name,
          status: "error",
          error: created.error || "unknown error"
        });
      }
    } catch (error) {
      results.push({
        name: company.name,
        status: "error",
        error: error.message || String(error)
      });
    }
  }

  return leadSearchJsonResponse({ success: true, source, sourceId, results });
}

// ============================================================
// JSON RESPONSE
// ============================================================

function jsonResponse(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data
    ),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8"
      }
    }
  );
}
