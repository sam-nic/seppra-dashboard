// ============================================================
// ВЕРСИЯ ПРИЛОЖЕНИЯ
// ============================================================
// Порядковый номер + дата правки. Обновляйте вручную при каждом
// значимом изменении index.js — так в комментариях Planfix и
// через GET-запрос всегда видно, какая именно версия задеплоена.
const APP_VERSION = "31-2026-08-13";

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
                "Текущая формулировка, если меняется существующее правило. Для нового правила — пустая строка."
            },
            proposedText: {
              type: "string",
              description:
                "Готовая формулировка, которую предлагается внести в мастер-инструкцию."
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

const MASTER_UPDATE_PROTOCOL = `
ДОПОЛНИТЕЛЬНЫЙ ПРОТОКОЛ ИНТЕГРАЦИИ С MASTER-ИНСТРУКЦИЕЙ:

Если в текущем диалоге замечание технолога/метролога выявляет новый класс ошибки или требует уточнить существующее правило мастер-инструкции, сформулируй конкретные предлагаемые изменения и вызови tool propose_master_instruction_updates.

В tool передавай полный набор изменений, относящихся к текущему замечанию.

Если изменение инструкции не требуется (например, замечание уже полностью покрывается существующим правилом), tool не вызывай.

Обычный ответ пользователю формируй как обычно. Если вызываешь tool, сначала закончи содержательный текстовый ответ пользователю, затем вызови tool.

Не вставляй служебный JSON updates в обычный текст ответа.
`;

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

      // ======================================================
      // БАЗОВАЯ ВАЛИДАЦИЯ
      // ======================================================

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

      // operation может быть либо отсутствующим,
      // либо одной из двух специальных операций.
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

      // ======================================================
      // ОБЫЧНЫЙ ДИАЛОГ
      // ======================================================

      // Если operation отсутствует — работаем как раньше.
      if (!operation && !callback) {
        return jsonResponse(
          {
            success: false,
            error: "callback is required for dialog requests"
          },
          400
        );
      }

      // ======================================================
      // КОРРЕКТИРОВКА ПРЕДЛОЖЕННЫХ ИЗМЕНЕНИЙ
      // ======================================================

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

      // ======================================================
      // ПРИМЕНЕНИЕ УТВЕРЖДЁННЫХ ИЗМЕНЕНИЙ
      // ======================================================

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

        if (!masterInstructionUrl) {
          return jsonResponse(
            {
              success: false,
              error:
                "masterInstructionUrl is required for apply_master_updates"
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

      // ======================================================
      // ОТПРАВЛЯЕМ В QUEUE
      // ======================================================

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

      // Planfix сразу получает подтверждение.
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

  // ==========================================================
  // QUEUE CONSUMER
  // ==========================================================

  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const taskPayload = message.body;

      const operation =
        taskPayload.operation || "dialog";

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
        // Каждый специализированный обработчик сам пытается
        // отправить ошибку в соответствующий callback.
        //
        // Здесь повторный вызов намеренно не запускаем:
        // иначе можно получить повторный платный запрос Claude
        // и/или повторную загрузку файла в Planfix.
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
  claudeRequest
}) {
  let sentRequest = null;

  console.log(
    `[${taskNo}] Старт диалога, файлов на входе: ${
      Array.isArray(files) ? files.length : 0
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
            await downloadFileForClaude(file);

          if (block) {
            fileBlocks.push(block);

            console.log(
              `[${taskNo}] Скачан входной файл: ${
                file.name || "без имени"
              }`
            );
          }
        } catch (error) {
          console.error(
            `Failed to download file "${
              file.name || file.url
            }":`,
            error
          );
        }
      }
    }

    // --------------------------------------------------------
    // 2. Строим историю
    // --------------------------------------------------------

    const historyTurns =
      parseHistoryToTurns(history);

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
      messages
    };

    // Дополняем system специальным протоколом.
    requestToClaude.system =
      appendSystemInstruction(
        requestToClaude.system,
        MASTER_UPDATE_PROTOCOL
      );

    // --------------------------------------------------------
    // 3.1. Tools
    // --------------------------------------------------------

    const existingTools =
      Array.isArray(requestToClaude.tools)
        ? requestToClaude.tools
        : [];

    const filteredTools =
      existingTools.filter(
        (tool) =>
          tool &&
          tool.name !==
            MASTER_UPDATE_PROPOSAL_TOOL.name
      );

    const alreadyHasCodeExecution =
      filteredTools.some(
        (tool) =>
          tool &&
          tool.name === "code_execution"
      );

    const tools = [
      ...filteredTools
    ];

    if (!alreadyHasCodeExecution) {
      tools.push({
        type:
          "code_execution_20250825",
        name: "code_execution"
      });
    }

    tools.push(
      MASTER_UPDATE_PROPOSAL_TOOL
    );

    requestToClaude.tools = tools;

    // Что реально отправили Claude —
    // base64 в callback не тащим.
    sentRequest = {
      ...requestToClaude,
      messages:
        stripFileData(messages)
    };

    // --------------------------------------------------------
    // 4. Отправляем запрос Claude
    // --------------------------------------------------------

    console.log(
      `[${taskNo}] Отправляю диалог в Claude API (модель: ${
        requestToClaude.model
      }, max_tokens: ${
        requestToClaude.max_tokens
      })`
    );

    const claudeResponse =
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

    let response;

    try {
      response =
        await claudeResponse.json();
    } catch (error) {
      const rawText =
        await claudeResponse.text();

      throw new Error(
        `Claude returned invalid JSON. Status ${claudeResponse.status}: ${rawText}`
      );
    }

    console.log(
      `[${taskNo}] Ответ от Claude получен, HTTP ${claudeResponse.status}, stop_reason: ${response?.stop_reason}`
    );

    // --------------------------------------------------------
    // 5. Ошибка Claude
    // --------------------------------------------------------

    if (!claudeResponse.ok) {
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
            response?.error?.message ||
            "Claude API request failed",

          response
        }
      );

      return;
    }

    // --------------------------------------------------------
    // 6. Текст + usage
    // --------------------------------------------------------

    const claudeText =
      extractClaudeText(response);

    const usage =
      extractUsage(response);

    const estimatedCostUsd =
      estimateCostUsd(
        requestToClaude.model,
        usage
      );

    // --------------------------------------------------------
    // 7. Файлы Claude → Planfix
    // --------------------------------------------------------

    const uploadedFileIds = [];
    const fileDeliveryErrors = [];

    const generatedFileIds =
      findGeneratedFileIds(response);

    console.log(
      `[${taskNo}] Найдено сгенерированных файлов в ответе: ${generatedFileIds.length}`
    );

    for (
      const fileId of
      generatedFileIds
    ) {
      let generatedFile;

      try {
        generatedFile =
          await downloadGeneratedFile(
            fileId,
            apiKey
          );
      } catch (error) {
        fileDeliveryErrors.push(
          `Не удалось скачать файл ${fileId} у Claude: ${error.message}`
        );

        continue;
      }

      if (
        !planfixFileUploadToken ||
        !planfixDomen
      ) {
        fileDeliveryErrors.push(
          `Файл "${generatedFile.filename}" сгенерирован, но planfixFileUploadToken/planfixDomen не переданы`
        );

        continue;
      }

      try {
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
      } catch (error) {
        fileDeliveryErrors.push(
          `Planfix REST API отклонил файл "${generatedFile.filename}": ${error.message}`
        );
      }
    }

    const fileDeliveryError =
      fileDeliveryErrors.length > 0
        ? fileDeliveryErrors.join(
            " | "
          )
        : null;

    // --------------------------------------------------------
    // 8. Добавляем заметку про созданные файлы
    // --------------------------------------------------------

    let claudeTextWithFileNote =
      claudeText;

    if (
      uploadedFileIds.length > 0
    ) {
      const fileNames =
        uploadedFileIds
          .map((f) => f.name)
          .join(", ");

      claudeTextWithFileNote +=
        `\n\n[Файл${
          uploadedFileIds.length > 1
            ? "ы"
            : ""
        }, созданны${
          uploadedFileIds.length > 1
            ? "е"
            : "й"
        } мной в этом ответе: ${fileNames}]`;
    }

    // --------------------------------------------------------
    // 9. HTML
    // --------------------------------------------------------

    const html =
      markdownToHtml(
        claudeTextWithFileNote
      );

    // --------------------------------------------------------
    // 10. Обычный callback
    // --------------------------------------------------------

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

        // ФОРМАТ НЕ МЕНЯЕМ:
        // массив числовых ID.
        files:
          uploadedFileIds.map(
            (f) => f.id
          ),

        file_delivery_error:
          fileDeliveryError,

        response
      }
    );

    // --------------------------------------------------------
    // 11. Предлагаемые изменения мастер-инструкции
    // --------------------------------------------------------

    const proposedUpdates =
      extractMasterInstructionUpdates(
        response
      );

    if (
      proposedUpdates.length > 0
    ) {
      console.log(
        `[${taskNo}] Получено предлагаемых изменений master-инструкции: ${proposedUpdates.length}`
      );

      if (!updatesCallback) {
        console.warn(
          `[${taskNo}] updatesCallback не передан — предложения не отправлены`
        );
      } else {
        const normalizedUpdates =
          normalizeMasterUpdates(
            proposedUpdates
          );

        const updatesHtml =
          formatMasterUpdatesHtml(
            normalizedUpdates
          );

        await sendCallback(
          updatesCallback,
          {
            taskNo,

            success: true,

            userEmail:
              userEmail || null,

            updates:
              normalizedUpdates,

            html:
              updatesHtml,

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
          `[${taskNo}] Предложения отправлены в updatesCallback`
        );
      }
    }

    console.log(
      `[${taskNo}] Диалог завершён`
    );
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
    } catch (callbackError) {
      console.error(
        "Failed to send error callback:",
        callbackError
      );
    }
  }
}

// ============================================================
// КОРРЕКТИРОВКА ПРЕДЛОЖЕННЫХ ИЗМЕНЕНИЙ
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
    `[${taskNo}] Старт revise_master_updates`
  );

  try {
    const system = `
Ты редактор мастер-инструкции технического анализа.

Тебе переданы:
1. текущий набор предлагаемых изменений мастер-инструкции;
2. замечание технолога к этим предложениям.

Нужно подготовить НОВУЮ редакцию всего набора изменений.

Правила:
- замечание технолога является приоритетным;
- не пытайся защищать предыдущую формулировку;
- если технолог просит удалить изменение — убери его;
- если технолог уточняет смысл — скорректируй соответствующее изменение;
- если замечание порождает дополнительное правило — добавь его;
- верни весь актуальный набор целиком, а не только изменённые элементы;
- не изменяй технический смысл замечания технолога;
- каждое предложение должно быть готовой формулировкой для мастер-инструкции.

Верни результат ТОЛЬКО через tool propose_master_instruction_updates.
Не пиши JSON в текстовом ответе.
`;

    const userText = `
ТЕКУЩИЕ ПРЕДЛАГАЕМЫЕ ИЗМЕНЕНИЯ:

${JSON.stringify(
  currentUpdates,
  null,
  2
)}

ЗАМЕЧАНИЕ ТЕХНОЛОГА:

${technologistComment}
`;

    const requestToClaude = {
      model:
        claudeRequest.model,

      max_tokens:
        claudeRequest.max_tokens,

      system,

      tools: [
        MASTER_UPDATE_PROPOSAL_TOOL
      ],

      tool_choice: {
        type: "tool",
        name:
          MASTER_UPDATE_PROPOSAL_TOOL.name
      },

      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userText
            }
          ]
        }
      ]
    };

    const claudeResponse =
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
              "2023-06-01"
          },

          body:
            JSON.stringify(
              requestToClaude
            )
        }
      );

    let response;

    try {
      response =
        await claudeResponse.json();
    } catch {
      const raw =
        await claudeResponse.text();

      throw new Error(
        `Claude returned invalid JSON: ${raw}`
      );
    }

    if (!claudeResponse.ok) {
      throw new Error(
        response?.error?.message ||
          `Claude API HTTP ${claudeResponse.status}`
      );
    }

    const updates =
      normalizeMasterUpdates(
        extractMasterInstructionUpdates(
          response
        )
      );

    if (
      updates.length === 0
    ) {
      throw new Error(
        "Claude не вернул обновлённый массив master updates"
      );
    }

    const usage =
      extractUsage(response);

    const estimatedCostUsd =
      estimateCostUsd(
        requestToClaude.model,
        usage
      );

    const html =
      formatMasterUpdatesHtml(
        updates
      );

    await sendCallback(
      updatesCallback,
      {
        taskNo,

        success: true,

        userEmail:
          userEmail || null,

        updates,

        html,

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
      `[${taskNo}] revise_master_updates завершён`
    );
  } catch (error) {
    console.error(
      `[${taskNo}] revise_master_updates error:`,
      error
    );

    try {
      await sendCallback(
        updatesCallback,
        {
          taskNo,

          success: false,

          userEmail:
            userEmail || null,

          error:
            error.message
        }
      );
    } catch (callbackError) {
      console.error(
        `[${taskNo}] Ошибка отправки updates error callback:`,
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
  taskNo,
  userEmail,
  masterInstructionUrl,
  updates,
  planfixFileUploadToken,
  planfixDomen,
  claudeRequest
}) {
  console.log(
    `[${taskNo}] Старт apply_master_updates`
  );

  try {
    // --------------------------------------------------------
    // 1. Скачиваем актуальную мастер-инструкцию
    // --------------------------------------------------------

    const masterResponse =
      await fetch(
        masterInstructionUrl,
        {
          method: "GET",
          redirect: "follow"
        }
      );

    if (!masterResponse.ok) {
      throw new Error(
        `Не удалось скачать мастер-инструкцию: HTTP ${masterResponse.status}`
      );
    }

    const masterText =
      await masterResponse.text();

    if (
      !masterText ||
      !masterText.trim()
    ) {
      throw new Error(
        "Скачанная мастер-инструкция пуста"
      );
    }

    // --------------------------------------------------------
    // 2. Просим Claude применить утверждённые изменения
    // --------------------------------------------------------

    const system = `
Ты технический редактор Markdown-файла мастер-инструкции.

Тебе переданы:
- полная актуальная мастер-инструкция;
- окончательно УТВЕРЖДЁННЫЙ технологом набор изменений.

Твоя задача — физически внести эти изменения в документ.

КРИТИЧЕСКИЕ ПРАВИЛА:
1. updates уже согласованы технологом. Не пересматривай их смысл.
2. Не меняй числовые значения, ограничения и технические условия без прямого указания в updates.
3. Если currentText заполнен — найди соответствующее существующее правило и измени его.
4. Если currentText пуст — добавь новое правило в наиболее подходящее место указанного раздела.
5. Не создавай дубликаты существующих правил.
6. Не изменяй другие разделы без необходимости.
7. Обнови блок истории изменений / changelog.
8. Подними номер версии мастер-инструкции на одну минорную версию.
9. Сохрани Markdown-структуру документа.
10. После применения проверь, что ВСЕ элементы updates действительно отражены в итоговом документе.

В текстовом ответе сначала дай короткое человеческое резюме того, что ФАКТИЧЕСКИ изменено:
- какие правила добавлены;
- какие правила изменены;
- какие правила удалены, если это предусмотрено updates;
- что обновлены версия и журнал изменений.

После резюме обязательно выведи полный итоговый Markdown между маркерами:

<<<MASTER_MD_START>>>
полный файл
<<<MASTER_MD_END>>>

Не добавляй никаких других данных внутрь этих маркеров.
`;

    const userText = `
УТВЕРЖДЁННЫЕ ИЗМЕНЕНИЯ:

${JSON.stringify(
  updates,
  null,
  2
)}

АКТУАЛЬНАЯ МАСТЕР-ИНСТРУКЦИЯ:

<<<CURRENT_MASTER_START>>>
${masterText}
<<<CURRENT_MASTER_END>>>
`;

    const requestToClaude = {
      model:
        claudeRequest.model,

      max_tokens:
        claudeRequest.max_tokens,

      system,

      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userText
            }
          ]
        }
      ]
    };

    const claudeResponse =
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
              "2023-06-01"
          },

          body:
            JSON.stringify(
              requestToClaude
            )
        }
      );

    let response;

    try {
      response =
        await claudeResponse.json();
    } catch {
      const raw =
        await claudeResponse.text();

      throw new Error(
        `Claude returned invalid JSON: ${raw}`
      );
    }

    if (!claudeResponse.ok) {
      throw new Error(
        response?.error?.message ||
          `Claude API HTTP ${claudeResponse.status}`
      );
    }

    const fullText =
      extractClaudeText(response);

    const parsed =
      parseMasterUpdateResult(
        fullText
      );

    if (
      !parsed.masterMarkdown
    ) {
      throw new Error(
        "Claude не вернул итоговый Markdown между MASTER_MD_START / MASTER_MD_END"
      );
    }

    // --------------------------------------------------------
    // 3. Определяем имя файла
    // --------------------------------------------------------

    const version =
      extractMasterVersion(
        parsed.masterMarkdown
      );

    const filename =
      version
        ? `Мастер-инструкция_v${version.replace(
            /\./g,
            "_"
          )}.md`
        : `Мастер-инструкция_${Date.now()}.md`;

    // --------------------------------------------------------
    // 4. Готовим файл для существующей Planfix upload-функции
    // --------------------------------------------------------

    const encoded =
      new TextEncoder().encode(
        parsed.masterMarkdown
      );

    const generatedFile = {
      arrayBuffer:
        encoded.buffer,

      filename,

      mimeType:
        "text/markdown"
    };

    // --------------------------------------------------------
    // 5. Загружаем файл в Planfix
    // --------------------------------------------------------

    const planfixFileId =
      await uploadFileToPlanfixRest(
        planfixDomen,
        planfixFileUploadToken,
        generatedFile
      );

    // --------------------------------------------------------
    // 6. Usage
    // --------------------------------------------------------

    const usage =
      extractUsage(response);

    const estimatedCostUsd =
      estimateCostUsd(
        requestToClaude.model,
        usage
      );

    // --------------------------------------------------------
    // 7. Человекочитаемый HTML
    // --------------------------------------------------------

    const html =
      markdownToHtml(
        parsed.summary ||
          "Мастер-инструкция обновлена."
      );

    // --------------------------------------------------------
    // 8. Финальный callback
    // --------------------------------------------------------

    await sendCallback(
      masterFileCallback,
      {
        taskNo,

        success: true,

        userEmail:
          userEmail || null,

        // ФОРМАТ СОВМЕСТИМ С ОСНОВНЫМ CALLBACK:
        files: [
          planfixFileId
        ],

        html,

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
      `[${taskNo}] Новая master-инструкция загружена в Planfix, fileId=${planfixFileId}`
    );
  } catch (error) {
    console.error(
      `[${taskNo}] apply_master_updates error:`,
      error
    );

    try {
      await sendCallback(
        masterFileCallback,
        {
          taskNo,

          success: false,

          userEmail:
            userEmail || null,

          files: [],

          html:
            markdownToHtml(
              `Не удалось обновить мастер-инструкцию: ${error.message}`
            ),

          error:
            error.message
        }
      );
    } catch (callbackError) {
      console.error(
        `[${taskNo}] Ошибка отправки masterFile error callback:`,
        callbackError
      );
    }
  }
}

// ============================================================
// ПАРСИНГ РЕЗУЛЬТАТА ОБНОВЛЕНИЯ MASTER.MD
// ============================================================

function parseMasterUpdateResult(
  text
) {
  const start =
    "<<<MASTER_MD_START>>>";

  const end =
    "<<<MASTER_MD_END>>>";

  const startIndex =
    text.indexOf(start);

  const endIndex =
    text.indexOf(end);

  if (
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex <= startIndex
  ) {
    return {
      summary:
        text.trim(),

      masterMarkdown:
        ""
    };
  }

  const summary =
    text
      .slice(
        0,
        startIndex
      )
      .trim();

  const masterMarkdown =
    text
      .slice(
        startIndex +
          start.length,
        endIndex
      )
      .trim();

  return {
    summary,
    masterMarkdown
  };
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ВЕРСИИ MASTER.MD
// ============================================================

function extractMasterVersion(
  markdown
) {
  if (!markdown) {
    return null;
  }

  const patterns = [
    /(?:версия|version)\s*[:\-]?\s*v?(\d+\.\d+(?:\.\d+)?)/i,
    /\bv(\d+\.\d+(?:\.\d+)?)\b/i
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      markdown.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return null;
}

// ============================================================
// ДОБАВЛЕНИЕ SYSTEM-ПРОТОКОЛА
// ============================================================

function appendSystemInstruction(
  system,
  addition
) {
  if (
    typeof system === "string"
  ) {
    return `${system.trim()}\n\n${addition.trim()}`;
  }

  if (
    Array.isArray(system)
  ) {
    return [
      ...system,
      {
        type: "text",
        text:
          addition.trim()
      }
    ];
  }

  return addition.trim();
}

// ============================================================
// ИЗВЛЕЧЕНИЕ MASTER UPDATES ИЗ TOOL_USE
// ============================================================

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

  for (
    const block of
    response.content
  ) {
    if (
      block?.type === "tool_use" &&
      block?.name ===
        MASTER_UPDATE_PROPOSAL_TOOL.name
    ) {
      const updates =
        block?.input?.updates;

      if (
        Array.isArray(updates)
      ) {
        return updates;
      }
    }
  }

  return [];
}

// ============================================================
// НОРМАЛИЗАЦИЯ MASTER UPDATES
// ============================================================

function normalizeMasterUpdates(
  updates
) {
  if (
    !Array.isArray(updates)
  ) {
    return [];
  }

  return updates
    .filter(
      (item) =>
        item &&
        typeof item === "object"
    )
    .map((item) => ({
      section:
        String(
          item.section || ""
        ).trim(),

      currentText:
        String(
          item.currentText || ""
        ).trim(),

      proposedText:
        String(
          item.proposedText || ""
        ).trim(),

      reason:
        String(
          item.reason || ""
        ).trim()
    }))
    .filter(
      (item) =>
        item.section &&
        item.proposedText
    );
}

// ============================================================
// HTML ДЛЯ ПРЕДЛОЖЕННЫХ ИЗМЕНЕНИЙ
// ============================================================

function formatMasterUpdatesHtml(
  updates
) {
  if (
    !Array.isArray(updates) ||
    updates.length === 0
  ) {
    return "";
  }

  const items =
    updates
      .map(
        (
          update,
          index
        ) => {
          const section =
            escapeHtml(
              update.section
            );

          const current =
            escapeHtml(
              update.currentText
            );

          const proposed =
            escapeHtml(
              update.proposedText
            );

          const reason =
            escapeHtml(
              update.reason
            );

          let html =
            `<li>` +
            `<strong>${index + 1}. ${section}</strong>` +
            `<br>`;

          if (current) {
            html +=
              `<strong>Сейчас:</strong> ${current}<br>`;
          }

          html +=
            `<strong>Предлагается:</strong> ${proposed}`;

          if (reason) {
            html +=
              `<br><em>Причина: ${reason}</em>`;
          }

          html +=
            `</li>`;

          return html;
        }
      )
      .join("");

  return (
    `<p><strong>Предлагаемые изменения мастер-инструкции</strong></p>` +
    `<ol>${items}</ol>`
  );
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
        redirect: "follow"
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
    arrayBuffer.byteLength === 0
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

  // ----------------------------------------------------------
  // Текстовые файлы
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // PDF
  // ----------------------------------------------------------

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
    new Uint8Array(buffer);

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

  return btoa(binary);
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
    name.endsWith(".pdf")
  ) {
    return "application/pdf";
  }

  if (
    name.endsWith(".png")
  ) {
    return "image/png";
  }

  if (
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg")
  ) {
    return "image/jpeg";
  }

  if (
    name.endsWith(".gif")
  ) {
    return "image/gif";
  }

  if (
    name.endsWith(".webp")
  ) {
    return "image/webp";
  }

  if (
    name.endsWith(".md")
  ) {
    return "text/markdown";
  }

  if (
    name.endsWith(".txt")
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

  function search(node) {
    if (
      !node ||
      typeof node !== "object"
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
      Object.keys(node)
    ) {
      const value =
        node[key];

      if (
        Array.isArray(value)
      ) {
        for (
          const item of value
        ) {
          search(item);
        }
      } else if (
        value &&
        typeof value ===
          "object"
      ) {
        search(value);
      }
    }
  }

  for (
    const block of
    response.content
  ) {
    search(block);
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
    const part of parts
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
    `${normalizedDomen
      .replace(
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
  } catch {
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
// РАЗБОР ИСТОРИИ
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
    Array.isArray(history)
  ) {
    if (
      history.length > 0 &&
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
    const part of parts
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
        entry?.analitic?.name ===
        "Диалог с ИИ"
    );

  const getFieldValue =
    (
      fields,
      name
    ) => {
      const field =
        Array.isArray(fields)
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
            type === "Вопрос"
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
// СБОРКА MESSAGES
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
          messages.length - 1
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
        fileBlocks.length > 0
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

  if (
    !filesAttached
  ) {
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
// УБИРАЕМ BASE64 ИЗ CALLBACK
// ============================================================

function stripFileData(
  value
) {
  if (
    Array.isArray(value)
  ) {
    return value.map(
      stripFileData
    );
  }

  if (
    value &&
    typeof value ===
      "object"
  ) {
    const result =
      {};

    for (
      const [
        key,
        item
      ] of Object.entries(
        value
      )
    ) {
      if (
        key === "data" &&
        typeof item ===
          "string"
      ) {
        result[key] =
          "[omitted]";
      } else {
        result[key] =
          stripFileData(
            item
          );
      }
    }

    return result;
  }

  return value;
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ТЕКСТА
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
// USAGE
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
// ЦЕНЫ
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
    const line of lines
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
  if (!callback) {
    throw new Error(
      "Callback URL is missing"
    );
  }

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
                .toString(16)
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
