from pathlib import Path

p = Path("proxy/claude/src/index.js")
s = p.read_text()

s = s.replace('const APP_VERSION = "39-2026-08-13";', 'const APP_VERSION = "40-2026-08-13";', 1)

start = s.index("function getMasterSectionDiagnosticSnippet(")
end = s.index("\nfunction replaceApprovedRuleUniquely(", start)
new_diagnostic = '''function getMasterSectionDiagnosticSnippet(
  markdown,
  section
) {
  const source = String(markdown || "");
  const wanted = normalizeHeadingText(section);
  if (!source) return "[master is empty]";

  const headingPattern = /^(#{1,6})[ \\t]+(.+?)[ \\t]*$/gm;
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
'''
s = s[:start] + new_diagnostic + s[end:]

start = s.index("function buildMasterInstructionFilename(")
end = s.index("\n// ============================================================\n// СКАЧИВАНИЕ ФАЙЛА ИЗ PLANFIX", start)
new_filename = '''function buildMasterInstructionFilename(
  originalFilename,
  version
) {
  return `Мастер-инструкция_v${version.replace(
    /\\./g,
    "_"
  )}.md`;
}
'''
s = s[:start] + new_filename + s[end:]

p.write_text(s)
