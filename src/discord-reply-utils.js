const REPLY_TO_SYSTEM_MESSAGE_CODE = 'REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE';
const REPLY_TO_SYSTEM_MESSAGE_HINT = 'cannot reply to a system message';
const MESSAGE_REFERENCE_HINT = 'message_reference';

function collectErrorCodes(node, out = new Set(), depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectErrorCodes(item, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;

  const code = node.code;
  if (typeof code === 'string' && code.trim()) {
    out.add(code.trim());
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectErrorCodes(value, out, depth + 1);
    }
  }
  return out;
}

function hasDiscordValidationCode(err, code) {
  const direct = Number(err?.code);
  const raw = Number(err?.rawError?.code);
  return direct === code || raw === code;
}

export function isReplyToSystemMessageError(err) {
  if (!err) return false;

  const text = [
    String(err.message || ''),
    String(err.rawError?.message || ''),
  ].join(' ').toLowerCase();
  if (text.includes(REPLY_TO_SYSTEM_MESSAGE_CODE.toLowerCase())) return true;
  if (text.includes(REPLY_TO_SYSTEM_MESSAGE_HINT)) return true;

  const nestedCodes = collectErrorCodes(err.rawError?.errors);
  if (nestedCodes.has(REPLY_TO_SYSTEM_MESSAGE_CODE)) return true;

  // Discord may change error payload shape; treat message_reference + 50035 as same class.
  return hasDiscordValidationCode(err, 50035) && text.includes(MESSAGE_REFERENCE_HINT);
}

export async function safeReply(message, payload, { logger = console } = {}) {
  try {
    return await message.reply(payload);
  } catch (err) {
    if (!isReplyToSystemMessageError(err)) throw err;

    const channel = message?.channel;
    if (!channel || typeof channel.send !== 'function') throw err;

    logger.warn(`⚠️ Cannot reply to system message ${message?.id || '(unknown)'}, fallback to channel.send`);
    return await channel.send(payload);
  }
}
