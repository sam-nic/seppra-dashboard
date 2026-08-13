from pathlib import Path

path = Path('proxy/claude/src/index.js')
s = path.read_text()


def replace_once(old, new):
    global s
    if old not in s:
        raise SystemExit('Expected block not found:\n' + old[:1000])
    s = s.replace(old, new, 1)

replace_once(
    'const APP_VERSION = "36-2026-08-13";',
    'const APP_VERSION = "37-2026-08-13";'
)

old = '''function normalizeMasterUpdates(\n  updates\n) {\n  if (\n    !Array.isArray(\n      updates\n    )\n  ) {\n    return [];\n  }\n\n  return updates\n    .filter(\n      (item) =>\n        item &&\n        typeof item ===\n          "object"\n    )\n    .map(\n      (item) => ({\n        section:\n          String(\n            item.section ??\n              ""\n          ).trim(),\n\n        currentText:\n          String(\n            item.currentText ??\n              ""\n          ).trim(),\n\n        proposedText:\n          String(\n            item.proposedText ??\n              ""\n          ).trim(),\n\n        reason:\n          String(\n            item.reason ??\n              ""\n          ).trim()\n      })\n    )\n    .filter(\n      (item) =>\n        item.section &&\n        item.proposedText\n    );\n}\n'''

new = '''function decodeHtmlEntities(\n  value\n) {\n  let result =\n    String(value ?? "");\n\n  const named = {\n    gt: ">",\n    lt: "<",\n    amp: "&",\n    quot: '"',\n    apos: "'",\n    nbsp: " "\n  };\n\n  // Planfix/HTML может прислать текст как &gt; или даже как\n  // &amp;gt;. Делаем несколько безопасных проходов, чтобы внутри\n  // Worker всегда сравнивался обычный plain text.\n  for (let pass = 0; pass < 3; pass += 1) {\n    const decoded =\n      result.replace(\n        /&(#\\d+|#x[0-9a-f]+|gt|lt|amp|quot|apos|nbsp);/gi,\n        (match, entity) => {\n          const lower =\n            String(entity).toLowerCase();\n\n          if (lower.startsWith("#x")) {\n            const code =\n              parseInt(lower.slice(2), 16);\n\n            return Number.isFinite(code)\n              ? String.fromCodePoint(code)\n              : match;\n          }\n\n          if (lower.startsWith("#")) {\n            const code =\n              parseInt(lower.slice(1), 10);\n\n            return Number.isFinite(code)\n              ? String.fromCodePoint(code)\n              : match;\n          }\n\n          return Object.prototype.hasOwnProperty.call(\n            named,\n            lower\n          )\n            ? named[lower]\n            : match;\n        }\n      );\n\n    if (decoded === result) {\n      break;\n    }\n\n    result = decoded;\n  }\n\n  return result;\n}\n\nfunction normalizeMasterUpdates(\n  updates\n) {\n  if (\n    !Array.isArray(\n      updates\n    )\n  ) {\n    return [];\n  }\n\n  return updates\n    .filter(\n      (item) =>\n        item &&\n        typeof item ===\n          "object"\n    )\n    .map(\n      (item) => ({\n        section:\n          decodeHtmlEntities(\n            item.section ??\n              ""\n          ).trim(),\n\n        currentText:\n          decodeHtmlEntities(\n            item.currentText ??\n              ""\n          ).trim(),\n\n        proposedText:\n          decodeHtmlEntities(\n            item.proposedText ??\n              ""\n          ).trim(),\n\n        reason:\n          decodeHtmlEntities(\n            item.reason ??\n              ""\n          ).trim()\n      })\n    )\n    .filter(\n      (item) =>\n        item.section &&\n        item.proposedText\n    );\n}\n'''

replace_once(old, new)

path.write_text(s)
print('v37 applied')
