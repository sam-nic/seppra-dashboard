export default {
  async fetch(request, env, ctx) {
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
      const input = await request.json();

      const {
        apiKey,
        callback,
        taskNo,
        userEmail,
        files = [],
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
  claudeRequest
}) {
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
          "anthropic-version": "2023-06-01"
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
        error:
          response?.error?.message ||
          "Claude API request failed",
        response
      });

      return;
    }

    // --------------------------------------------------------
    // 7. Извлекаем текстовые блоки Claude
    // --------------------------------------------------------

    const claudeText = extractClaudeText(response);

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

      html,
      text: claudeText,

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

  const contentType =
    normalizeContentType(
      response.headers.get("content-type")
    ) ||
    getMimeTypeFromFilename(file.name) ||
    "application/octet-stream";

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

  return null;
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
