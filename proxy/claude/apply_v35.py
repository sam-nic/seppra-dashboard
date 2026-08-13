from pathlib import Path

path = Path('proxy/claude/src/index.js')
s = path.read_text()


def replace_once(old, new):
    global s
    if old not in s:
        raise SystemExit('Expected block not found:\n' + old[:500])
    s = s.replace(old, new, 1)

replace_once(
    'const APP_VERSION = "34-2026-08-13";',
    'const APP_VERSION = "35-2026-08-13";'
)

old = r'''async function sendClaudeMessagesRequest(
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

  let response;

  try {
    response =
      JSON.parse(
        responseText
      );
  } catch (error) {
    throw new Error(
      `Claude returned invalid JSON. Status ${httpResponse.status}: ${responseText}`
    );
  }

  return {
    httpResponse,
    response
  };
}'''

new = r'''async function sendClaudeMessagesRequest(
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
            requestToClaude
          )
      }
    );

  const responseText =
    await httpResponse.text();

  const durationMs =
    Date.now() -
    startedAt;

  if (!httpResponse.ok) {
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

  let response;

  try {
    response =
      JSON.parse(
        responseText
      );
  } catch (error) {
    console.error(
      `[CLAUDE][${requestId}] INVALID JSON`,
      JSON.stringify(
        {
          status:
            httpResponse.status,
          duration_ms:
            durationMs,
          raw_response:
            responseText
        },
        null,
        2
      )
    );

    throw new Error(
      `Claude returned invalid JSON. Status ${httpResponse.status}: ${responseText.slice(0, 5000)}`
    );
  }

  console.log(
    `[CLAUDE][${requestId}] RESPONSE`,
    JSON.stringify(
      {
        status:
          httpResponse.status,
        duration_ms:
          durationMs,
        response_chars:
          responseText.length,
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
}'''

replace_once(old, new)

path.write_text(s)
print('v35 applied')
