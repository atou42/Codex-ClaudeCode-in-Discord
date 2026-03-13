import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';

import { autoRepairProxyEnv } from './proxy-env.js';

const UNKNOWN_CODEX_DEFAULT = '(unknown)';

export function readCodexDefaults({ env = process.env } = {}) {
  try {
    const home = env.HOME || env.USERPROFILE || '';
    const configPath = path.join(home, '.codex', 'config.toml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const modelMatch = raw.match(/^model\s*=\s*"([^"]+)"/m);
    const effortMatch = raw.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    return {
      model: modelMatch?.[1] || UNKNOWN_CODEX_DEFAULT,
      effort: effortMatch?.[1] || UNKNOWN_CODEX_DEFAULT,
    };
  } catch {
    return {
      model: UNKNOWN_CODEX_DEFAULT,
      effort: UNKNOWN_CODEX_DEFAULT,
    };
  }
}

export function normalizeSlashPrefix(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '');
  if (!raw) return '';
  return raw.slice(0, 12);
}

export function renderMissingDiscordTokenHint({ botProvider = null, env = process.env } = {}) {
  if (botProvider) {
    return `Missing Discord token in environment (${`DISCORD_TOKEN_${botProvider.toUpperCase()}`} or DISCORD_TOKEN)`;
  }

  const hasCodexScopedToken = Boolean(String(env.CODEX__DISCORD_TOKEN || env.DISCORD_TOKEN_CODEX || '').trim());
  const hasClaudeScopedToken = Boolean(String(env.CLAUDE__DISCORD_TOKEN || env.DISCORD_TOKEN_CLAUDE || '').trim());
  const hasGeminiScopedToken = Boolean(String(env.GEMINI__DISCORD_TOKEN || env.DISCORD_TOKEN_GEMINI || '').trim());

  if (hasCodexScopedToken || hasClaudeScopedToken || hasGeminiScopedToken) {
    const availableProviders = [
      hasCodexScopedToken ? 'codex' : null,
      hasClaudeScopedToken ? 'claude' : null,
      hasGeminiScopedToken ? 'gemini' : null,
    ].filter(Boolean).join(', ');
    return `Missing DISCORD_TOKEN in shared mode. Found provider-scoped tokens for: ${availableProviders}. Start with npm run start:codex / npm run start:claude / npm run start:gemini, or add a shared DISCORD_TOKEN.`;
  }

  return 'Missing DISCORD_TOKEN in environment';
}

export function configureRuntimeProxy({
  env = process.env,
  envFilePath = null,
  autoRepairProxyEnvFn = autoRepairProxyEnv,
  createHttpProxyAgent = (uri) => new ProxyAgent({ uri }),
  createSocksProxyAgent = (uri) => new SocksProxyAgent(uri),
  setGlobalDispatcherFn = setGlobalDispatcher,
  globalTarget = globalThis,
} = {}) {
  const logs = [];
  const proxyRepair = autoRepairProxyEnvFn(envFilePath, { env });
  if (Array.isArray(proxyRepair?.logs) && proxyRepair.logs.length) {
    logs.push(...proxyRepair.logs);
  }

  const httpProxy = String(env.HTTP_PROXY || '').trim() || null;
  const socksProxy = String(env.SOCKS_PROXY || '').trim() || null;
  const insecureTls = String(env.INSECURE_TLS || '0') === '1';
  let restProxyAgent = null;
  let wsProxyAgent = null;

  if (httpProxy) {
    if (insecureTls) env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    restProxyAgent = createHttpProxyAgent(httpProxy);
    setGlobalDispatcherFn(restProxyAgent);
  }

  if (socksProxy) {
    wsProxyAgent = createSocksProxyAgent(socksProxy);
    globalTarget.__discordWsAgent = wsProxyAgent;
  }

  if (httpProxy || socksProxy) {
    logs.push(`🌐 Proxy: REST=${httpProxy || '(none)'} | WS=${socksProxy || '(none)'} | INSECURE_TLS=${insecureTls}`);
  }

  return {
    httpProxy,
    insecureTls,
    logs,
    proxyRepair,
    restProxyAgent,
    socksProxy,
    wsProxyAgent,
  };
}

export function createDiscordClient({
  Client,
  GatewayIntentBits,
  Partials,
  restProxyAgent = null,
} = {}) {
  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  if (restProxyAgent) {
    bot.rest.setAgent(restProxyAgent);
  }

  return bot;
}
