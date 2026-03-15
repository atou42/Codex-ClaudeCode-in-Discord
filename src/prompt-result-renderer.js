function normalizeTextList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

export function createPromptResultRenderer({
  showReasoning = false,
  truncate = (text) => String(text || ''),
  composeFinalAnswerText = () => '',
  getProviderShortName = (provider) => provider,
  formatProviderSessionTerm = () => 'session',
  getSessionProvider = () => 'codex',
  getSessionId = () => null,
} = {}) {
  function composeResultText(result, session) {
    const reasonings = normalizeTextList(result?.reasonings);
    const messages = normalizeTextList(result?.messages);
    const finalAnswerMessages = normalizeTextList(result?.finalAnswerMessages);
    const notes = normalizeTextList(result?.notes);
    const sections = [];

    if (showReasoning && reasonings.length) {
      sections.push([
        '🧠 Reasoning',
        truncate(reasonings.join('\n\n'), 1200),
      ].join('\n'));
    }

    const answer = composeFinalAnswerText({
      messages,
      finalAnswerMessages,
    });
    sections.push(answer || `（${getProviderShortName(getSessionProvider(session))} 没有返回可见文本）`);

    const tail = [];
    if (notes.length) {
      tail.push(...notes.map((note) => `• ${note}`));
    }
    const currentSessionId = getSessionId(session);
    if (currentSessionId || result?.threadId) {
      const id = result.threadId || currentSessionId;
      const label = session.name ? `**${session.name}** (\`${id}\`)` : `\`${id}\``;
      tail.push(`• ${formatProviderSessionTerm(getSessionProvider(session), 'zh')}: ${label}`);
    }

    if (tail.length) {
      sections.push(['', '—', ...tail].join('\n'));
    }

    return sections.join('\n\n').trim();
  }

  return {
    composeResultText,
  };
}
