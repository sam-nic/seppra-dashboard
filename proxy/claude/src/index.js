export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return jsonResponse(
        {
          success: false,
          error: "Only POST requests are allowed"
        },
        405
      );
    }

    try {
      const input = await request.json();

      const {
        apiKey,
        callback,
        taskNo,
        files = [],
        ...claudeRequest
      } = input;

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

      ctx.waitUntil(
        processClaudeRequest({
          apiKey,
          callback,
          taskNo,
          files,
          claudeRequest
        })
      );

      return jsonResponse({
        success: true,
        accepted: true,
        taskNo
      });

    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error.message
        },
        400
      );
    }
  }
};


async function processClaudeRequest({
  apiKey,
  callback,
  taskNo,
  files,
  claudeRequest
}) {
  try {
    /*
     * Скачиваем файлы Planfix,
     * конвертируем их в Base64
     * и формируем блоки для Claude.
     *
     * Перед каждым файлом добавляем
     * текстовую подпись с его именем.
     */

    const fileBlocks = [];

    for (const file of files) {
      const block = await downloadAndConvertFile(file);

      fileBlocks.push({
        type: "text",
        text: `Прикреплённый файл: ${file.name || "Без названия"}`
      });

      fileBlocks.push(block);
    }


    /*
     * Добавляем файлы в первое сообщение пользователя.
     *
     * Например:
     *
     * [
     *   { type: "text", text: "Прикреплённый файл: drawing.pdf" },
     *   { type: "document", ... },
     *   { type: "text", text: "Прикреплённый файл: photo.png" },
     *   { type: "image", ... },
     *   { type: "text", text: "Проанализируй файлы" }
     * ]
     */

    if (
      fileBlocks.length > 0 &&
      Array.isArray(claudeRequest.messages)
    ) {
      const userMessage = claudeRequest.messages.find(
        message => message.role === "user"
      );

      if (!userMessage) {
        throw new Error(
          "No user message found in Claude request"
        );
      }

      if (typeof userMessage.content === "string") {
        userMessage.content = [
          {
            type: "text",
            text: userMessage.content
          }
        ];
      }

      if (!Array.isArray(userMessage.content)) {
        userMessage.content = [];
      }

      userMessage.content = [
        ...fileBlocks,
        ...userMessage.content
      ];
    }


    /*
     * Отправляем запрос в Claude API.
     */

    const claudeResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(claudeRequest)
      }
    );

    const responseText = await claudeResponse.text();

    let response;

    try {
      response = JSON.parse(responseText);
    } catch {
      response = {
        raw: responseText
      };
    }


    /*
     * Отправляем результат обратно в Planfix.
     */

    await sendCallback(callback, {
      taskNo,
      success: claudeResponse.ok,
      status: claudeResponse.status,
      response
    });

  } catch (error) {
    /*
     * Если произошла ошибка при скачивании файла,
     * конвертации или запросе Claude,
     * всё равно сообщаем Planfix.
     */

    try {
      await sendCallback(callback, {
        taskNo,
        success: false,
        error: error.message
      });
    } catch {
      // Если callback тоже недоступен,
      // на тестовом этапе ничего больше не делаем.
    }
  }
}


async function downloadAndConvertFile(file) {
  if (!file || !file.url) {
    throw new Error("File URL is missing");
  }

  /*
   * URL намеренно не выводим в лог,
   * потому что ссылка Planfix содержит auth-параметр.
   */

  const response = await fetch(file.url, {
    method: "GET",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Could not download file "${file.name || "unknown"}": HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  if (!arrayBuffer.byteLength) {
    throw new Error(
      `Downloaded file "${file.name || "unknown"}" is empty`
    );
  }

  const base64 = arrayBufferToBase64(arrayBuffer);


  /*
   * Сначала берём Content-Type,
   * который вернул сервер Planfix.
   */

  let mediaType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    ?.toLowerCase();


  /*
   * Если Planfix вернул универсальный
   * application/octet-stream,
   * определяем тип по расширению файла.
   */

  if (
    !mediaType ||
    mediaType === "application/octet-stream"
  ) {
    mediaType = getMediaTypeFromFilename(file.name);
  }


  /*
   * PDF отправляем Claude как document.
   */

  if (mediaType === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: base64
      }
    };
  }


  /*
   * Изображения отправляем Claude как image.
   */

  if (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp"
  ) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: base64
      }
    };
  }


  throw new Error(
    `Unsupported file type "${mediaType}" for file "${file.name || "unknown"}"`
  );
}


function getMediaTypeFromFilename(filename = "") {
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

  return "application/octet-stream";
}


function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);

  const chunkSize = 0x8000;

  let binary = "";

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}


async function sendCallback(callback, data) {
  const response = await fetch(callback, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    throw new Error(
      `Planfix callback returned HTTP ${response.status}`
    );
  }
}


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
