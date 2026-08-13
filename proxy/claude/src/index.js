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
    // Health-check.
    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        worker: "seppra-dashboard",
        app_version: APP_VERSION
      });
    }

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
  // То, что реально отправили Claude.
  let sentRequest = null;

  console.log(
    `[${taskNo}] Старт диалога, файлов на входе: ${
      Array.isArray(files) ? files.length : 0
    }`
  );

  try {
    // ========================================================
    // 1. ПОДГОТОВКА ФАЙЛОВ
    // ========================================================

    const fileBlocks = [];

    if (Array.isArray(files)) {
      for (const file of files) {
        try {
          const blocks =
            await downloadFileForClaude(file);

          if (Array.isArray(blocks)) {
            fileBlocks.push(...blocks);
          }
        } catch (fileError) {
          console.error(
            `[${taskNo}] Не удалось подготовить файл ${
              file?.name || file?.url || "unknown"
            }:`,
            fileError
          );

          // Один проблемный файл не должен полностью
          // останавливать весь запрос.
        }
      }
    }

    // ========================================================
    // 2. ИСТОРИЯ ДИАЛОГА
    // ========================================================

    const historyTurns =
      parseHistoryToTurns(history);

    const currentQuestion =
      extractCurrentQuestion(
        claudeRequest,
        rawRequest
      );

    const messages =
      buildMessagesFromHistory(
        historyTurns,
        currentQuestion,
        fileBlocks
      );

    // ========================================================
    // 3. СОБИРАЕМ ЗАПРОС CLAUDE
    // ========================================================

    sentRequest = {
      ...claudeRequest,
      messages
    };

    // Добавляем наш системный протокол поверх существующей
    // system-инструкции клиента.
    sentRequest.system =
      appendSystemInstruction(
        claudeRequest.system,
        MASTER_UPDATE_PROTOCOL
      );

    // ========================================================
    // 4. TOOL ДЛЯ ПРЕДЛОЖЕНИЙ MASTER-ИНСТРУКЦИИ
    // ========================================================

    // Существующие tools клиента сохраняем.
    const existingTools =
      Array.isArray(claudeRequest.tools)
        ? claudeRequest.tools
        : [];

    // Не дублируем tool, если он каким-то образом уже пришёл.
    const toolsWithoutDuplicate =
      existingTools.filter(
        (tool) =>
          tool?.name !==
          MASTER_UPDATE_PROPOSAL_TOOL.name
      );

    sentRequest.tools = [
      ...toolsWithoutDuplicate,
      MASTER_UPDATE_PROPOSAL_TOOL
    ];

    // ========================================================
    // 5. ОТПРАВКА В ANTHROPIC
    // ========================================================

    const claudeResponse =
      await sendClaudeMessagesRequest(
        apiKey,
        sentRequest
      );

    // ========================================================
    // 6. ТЕКСТОВЫЙ ОТВЕТ
    // ========================================================

    const responseText =
      extractClaudeText(claudeResponse);

    const html =
      markdownToHtml(responseText);

    // ========================================================
    // 7. USAGE / СТОИМОСТЬ
    // ========================================================

    const usage =
      extractUsage(claudeResponse);

    const estimatedCostUsd =
      estimateCostUsd(
        claudeRequest.model,
        usage
      );

    // ========================================================
    // 8. ФАЙЛЫ, СОЗДАННЫЕ CLAUDE
    // ========================================================

    const generatedFileIds =
      findGeneratedFileIds(
        claudeResponse
      );

    const uploadedFileIds = [];

    if (
      generatedFileIds.length > 0 &&
      planfixFileUploadToken &&
      planfixDomen
    ) {
      for (const fileId of generatedFileIds) {
        try {
          const generatedFile =
            await downloadGeneratedFile(
              fileId,
              apiKey
            );

          const uploaded =
            await uploadFileToPlanfixRest(
              generatedFile,
              planfixFileUploadToken,
              planfixDomen
            );

          uploadedFileIds.push(uploaded);
        } catch (fileError) {
          console.error(
            `[${taskNo}] Ошибка переноса файла ${fileId} из Claude в Planfix:`,
            fileError
          );
        }
      }
    }

    // ========================================================
    // 9. ОСНОВНОЙ CALLBACK
    // ========================================================

    // ВАЖНО:
    // files оставляем в том же формате, который уже использовался:
    // массив ID Planfix.
    const callbackPayload = {
      taskNo,
      success: true,
      status: 200,

      response: claudeResponse,
      html,

      userEmail:
        userEmail || null,

      raw_request:
        stripFileData(sentRequest),

      files:
        uploadedFileIds.map(
          (file) => file.id
        ),

      input_tokens:
        usage.input_tokens,

      output_tokens:
        usage.output_tokens,

      total_tokens:
        usage.total_tokens,

      estimated_cost_usd:
        estimatedCostUsd
    };

    await sendCallback(
      callback,
      callbackPayload
    );

    // ========================================================
    // 10. ПРОВЕРЯЕМ ПРЕДЛОЖЕНИЯ ПО MASTER-ИНСТРУКЦИИ
    // ========================================================

    const proposedUpdates =
      extractMasterInstructionUpdates(
        claudeResponse
      );

    if (
      proposedUpdates.length > 0
    ) {
      console.log(
        `[${taskNo}] Claude предложил изменений master-инструкции: ${proposedUpdates.length}`
      );

      if (updatesCallback) {
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
      } else {
        console.warn(
          `[${taskNo}] Есть master updates, но updatesCallback не передан`
        );
      }
    }

    console.log(
      `[${taskNo}] Диалог успешно завершён`
    );
  } catch (error) {
    console.error(
      `[${taskNo}] Ошибка обычного диалога:`,
      error
    );

    // Сохраняем совместимость со старым error-callback.
    try {
      await sendCallback(
        callback,
        {
          taskNo,
          success: false,
          status:
            error.status || 500,

          error:
            error.message,

          userEmail:
            userEmail || null,

          raw_request:
            sentRequest
              ? stripFileData(sentRequest)
              : null
        }
      );
    } catch (callbackError) {
      console.error(
        `[${taskNo}] Не удалось отправить error callback:`,
        callbackError
      );
    }
  }
}

// ============================================================
// ВСПОМОГАТЕЛЬНОЕ:
// ПОЛУЧИТЬ ТЕКУЩИЙ ВОПРОС
// ============================================================

function extractCurrentQuestion(
  claudeRequest,
  rawRequest
) {
  if (
    rawRequest !== undefined &&
    rawRequest !== null &&
    String(rawRequest).trim()
  ) {
    return String(rawRequest);
  }

  const messages =
    Array.isArray(
      claudeRequest?.messages
    )
      ? claudeRequest.messages
      : [];

  for (
    let i = messages.length - 1;
    i >= 0;
    i--
  ) {
    const message = messages[i];

    if (
      message?.role !== "user"
    ) {
      continue;
    }

    if (
      typeof message.content ===
      "string"
    ) {
      return message.content;
    }

    if (
      Array.isArray(
        message.content
      )
    ) {
      const text = message.content
        .filter(
          (block) =>
            block?.type === "text"
        )
        .map(
          (block) =>
            block.text || ""
        )
        .join("\n")
        .trim();

      if (text) {
        return text;
      }
    }
  }

  return "";
}
