const VERSION_PATTERN = /\d+(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?/;

export function parseVersion(value) {
  return String(value || '').match(VERSION_PATTERN)?.[0] || null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left || '').localeCompare(String(right || ''));

  const [aCore, aPre = ''] = a.split('-', 2);
  const [bCore, bPre = ''] = b.split('-', 2);
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const delta = (aParts[index] || 0) - (bParts[index] || 0);
    if (delta) return Math.sign(delta);
  }
  if (aPre === bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;
  return aPre.localeCompare(bPre, 'en', { numeric: true });
}

export function isVerifiedUpgrade({ before, expected, actual }) {
  return compareVersions(actual, expected) >= 0 && compareVersions(actual, before) > 0;
}

export function buildReportNonce(date, timestamp = Date.now()) {
  const compactDate = String(date || '').replace(/\D/g, '').slice(0, 8);
  return `agu-${compactDate}-${Number(timestamp).toString(36)}`.slice(0, 25);
}

export function extractVersionRange(text, before, after) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  if (!source.trim()) return '';

  const headingPattern = /^(?:#{1,4}\s+)?v?(\d+(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?)(?:\s*:|\s|$)/gm;
  const headings = [...source.matchAll(headingPattern)].map((match) => ({
    version: match[1],
    index: match.index,
  }));
  if (!headings.length) return source;

  const sections = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (compareVersions(heading.version, before) <= 0) continue;
    if (compareVersions(heading.version, after) > 0) continue;
    const end = headings[index + 1]?.index ?? source.length;
    sections.push(source.slice(heading.index, end).trim());
  }
  return sections.join('\n\n').trim();
}

export function collectAddedHelpLines(beforeHelp, afterHelp) {
  const before = new Set(String(beforeHelp || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return String(afterHelp || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !before.has(line))
    .filter((line) => !line.startsWith('Usage:'))
    .slice(0, 20);
}

export function fallbackImportantSummary(notes, { maxLines = 5 } = {}) {
  const candidates = String(notes || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*·]\s+/.test(line))
    .map((line) => line.replace(/^[-*·]\s+/, '').trim())
    .filter(Boolean);

  const important = candidates.filter((line) => (
    /security|credential|permission|sandbox|breaking|migration|新增|安全|权限|凭证|迁移|修复|fixed|added|improved/i.test(line)
  ));
  const chosen = [...new Set([...important, ...candidates])].slice(0, maxLines);
  if (!chosen.length) return '官方没有提供可用的逐版说明。';
  return chosen.map((line) => `- ${line}`).join('\n');
}

export function shouldCreateReport({ updates = [], failures = [] } = {}) {
  return updates.length > 0 || failures.length > 0;
}

export function buildUpgradeReport({ date, updates = [], failures = [] } = {}) {
  const lines = [`# Agent 更新 ${date}`];

  if (updates.length) {
    lines.push('', `本次更新了 ${updates.length} 个 Agent。`);
    for (const update of updates) {
      lines.push('', `## ${update.name}`, `\`${update.before}\` → \`${update.after}\``);
      lines.push('', String(update.summary || '官方没有提供可用的逐版说明。').trim());
      if (update.sourceUrl) lines.push('', `[官方说明](${update.sourceUrl})`);
    }
  }

  if (failures.length) {
    lines.push('', '## 未完成');
    for (const failure of failures) {
      lines.push(`- ${failure.name}：${failure.message}`);
    }
  }

  return lines.join('\n').trim();
}

export function buildThreadReportContent(content, userId = '') {
  const mention = String(userId || '').trim();
  const report = String(content || '').trim();
  return `${mention ? `<@${mention}>\n` : ''}${report}`.trim();
}

export function chunkDiscordContent(content, limit = 1900) {
  const text = String(content || '').trim();
  if (!text) return [];
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
