import { randomUUID } from 'node:crypto';
import { splitForDiscord } from './discord-message-splitter.js';

const FORKABLE_PROVIDERS = new Set(['codex', 'claude', 'grok']);

function normalizeForkProvider(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || 'codex';
}

export function providerSupportsNativeFork(provider) {
  return FORKABLE_PROVIDERS.has(normalizeForkProvider(provider));
}

export function normalizeForkSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

export function normalizeForkThreadName(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 100) : '';
}

function normalizeForkWorkspaceDir(value) {
  const text = String(value || '').trim();
  return text || null;
}

function shortenId(value) {
  const text = normalizeForkSessionId(value);
  if (!text) return 'new';
  return text.length <= 12 ? text : text.slice(0, 8);
}

function getForkRequesterId(source) {
  return String(source?.user?.id || source?.author?.id || '').trim() || null;
}

function getForkBotUserId(source) {
  return String(
    source?.client?.user?.id
    || source?.channel?.client?.user?.id
    || source?.guild?.client?.user?.id
    || '',
  ).trim() || null;
}

function normalizeMessageContent(message) {
  const text = String(message?.content || '').trim();
  return text || null;
}

function collectionToArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return [...value.values()];
  if (typeof value[Symbol.iterator] === 'function') return [...value].map((entry) => (
    Array.isArray(entry) && entry.length >= 2 ? entry[1] : entry
  ));
  return [];
}

function compareMessageRecency(a, b) {
  const aTime = Number(a?.createdTimestamp || 0);
  const bTime = Number(b?.createdTimestamp || 0);
  if (aTime !== bTime) return bTime - aTime;
  try {
    const aId = BigInt(String(a?.id || '0'));
    const bId = BigInt(String(b?.id || '0'));
    if (aId === bId) return 0;
    return aId > bId ? -1 : 1;
  } catch {
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  }
}

async function fetchParentMessages(source) {
  const fetch = source?.channel?.messages?.fetch;
  if (typeof fetch !== 'function') return [];
  const options = { limit: 100 };
  const sourceId = String(source?.id || '').trim();
  if (sourceId) options.before = sourceId;
  return collectionToArray(await fetch.call(source.channel.messages, options));
}

function isForkBotMessage(message, botUserId) {
  const authorId = String(message?.author?.id || '').trim();
  if (botUserId) return authorId === botUserId;
  return Boolean(message?.author?.bot);
}

function getReplyReferenceMessageId(message) {
  return String(
    message?.reference?.messageId
    || message?.reference?.message_id
    || message?.messageReference?.messageId
    || '',
  ).trim() || null;
}

function findLatestParentAgentMessages(messages, source) {
  const botUserId = getForkBotUserId(source);
  const sourceId = String(source?.id || '').trim();
  const ordered = messages
    .filter((message) => {
      if (!message || String(message.id || '') === sourceId) return false;
      if (!normalizeMessageContent(message)) return false;
      return true;
    })
    .sort(compareMessageRecency);
  const latestIndex = ordered.findIndex((message) => isForkBotMessage(message, botUserId));
  if (latestIndex < 0) return [];

  const answer = [];
  for (let index = latestIndex; index < ordered.length; index += 1) {
    const message = ordered[index];
    if (!isForkBotMessage(message, botUserId)) break;
    answer.push(message);
    if (getReplyReferenceMessageId(message)) break;
  }
  return answer.reverse();
}

function formatLatestAgentReplayContent(text, language = 'zh') {
  const body = String(text || '').trim();
  if (!body) return [];
  const title = language === 'en' ? 'Latest agent message:' : '最近一次 agent 输出：';
  const combined = `${title}\n\n${body}`;
  const chunks = splitForDiscord(combined, 1900);
  return chunks.length ? chunks : [combined.slice(0, 1900).trim()];
}

async function replayLatestParentAgentMessage(childThread, {
  source,
  language = 'zh',
} = {}) {
  if (typeof childThread?.send !== 'function') {
    return { ok: false, skipped: true, error: 'child thread cannot send messages' };
  }
  try {
    const latest = findLatestParentAgentMessages(await fetchParentMessages(source), source);
    const text = latest.map(normalizeMessageContent).filter(Boolean).join('\n\n').trim();
    if (!text) return { ok: false, skipped: true, reason: 'no_parent_agent_message' };
    const messages = [];
    for (const content of formatLatestAgentReplayContent(text, language)) {
      messages.push(await childThread.send({ content }));
    }
    return {
      ok: true,
      sourceMessageId: latest[latest.length - 1]?.id || null,
      sourceMessageIds: latest.map((message) => message.id).filter(Boolean),
      messages,
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: String(err?.message || err || 'unknown error'),
    };
  }
}

export function parseForkTextInput(input) {
  return { threadName: normalizeForkThreadName(input) };
}

export function formatForkThreadName({ forkedSessionId, parentSessionId, provider = 'codex' } = {}) {
  const providerLabel = normalizeForkProvider(provider);
  const forkShort = shortenId(forkedSessionId);
  const parentShort = shortenId(parentSessionId);
  return `${providerLabel} fork ${forkShort} from ${parentShort}`.slice(0, 100);
}

function resolveThreadCreateChannel(channel) {
  if (channel?.threads && typeof channel.threads.create === 'function') return channel;
  if (typeof channel?.isThread === 'function' && channel.isThread() && channel.parent?.threads && typeof channel.parent.threads.create === 'function') {
    return channel.parent;
  }
  if (channel?.parent?.threads && typeof channel.parent.threads.create === 'function') return channel.parent;
  return null;
}

export function canCreateDiscordForkThread(source) {
  return Boolean(resolveThreadCreateChannel(source?.channel));
}

async function createDiscordForkThread(source, { parentSessionId, forkedSessionId, threadName = '', provider = 'codex' } = {}) {
  const targetChannel = resolveThreadCreateChannel(source?.channel);
  if (!targetChannel) {
    throw new Error('当前频道不支持创建 Discord thread，无法放置 fork。');
  }
  const requestedName = normalizeForkThreadName(threadName);
  const thread = await targetChannel.threads.create({
    name: requestedName || formatForkThreadName({ forkedSessionId, parentSessionId, provider }),
    autoArchiveDuration: 1440,
    reason: `${normalizeForkProvider(provider)} fork from ${parentSessionId}`,
  });
  try {
    await thread.join?.();
  } catch {
  }
  return thread;
}

export function createSyntheticForkMessage(source, childThread) {
  const author = source?.user || source?.author || {};
  const client = source?.client || source?.channel?.client || childThread?.client || null;
  const reactions = {
    cache: {
      get: () => ({ users: { remove: async () => {} } }),
    },
  };
  return {
    id: String(source?.id || `fork-${Date.now()}`),
    channelId: childThread?.id,
    channel: childThread,
    author,
    client,
    system: false,
    content: '',
    attachments: { size: 0 },
    reactions,
    react: async () => {},
    reply: async (payload) => childThread.send(payload),
  };
}

function formatForkProviderLabel(provider) {
  const normalizedProvider = normalizeForkProvider(provider);
  if (normalizedProvider === 'claude') return 'Claude';
  if (normalizedProvider === 'grok') return 'Grok';
  if (normalizedProvider === 'antigravity') return 'Antigravity';
  return 'Codex';
}

function formatForkOriginNotice({ userId, provider, parentSessionId, forkedSessionId, language = 'zh' } = {}) {
  const mention = userId ? `<@${userId}> ` : '';
  const providerLabel = formatForkProviderLabel(provider);
  if (language === 'en') {
    return `${mention}This thread was forked from ${providerLabel} session \`${parentSessionId}\`. Fork session: \`${forkedSessionId}\`.`;
  }
  return `${mention}这是从 ${providerLabel} session \`${parentSessionId}\` fork 过来的。fork session：\`${forkedSessionId}\`。`;
}

async function sendForkOriginNotice(childThread, {
  source,
  provider,
  parentSessionId,
  forkedSessionId,
  language,
} = {}) {
  if (typeof childThread?.send !== 'function') {
    return { ok: false, skipped: true, error: 'child thread cannot send messages' };
  }
  const userId = getForkRequesterId(source);
  const payload = {
    content: formatForkOriginNotice({
      userId,
      provider,
      parentSessionId,
      forkedSessionId,
      language,
    }),
  };
  if (userId) {
    payload.allowedMentions = { users: [userId] };
  }
  try {
    const message = await childThread.send(payload);
    return { ok: true, message, userId };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      userId,
      error: String(err?.message || err || 'unknown error'),
    };
  }
}

export async function createCodexForkThread({
  ...options
} = {}) {
  return createProviderForkThread({
    ...options,
    provider: 'codex',
  });
}

export async function createProviderForkThread({
  key,
  session,
  source,
  parentSessionId,
  threadName = '',
  prompt = '',
  provider = 'codex',
  getRuntimeSnapshot = () => ({ running: false, queued: 0 }),
  getSession,
  commandActions = {},
  forkCodexThread,
  forkGrokSession,
  enqueuePrompt,
  resolveSecurityContext,
  createThread = createDiscordForkThread,
  generateSessionId = randomUUID,
  resolveForkWorkspace = () => null,
  prepareForkWorkspace = null,
} = {}) {
  const normalizedProvider = normalizeForkProvider(provider);
  const normalizedParentSessionId = normalizeForkSessionId(parentSessionId);
  if (!normalizedParentSessionId) {
    return { ok: false, reason: 'missing_parent_session' };
  }
  if (!providerSupportsNativeFork(normalizedProvider)) {
    return { ok: false, reason: 'fork_unsupported', provider: normalizedProvider };
  }
  const runtime = getRuntimeSnapshot(key) || {};
  if (runtime.running) {
    return { ok: false, reason: 'parent_running' };
  }
  if (!canCreateDiscordForkThread(source)) {
    return { ok: false, reason: 'thread_unavailable' };
  }
  if (normalizedProvider === 'codex' && typeof forkCodexThread !== 'function') {
    return { ok: false, reason: 'fork_unavailable' };
  }
  if (normalizedProvider === 'grok' && typeof forkGrokSession !== 'function') {
    return { ok: false, reason: 'fork_unavailable' };
  }
  if (typeof getSession !== 'function') {
    throw new Error('getSession is required for provider fork');
  }
  if (typeof commandActions.bindForkedSession !== 'function') {
    throw new Error('bindForkedSession is required for provider fork');
  }

  const plannedForkedSessionId = normalizedProvider === 'claude'
    ? normalizeForkSessionId(generateSessionId())
    : null;
  if (normalizedProvider === 'claude' && !plannedForkedSessionId) {
    throw new Error(`${formatForkProviderLabel(normalizedProvider)} fork did not receive a generated session id`);
  }
  const parentWorkspaceDir = ['claude', 'grok'].includes(normalizedProvider)
    ? normalizeForkWorkspaceDir(resolveForkWorkspace({
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
      parentSession: session,
      source,
    }))
    : null;
  if (['claude', 'grok'].includes(normalizedProvider) && !parentWorkspaceDir) {
    return {
      ok: false,
      reason: 'fork_workspace_unavailable',
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
    };
  }

  const childThread = await createThread(source, {
    parentSessionId: normalizedParentSessionId,
    forkedSessionId: plannedForkedSessionId,
    threadName,
    provider: normalizedProvider,
  });
  if (!childThread?.id) {
    throw new Error('Discord thread creation did not return a thread id');
  }

  let forkWorkspaceDir = null;
  if (typeof prepareForkWorkspace !== 'function') {
    try {
      await childThread.delete?.(`${normalizedProvider} fork workspace preparation unavailable`);
    } catch {
    }
    return {
      ok: false,
      reason: 'fork_workspace_unavailable',
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
    };
  }
  try {
    forkWorkspaceDir = normalizeForkWorkspaceDir(await prepareForkWorkspace({
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
      parentSession: session,
      parentWorkspaceDir,
      source,
      childThread,
      childThreadId: childThread.id,
    }));
  } catch (err) {
    try {
      await childThread.delete?.(`${normalizedProvider} fork workspace preparation failed`);
    } catch {
    }
    throw err;
  }
  if (!forkWorkspaceDir) {
    try {
      await childThread.delete?.(`${normalizedProvider} fork workspace unavailable`);
    } catch {
    }
    return {
      ok: false,
      reason: 'fork_workspace_unavailable',
      provider: normalizedProvider,
      parentSessionId: normalizedParentSessionId,
    };
  }

  let forkResult = null;
  let forkedSessionId = plannedForkedSessionId;
  if (normalizedProvider === 'codex') {
    try {
      forkResult = await forkCodexThread({
        threadId: normalizedParentSessionId,
        cwd: forkWorkspaceDir,
      });
    } catch (err) {
      try {
        await childThread.delete?.('Codex fork failed before session binding');
      } catch {
      }
      throw err;
    }
    forkedSessionId = normalizeForkSessionId(forkResult?.threadId || forkResult?.thread?.id);
    if (!forkedSessionId) {
      try {
        await childThread.delete?.('Codex fork did not return a session id');
      } catch {
      }
      throw new Error('Codex fork did not return a session id');
    }
  } else if (normalizedProvider === 'grok') {
    try {
      forkResult = await forkGrokSession({
        sourceSessionId: normalizedParentSessionId,
        sourceCwd: parentWorkspaceDir,
        newCwd: forkWorkspaceDir,
      });
    } catch (err) {
      try {
        await childThread.delete?.('Grok fork failed before session binding');
      } catch {
      }
      throw err;
    }
    forkedSessionId = normalizeForkSessionId(forkResult?.sessionId);
    if (!forkedSessionId) {
      try {
        await childThread.delete?.('Grok fork did not return a session id');
      } catch {
      }
      throw new Error('Grok fork did not return a session id');
    }
  }
  if (!normalizeForkThreadName(threadName) && typeof childThread.setName === 'function') {
    try {
      await childThread.setName(
        formatForkThreadName({ parentSessionId: normalizedParentSessionId, forkedSessionId, provider: normalizedProvider }),
        `${normalizedProvider} fork session assigned`,
      );
    } catch {
    }
  }

  let childSession = null;
  let binding = null;
  try {
    childSession = getSession(childThread.id, {
      channel: childThread,
      parentChannelId: key,
    });
    childSession.workspaceDir = forkWorkspaceDir;
    binding = commandActions.bindForkedSession(childSession, {
      sessionId: forkedSessionId,
      parentSessionId: normalizedParentSessionId,
      parentChannelId: key,
      provider: normalizedProvider,
      pendingForkFromSessionId: normalizedProvider === 'claude'
        ? normalizedParentSessionId
        : null,
      workspaceDir: forkWorkspaceDir,
    });
  } catch (err) {
    try {
      await childThread.delete?.(`${normalizedProvider} fork failed before session binding`);
    } catch {
    }
    throw err;
  }
  const notice = await sendForkOriginNotice(childThread, {
    source,
    provider: normalizedProvider,
    parentSessionId: normalizedParentSessionId,
    forkedSessionId,
    language: session?.language || childSession?.language || 'zh',
  });
  const latestAgentReplay = await replayLatestParentAgentMessage(childThread, {
    source,
    language: session?.language || childSession?.language || 'zh',
  });

  const normalizedPrompt = String(prompt || '').trim();
  let promptQueue = null;
  if (normalizedPrompt) {
    if (typeof enqueuePrompt !== 'function') {
      promptQueue = { ok: false, enqueued: false, error: 'enqueuePrompt is unavailable' };
    } else {
      try {
        const syntheticMessage = createSyntheticForkMessage(source, childThread);
        const securityContext = typeof resolveSecurityContext === 'function'
          ? resolveSecurityContext(childThread, childSession)
          : null;
        promptQueue = await enqueuePrompt(syntheticMessage, childThread.id, normalizedPrompt, securityContext);
      } catch (err) {
        promptQueue = {
          ok: false,
          enqueued: false,
          error: String(err?.message || err || 'unknown error'),
        };
      }
    }
  }

  return {
    ok: true,
    provider: normalizedProvider,
    parentSessionId: normalizedParentSessionId,
    forkedSessionId,
    forkedFromId: normalizeForkSessionId(forkResult?.forkedFromId || forkResult?.parentSessionId) || normalizedParentSessionId,
    childThread,
    childSession,
    binding,
    notice,
    latestAgentReplay,
    promptQueue,
  };
}

export function formatCodexForkResult(result, language = 'zh') {
  return formatProviderForkResult(result, language);
}

export function formatProviderForkResult(result, language = 'zh') {
  const providerLabel = formatForkProviderLabel(result?.provider || 'codex');
  if (!result?.ok) {
    if (result?.reason === 'missing_parent_session') {
      return language === 'en'
        ? `❌ No ${providerLabel} session is bound here yet. Run one task first.`
        : `❌ 当前频道还没有绑定 ${providerLabel} session。先跑一轮。`;
    }
    if (result?.reason === 'parent_running') {
      return language === 'en'
        ? '⏳ The parent channel is running. Fork after the current task finishes.'
        : '⏳ 父频道正在运行任务，等这轮结束后再 fork。';
    }
    if (result?.reason === 'fork_unsupported') {
      return language === 'en'
        ? `❌ Native fork is unavailable for ${providerLabel}.`
        : `❌ ${providerLabel} 不支持原生 fork。`;
    }
    if (result?.reason === 'fork_unavailable') {
      return language === 'en'
        ? `❌ ${providerLabel} native fork is unavailable in this runtime.`
        : `❌ 当前运行环境没有接入 ${providerLabel} 原生 fork。`;
    }
    if (result?.reason === 'fork_workspace_unavailable') {
      return language === 'en'
        ? `❌ Cannot resolve the parent ${providerLabel} workspace for fork.`
        : `❌ 无法解析父 ${providerLabel} session 的工作目录，fork 已取消。`;
    }
    if (result?.reason === 'thread_unavailable') {
      return language === 'en'
        ? '❌ This Discord channel cannot create a fork thread.'
        : '❌ 当前 Discord 频道不能创建 fork thread。';
    }
    return language === 'en' ? `❌ ${providerLabel} fork failed.` : `❌ ${providerLabel} fork 失败。`;
  }

  const channelLabel = result.childThread?.id ? `<#${result.childThread.id}>` : result.childThread?.name || '(new thread)';
  const promptQueued = result.promptQueue?.enqueued;
  const queuedAhead = Number(result.promptQueue?.queuedAhead || 0);
  const promptError = String(result.promptQueue?.error || '').trim();
  const noticeError = result.notice && !result.notice.ok && !result.notice.skipped
    ? String(result.notice.error || '').trim()
    : '';
  const replayError = result.latestAgentReplay && !result.latestAgentReplay.ok && !result.latestAgentReplay.skipped
    ? String(result.latestAgentReplay.error || '').trim()
    : '';
  if (language === 'en') {
    return [
      promptError
        ? `⚠️ Created ${providerLabel} fork in ${channelLabel}, but the prompt was not queued`
        : `✅ Created ${providerLabel} fork in ${channelLabel}`,
      `• fork session: \`${result.forkedSessionId}\``,
      `• parent session: \`${result.parentSessionId}\``,
      promptQueued ? `• prompt queued in fork${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ''}` : null,
      promptError ? `• error: ${promptError}` : null,
      noticeError ? `• notice failed: ${noticeError}` : null,
      replayError ? `• latest agent message replay failed: ${replayError}` : null,
    ].filter(Boolean).join('\n');
  }
  return [
    promptError
      ? `⚠️ 已创建 ${providerLabel} fork：${channelLabel}，但 prompt 没有入队`
      : `✅ 已创建 ${providerLabel} fork：${channelLabel}`,
    `• fork session: \`${result.forkedSessionId}\``,
    `• parent session: \`${result.parentSessionId}\``,
    promptQueued ? `• prompt 已进入 fork 队列${queuedAhead > 0 ? `，前面还有 ${queuedAhead} 条` : ''}` : null,
    promptError ? `• 错误：${promptError}` : null,
    noticeError ? `• 通知发送失败：${noticeError}` : null,
    replayError ? `• 最近一次 agent 输出转发失败：${replayError}` : null,
  ].filter(Boolean).join('\n');
}
