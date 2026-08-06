export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Only POST requests are allowed"
        }),
        {
          status: 405,
          headers: { "content-type": "application/json" }
        }
      );
    }

    try {
      const input = await request.json();

      const {
        apiKey,
        callback,
        taskNo,
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

      // Продолжаем выполнение после возврата ответа Planfix
      ctx.waitUntil(
        processClaudeRequest({
          apiKey,
          callback,
          taskNo,
          claudeRequest
        })
      );

      // Planfix получает ответ сразу
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
  claudeRequest
}) {
  try {
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

    await fetch(callback, {
      method: "POST",

      headers: {
        "content-type": "application/json"
      },

      body: JSON.stringify({
        taskNo,
        success: claudeResponse.ok,
        status: claudeResponse.status,
        response
      })
    });

  } catch (error) {
    // Если ошибка произошла ещё до получения ответа Claude,
    // всё равно пытаемся сообщить Planfix.
    try {
      await fetch(callback, {
        method: "POST",

        headers: {
          "content-type": "application/json"
        },

        body: JSON.stringify({
          taskNo,
          success: false,
          error: error.message
        })
      });
    } catch {
      // На первой тестовой версии ничего больше не делаем
    }
  }
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    }
  );
}
