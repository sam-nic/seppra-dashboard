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
     * переводим их в Base64
     * и формируем content-блоки Claude.
     */

    const fileBlocks = [];

    for (const file of files) {
      const block = await downloadAndConvertFile(file);

      /*
       * Перед самим файлом сообщаем Claude его имя.
       */
      fileBlocks.push({
        type: "text",
        text: `Прикреплённый файл: ${file.name || "Без названия"}`
      });

      fileBlocks.push(block);
    }


    /*
     * Добавляем полученные файлы
     * в первое user-сообщение.
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
     * Отправляем запрос в Claude.
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
     * Получаем весь текстовый ответ Claude.
     */

    const claudeText = extractClaudeText(response);


    /*
     * Преобразуем Markdown Claude → HTML для Planfix.
     */

    const html = claudeText
      ? markdownToHtml(claudeText)
      : "";


    /*
     * Отправляем результат обратно в Planfix.
     *
     * html     — готовый текст для комментария Planfix
     * text     — исходный Markdown/текст Claude
     * response — полный оригинальный JSON Claude
     */

    await sendCallback(callback, {
      taskNo,
      success: claudeResponse.ok,
      status: claudeResponse.status,
      html,
      text: claudeText,
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


/*
 * Извлекаем текст из ответа Claude.
 *
 * Claude может вернуть несколько content-блоков,
 * поэтому собираем все блоки type=text.
 */

function extractClaudeText(response) {
  if (!response) {
    return "";
  }

  if (!Array.isArray(response.content)) {
    return "";
  }

  return response.content
    .filter(
      item =>
        item &&
        item.type === "text" &&
        typeof item.text === "string"
    )
    .map(item => item.text)
    .join("\n\n");
}


/*
 * Преобразование Markdown → HTML.
 *
 * Поддерживается:
 *
 * # Заголовки
 * **жирный**
 * __жирный__
 * *курсив*
 * _курсив_
 * ***жирный курсив***
 * ~~зачёркнутый~~
 * ++подчёркнутый++
 * <u>подчёркнутый</u>
 * `код`
 * [ссылка](https://...)
 * - списки
 * * списки
 * 1. списки
 * > цитаты
 * ---
 * ``` блоки кода ```
 */

function markdownToHtml(markdown) {
  if (!markdown) {
    return "";
  }

  const lines = String(markdown)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const html = [];

  let paragraph = [];
  let listType = null;

  let inCodeBlock = false;
  let codeLines = [];


  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }

    const text = paragraph
      .map(line => parseInlineMarkdown(line))
      .join("<br>");

    html.push(`<p>${text}</p>`);

    paragraph = [];
  }


  function closeList() {
    if (!listType) {
      return;
    }

    html.push(`</${listType}>`);
    listType = null;
  }


  function flushCodeBlock() {
    const code = escapeHtml(
      codeLines.join("\n")
    );

    html.push(
      `<pre><code>${code}</code></pre>`
    );

    codeLines = [];
  }


  for (const rawLine of lines) {
    const line = rawLine.trimEnd();


    /*
     * Блок кода ```
     */

    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        flushParagraph();
        closeList();

        inCodeBlock = true;
        codeLines = [];
      } else {
        inCodeBlock = false;
        flushCodeBlock();
      }

      continue;
    }


    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }


    /*
     * Пустая строка.
     */

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }


    /*
     * Горизонтальная линия.
     */

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      closeList();

      html.push("<hr>");

      continue;
    }


    /*
     * Заголовки.
     */

    const headingMatch = line.match(
      /^(#{1,6})\s+(.+)$/
    );

    if (headingMatch) {
      flushParagraph();
      closeList();

      const level = headingMatch[1].length;

      html.push(
        `<h${level}>${parseInlineMarkdown(
          headingMatch[2]
        )}</h${level}>`
      );

      continue;
    }


    /*
     * Цитаты.
     */

    const quoteMatch = line.match(
      /^\s*>\s?(.*)$/
    );

    if (quoteMatch) {
      flushParagraph();
      closeList();

      html.push(
        `<blockquote>${parseInlineMarkdown(
          quoteMatch[1]
        )}</blockquote>`
      );

      continue;
    }


    /*
     * Маркированный список.
     */

    const unorderedMatch = line.match(
      /^\s*[-*+]\s+(.+)$/
    );

    if (unorderedMatch) {
      flushParagraph();

      if (listType !== "ul") {
        closeList();

        html.push("<ul>");
        listType = "ul";
      }

      html.push(
        `<li>${parseInlineMarkdown(
          unorderedMatch[1]
        )}</li>`
      );

      continue;
    }


    /*
     * Нумерованный список.
     */

    const orderedMatch = line.match(
      /^\s*\d+[.)]\s+(.+)$/
    );

    if (orderedMatch) {
      flushParagraph();

      if (listType !== "ol") {
        closeList();

        html.push("<ol>");
        listType = "ol";
      }

      html.push(
        `<li>${parseInlineMarkdown(
          orderedMatch[1]
        )}</li>`
      );

      continue;
    }


    /*
     * Обычный текст.
     */

    closeList();
    paragraph.push(line);
  }


  if (inCodeBlock) {
    flushCodeBlock();
  }

  flushParagraph();
  closeList();


  return html.join("\n");
}


/*
 * Inline Markdown.
 */

function parseInlineMarkdown(text) {
  let value = escapeHtml(text);


  /*
   * Разрешаем безопасный <u>...</u>.
   * После escapeHtml он выглядит как
   * &lt;u&gt;...&lt;/u&gt;
   */

  value = value.replace(
    /&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/gi,
    "<u>$1</u>"
  );


  /*
   * Inline code.
   */

  value = value.replace(
    /`([^`\n]+)`/g,
    "<code>$1</code>"
  );


  /*
   * Ссылки.
   */

  value = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );


  /*
   * Жирный + курсив.
   */

  value = value.replace(
    /\*\*\*(.+?)\*\*\*/g,
    "<strong><em>$1</em></strong>"
  );

  value = value.replace(
    /___(.+?)___/g,
    "<strong><em>$1</em></strong>"
  );


  /*
   * Жирный.
   */

  value = value.replace(
    /\*\*(.+?)\*\*/g,
    "<strong>$1</strong>"
  );

  value = value.replace(
    /__(.+?)__/g,
    "<strong>$1</strong>"
  );


  /*
   * Зачёркивание.
   */

  value = value.replace(
    /~~(.+?)~~/g,
    "<s>$1</s>"
  );


  /*
   * Подчёркивание.
   *
   * ++текст++
   *
   * Это не стандартный Markdown,
   * но поддерживаем на случай,
   * если захотим использовать в prompt.
   */

  value = value.replace(
    /\+\+(.+?)\+\+/g,
    "<u>$1</u>"
  );


  /*
   * Курсив.
   *
   * Стараемся не затрагивать символы
   * внутри слов.
   */

  value = value.replace(
    /(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g,
    "$1<em>$2</em>"
  );

  value = value.replace(
    /(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g,
    "$1<em>$2</em>"
  );


  return value;
}


/*
 * Защищаем HTML, который мог прийти
 * из текста Claude.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/*
 * Загрузка файла Planfix.
 */

async function downloadAndConvertFile(file) {
  if (!file || !file.url) {
    throw new Error(
      "File URL is missing"
    );
  }

  /*
   * URL не выводим в лог,
   * так как он содержит auth.
   */

  const response = await fetch(
    file.url,
    {
      method: "GET",
      redirect: "follow"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Could not download file "${file.name || "unknown"}": HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  if (!arrayBuffer.byteLength) {
    throw new Error(
      `Downloaded file "${file.name || "unknown"}" is empty`
    );
  }

  const base64 =
    arrayBufferToBase64(arrayBuffer);


  /*
   * Тип файла сначала определяем
   * по Content-Type Planfix.
   */

  let mediaType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    ?.toLowerCase();


  /*
   * Если сервер вернул
   * application/octet-stream,
   * смотрим расширение файла.
   */

  if (
    !mediaType ||
    mediaType === "application/octet-stream"
  ) {
    mediaType =
      getMediaTypeFromFilename(file.name);
  }


  /*
   * PDF.
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
   * Изображения.
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


function getMediaTypeFromFilename(
  filename = ""
) {
  const name =
    filename.toLowerCase();

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
  const bytes =
    new Uint8Array(buffer);

  const chunkSize = 0x8000;

  let binary = "";

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        i,
        i + chunkSize
      )
    );
  }

  return btoa(binary);
}


/*
 * Callback в Planfix.
 */

async function sendCallback(
  callback,
  data
) {
  const response = await fetch(
    callback,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json"
      },

      body: JSON.stringify(data)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Planfix callback returned HTTP ${response.status}`
    );
  }
}


function jsonResponse(
  data,
  status = 200
) {
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
