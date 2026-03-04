function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n?/g, '\n').trim();
}

function parseFenceLine(line) {
  const trimmed = String(line || '').trim();
  const match = trimmed.match(/^([`~]{3,})(.*)$/);
  if (!match) return null;

  const marker = match[1];
  const markerChar = marker[0];
  const isBacktickFence = markerChar === '`' && /^`+$/.test(marker);
  const isTildeFence = markerChar === '~' && /^~+$/.test(marker);
  if (!isBacktickFence && !isTildeFence) return null;

  return {
    markerChar,
    markerLength: marker.length,
    rest: match[2] || '',
    openerLine: trimmed,
  };
}

function isFenceClosingLine(parsed, fenceState) {
  if (!parsed || !fenceState) return false;
  if (parsed.markerChar !== fenceState.markerChar) return false;
  if (parsed.markerLength < fenceState.markerLength) return false;
  return !parsed.rest.trim();
}

function transitionFenceState(currentFence, line) {
  const parsed = parseFenceLine(line);
  if (!parsed) return currentFence;
  if (!currentFence) return parsed;
  return isFenceClosingLine(parsed, currentFence) ? null : currentFence;
}

function fenceClosingText(fenceState, text) {
  if (!fenceState) return '';
  const marker = fenceState.markerChar.repeat(fenceState.markerLength);
  return text.endsWith('\n') ? marker : `\n${marker}`;
}

function startChunk(openFence) {
  if (!openFence) return '';
  return `${openFence.openerLine}\n`;
}

function finalizeChunk(text, openFence) {
  let out = text;
  if (openFence) out += fenceClosingText(openFence, out);
  return out.trimEnd();
}

function pickSplitPoint(text, limit) {
  if (text.length <= limit) return text.length;
  const probe = text.slice(0, limit);
  const minBoundary = Math.max(20, Math.floor(limit * 0.45));
  const newline = probe.lastIndexOf('\n');
  if (newline >= minBoundary) return newline + 1;
  const space = probe.lastIndexOf(' ');
  if (space >= minBoundary) return space + 1;
  return limit;
}

export function splitForDiscord(text, limit = 1900) {
  const source = normalizeText(text);
  if (!source) return [];

  const maxChars = Math.max(80, Number(limit) || 1900);
  const lines = source.split('\n');
  const chunks = [];
  let chunk = '';
  let fenceState = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const token = i < lines.length - 1 ? `${rawLine}\n` : rawLine;
    const nextFenceState = transitionFenceState(fenceState, rawLine);
    let consumed = 0;

    while (consumed < token.length) {
      const remaining = token.slice(consumed);
      const consumingWholeLine = consumed === 0 && remaining.length === token.length;
      const fenceAfterAppend = consumingWholeLine ? nextFenceState : fenceState;
      const candidate = chunk + remaining;
      const candidateSuffix = fenceClosingText(fenceAfterAppend, candidate);

      if (candidate.length + candidateSuffix.length <= maxChars) {
        chunk = candidate;
        consumed = token.length;
        fenceState = nextFenceState;
        continue;
      }

      if (chunk) {
        chunks.push(finalizeChunk(chunk, fenceState));
        chunk = startChunk(fenceState);
        continue;
      }

      const baseSuffix = fenceClosingText(fenceState, '');
      const pieceLimit = Math.max(1, maxChars - baseSuffix.length);
      const splitAt = pickSplitPoint(remaining, pieceLimit);
      chunk = remaining.slice(0, splitAt);
      consumed += splitAt;

      if (consumed < token.length) {
        chunks.push(finalizeChunk(chunk, fenceState));
        chunk = startChunk(fenceState);
        continue;
      }

      fenceState = nextFenceState;
    }
  }

  if (chunk) chunks.push(finalizeChunk(chunk, fenceState));
  return chunks.filter(Boolean);
}
