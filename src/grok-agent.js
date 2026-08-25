import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_GROK_FORK_TIMEOUT_MS = 30_000;

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function buildForkParams({ sourceSessionId, sourceCwd, newCwd } = {}) {
  const normalizedSessionId = normalizeText(sourceSessionId);
  const normalizedSourceCwd = normalizeText(sourceCwd);
  const normalizedNewCwd = normalizeText(newCwd);
  if (!normalizedSessionId) throw new Error('sourceSessionId is required for Grok fork');
  if (!normalizedSourceCwd) throw new Error('sourceCwd is required for Grok fork');
  if (!normalizedNewCwd) throw new Error('newCwd is required for Grok fork');
  if (canonicalPath(normalizedSourceCwd) === canonicalPath(normalizedNewCwd)) {
    throw new Error('Grok fork requires a distinct child workspace');
  }
  return {
    sourceSessionId: normalizedSessionId,
    sourceCwd: normalizedSourceCwd,
    newCwd: normalizedNewCwd,
  };
}

function writeJsonLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function createGrokAgentClient({
  grokBin = 'grok',
  env = process.env,
  spawnFn = spawn,
  timeoutMs = DEFAULT_GROK_FORK_TIMEOUT_MS,
} = {}) {
  const bin = normalizeText(grokBin) || 'grok';

  async function request(method, params) {
    const child = spawnFn(bin, ['agent', '--always-approve', '--no-leader', 'stdio'], {
      cwd: params.sourceCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let nextId = 1;
    let stderr = '';
    let closed = false;
    let rl = null;
    const pending = new Map();

    const cleanup = () => {
      closed = true;
      clearTimeout(timer);
      try { rl?.close?.(); } catch {}
      try { child.stdin?.end?.(); } catch {}
      if (!child.killed && typeof child.kill === 'function') {
        try { child.kill(); } catch {}
      }
    };
    const rejectAll = (err) => {
      for (const slot of pending.values()) slot.reject(err);
      pending.clear();
    };
    const processError = (prefix) => {
      const detail = stderr.trim();
      return new Error(detail ? `${prefix}: ${detail}` : prefix);
    };
    const timer = setTimeout(() => {
      rejectAll(processError(`Grok agent timed out after ${timeoutMs}ms`));
      cleanup();
    }, timeoutMs);

    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk || ''); });
    child.on?.('error', (err) => {
      rejectAll(err);
      cleanup();
    });
    child.on?.('exit', (code, signal) => {
      if (closed || pending.size === 0) return;
      rejectAll(processError(`Grok agent exited before replying (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
    });

    rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let payload;
      try {
        payload = JSON.parse(String(line || ''));
      } catch {
        return;
      }
      if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'id')) return;
      const slot = pending.get(payload.id);
      if (!slot) return;
      pending.delete(payload.id);
      if (payload.error) {
        const detail = payload.error.data ? `: ${payload.error.data}` : '';
        slot.reject(new Error(`Grok agent ${slot.method} failed: ${payload.error.message || JSON.stringify(payload.error)}${detail}`));
        return;
      }
      slot.resolve(payload.result);
    });

    const send = (requestMethod, requestParams) => new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject, method: requestMethod });
      try {
        writeJsonLine(child.stdin, {
          jsonrpc: '2.0',
          id,
          method: requestMethod,
          params: requestParams,
        });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });

    try {
      await send('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      });
      return await send(method, params);
    } finally {
      cleanup();
    }
  }

  async function forkSession(options = {}) {
    const params = buildForkParams(options);
    const result = await request('_x.ai/session/fork', params);
    const sessionId = normalizeText(result?.newSessionId);
    const parentSessionId = normalizeText(result?.parentSessionId);
    const newCwd = normalizeText(result?.newCwd);
    if (!sessionId || sessionId === params.sourceSessionId) {
      throw new Error('Grok agent did not return an independent forked session id');
    }
    if (parentSessionId !== params.sourceSessionId) {
      throw new Error('Grok agent returned a fork with the wrong parent session');
    }
    if (!newCwd || canonicalPath(newCwd) !== canonicalPath(params.newCwd)) {
      throw new Error('Grok agent returned a fork in the wrong workspace');
    }
    return {
      sessionId,
      parentSessionId,
      cwd: newCwd,
      raw: result,
    };
  }

  return { forkSession, request };
}

export async function forkGrokSession(options = {}) {
  return createGrokAgentClient(options).forkSession(options);
}
