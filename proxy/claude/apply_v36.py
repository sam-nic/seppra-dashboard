from pathlib import Path

path = Path('proxy/claude/src/index.js')
s = path.read_text()


def replace_once(old, new):
    global s
    if old not in s:
        raise SystemExit('Expected block not found:\n' + old[:800])
    s = s.replace(old, new, 1)

replace_once(
    'const APP_VERSION = "35-2026-08-13";',
    'const APP_VERSION = "36-2026-08-13";'
)

replace_once(
'''    const currentMarkdown =
      await downloadTextFile(
        activeMasterInstructionUrl
      );

    const currentVersion =''',
'''    console.log(
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

    const currentVersion ='''
)

replace_once(
'''    const newVersion =
      incrementVersion(
        currentVersion
      );''',
'''    const newVersion =
      incrementVersion(
        currentVersion
      );

    console.log(
      `[${taskNo}][MASTER APPLY] VERSION`,
      JSON.stringify({
        current: currentVersion,
        next: newVersion
      })
    );'''
)

replace_once(
'''      applyApprovedMasterUpdatesDeterministically(
        currentMarkdown,
        normalizedUpdates
      );

    updatedMarkdown =
      updateMasterInstructionMetadata(''',
'''      applyApprovedMasterUpdatesDeterministically(
        currentMarkdown,
        normalizedUpdates,
        taskNo
      );

    console.log(
      `[${taskNo}][MASTER APPLY] RULES APPLIED`,
      JSON.stringify({ count: normalizedUpdates.length })
    );

    updatedMarkdown =
      updateMasterInstructionMetadata('''
)

replace_once(
'''    updatedMarkdown =
      addMasterInstructionChangelogEntry(
        updatedMarkdown,
        newVersion,
        updateDate,
        normalizedUpdates
      );''',
'''    console.log(
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
    );'''
)

replace_once(
'''    const planfixFileId =
      await uploadFileToPlanfixRest(
        planfixDomen,
        planfixFileUploadToken,
        generatedFile
      );''',
'''    const planfixFileId =
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
    );'''
)

replace_once(
'''    await sendCallback(
      masterFileCallback,
      {
        taskNo,''',
'''    console.log(
      `[${taskNo}][MASTER APPLY] CALLBACK START`
    );

    await sendCallback(
      masterFileCallback,
      {
        taskNo,'''
)

replace_once(
'''  } catch (error) {
    console.error(
      `[${taskNo}] processApplyMasterUpdates error:`,
      error
    );''',
'''  } catch (error) {
    console.error(
      `[${taskNo}][MASTER APPLY] ERROR MESSAGE: ${error?.message || String(error)}`
    );

    console.error(
      `[${taskNo}][MASTER APPLY] ERROR STACK: ${error?.stack || "[no stack]"}`
    );'''
)

old_replace = '''function replaceApprovedRuleUniquely(
  markdown,
  currentText,
  proposedText,
  section
) {
  const exactCount =
    markdown.split(
      currentText
    ).length - 1;

  if (exactCount === 1) {
    return markdown.replace(
      currentText,
      proposedText
    );
  }

  if (exactCount > 1) {
    throw new Error(
      `Раздел "${section}": currentText найден более одного раза; автоматическая замена остановлена`
    );
  }

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

  if (matches.length !== 1) {
    throw new Error(
      `Раздел "${section}": currentText не найден однозначно (совпадений: ${matches.length})`
    );
  }

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
}'''

new_replace = '''function getMasterSectionDiagnosticSnippet(
  markdown,
  section,
  radius = 1200
) {
  const source =
    String(markdown || "");

  const needle =
    String(section || "").trim();

  if (!source) {
    return "[master is empty]";
  }

  let index = -1;

  if (needle) {
    index = source
      .toLowerCase()
      .indexOf(
        needle.toLowerCase()
      );
  }

  if (index < 0 && needle) {
    const shortNeedle =
      needle.slice(0, 24);

    index = source
      .toLowerCase()
      .indexOf(
        shortNeedle.toLowerCase()
      );
  }

  if (index < 0) {
    return source.slice(0, radius * 2);
  }

  const start =
    Math.max(0, index - radius);

  const end =
    Math.min(
      source.length,
      index + needle.length + radius
    );

  return source.slice(start, end);
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

  console.log(
    `[${taskNo}][MASTER APPLY] MATCH CHECK`,
    JSON.stringify(
      {
        section,
        current_text_chars: currentText.length,
        proposed_text_chars: proposedText.length,
        exact_matches: exactCount,
        flexible_matches: matches.length,
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
    console.error(
      `[${taskNo}][MASTER APPLY] MATCH FAILED`,
      JSON.stringify(
        {
          section,
          exact_matches: exactCount,
          flexible_matches: matches.length,
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
}'''

replace_once(old_replace, new_replace)

replace_once(
'''function applyApprovedMasterUpdatesDeterministically(
  markdown,
  updates
) {''',
'''function applyApprovedMasterUpdatesDeterministically(
  markdown,
  updates,
  taskNo = "?"
) {'''
)

replace_once(
'''          update.proposedText,
          update.section
        );''',
'''          update.proposedText,
          update.section,
          taskNo
        );'''
)

path.write_text(s)
print('v36 applied')
