import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureRuntimeProxy,
  createDiscordClient,
  normalizeSlashPrefix,
  readCodexDefaults,
  renderMissingDiscordTokenHint,
} from '../src/runtime-bootstrap.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discord-runtime-bootstrap-'));
}

test('readCodexDefaults reads model and reasoning effort from ~/.codex/config.toml', () => {
  const rootDir = makeTempRoot();
  const homeDir = path.join(rootDir, 'home');
  const configDir = path.join(homeDir, '.codex');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.toml'),
    ['model = "o3"', 'model_reasoning_effort = "high"'].join('\n'),
  );

  assert.deepEqual(readCodexDefaults({ env: { HOME: homeDir } }), {
    model: 'o3',
    effort: 'high',
  });
  assert.deepEqual(readCodexDefaults({ env: { HOME: path.join(rootDir, 'missing') } }), {
    model: '(unknown)',
    effort: '(unknown)',
  });
});

test('normalizeSlashPrefix trims strips and truncates invalid input', () => {
  assert.equal(normalizeSlashPrefix('  Codex-Bot__Alpha!!  '), 'codexbot__al');
  assert.equal(normalizeSlashPrefix('___'), '');
  assert.equal(normalizeSlashPrefix(''), '');
});

test('renderMissingDiscordTokenHint explains provider-scoped and shared token states', () => {
  assert.equal(
    renderMissingDiscordTokenHint({ botProvider: 'gemini', env: {} }),
    'Missing Discord token in environment (DISCORD_TOKEN_GEMINI or DISCORD_TOKEN)',
  );
  assert.match(
    renderMissingDiscordTokenHint({
      env: {
        CODEX__DISCORD_TOKEN: 'a',
        GEMINI__DISCORD_TOKEN: 'b',
      },
    }),
    /Found provider-scoped tokens for: codex, gemini/,
  );
  assert.equal(
    renderMissingDiscordTokenHint({ env: {} }),
    'Missing DISCORD_TOKEN in environment',
  );
});

test('configureRuntimeProxy wires repaired proxy settings into agents and logs', () => {
  const env = {
    HTTP_PROXY: 'http://127.0.0.1:7890',
    SOCKS_PROXY: 'socks5h://127.0.0.1:7891',
    INSECURE_TLS: '1',
  };
  const globalTarget = {};
  const dispatcherCalls = [];
  const repairs = [];

  const result = configureRuntimeProxy({
    env,
    envFilePath: '/tmp/.env',
    autoRepairProxyEnvFn: (envFilePath, options) => {
      repairs.push({ envFilePath, options });
      return { logs: ['proxy repaired'] };
    },
    createHttpProxyAgent: (uri) => ({ kind: 'http', uri }),
    createSocksProxyAgent: (uri) => ({ kind: 'socks', uri }),
    setGlobalDispatcherFn: (agent) => dispatcherCalls.push(agent),
    globalTarget,
  });

  assert.equal(repairs[0].envFilePath, '/tmp/.env');
  assert.equal(repairs[0].options.env, env);
  assert.deepEqual(result.restProxyAgent, { kind: 'http', uri: 'http://127.0.0.1:7890' });
  assert.deepEqual(result.wsProxyAgent, { kind: 'socks', uri: 'socks5h://127.0.0.1:7891' });
  assert.deepEqual(dispatcherCalls, [{ kind: 'http', uri: 'http://127.0.0.1:7890' }]);
  assert.equal(globalTarget.__discordWsAgent, result.wsProxyAgent);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  assert.deepEqual(result.logs, [
    'proxy repaired',
    '🌐 Proxy: REST=http://127.0.0.1:7890 | WS=socks5h://127.0.0.1:7891 | INSECURE_TLS=true',
  ]);
});

test('createDiscordClient applies Discord intents and optional REST proxy agent', () => {
  class FakeClient {
    constructor(options) {
      this.options = options;
      this.rest = {
        setAgent: (agent) => {
          this.agent = agent;
        },
      };
    }
  }

  const restProxyAgent = { kind: 'proxy' };
  const client = createDiscordClient({
    Client: FakeClient,
    GatewayIntentBits: {
      Guilds: 'guilds',
      GuildMessages: 'messages',
      MessageContent: 'content',
    },
    Partials: {
      Channel: 'channel',
      Message: 'message',
    },
    restProxyAgent,
  });

  assert.deepEqual(client.options.intents, ['guilds', 'messages', 'content']);
  assert.deepEqual(client.options.partials, ['channel', 'message']);
  assert.equal(client.agent, restProxyAgent);
});
