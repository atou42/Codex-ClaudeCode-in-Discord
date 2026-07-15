/**
 * RED tests exposing defects in the rejected ab898bc implementation.
 *
 * These tests MUST FAIL against the old launcher and PASS after repair:
 * 1. Launcher must REQUIRE injected ports (no fake foundation-adapters fallback)
 * 2. Launcher must parse REAL Claude 2.1.201 stream shapes (not invented event.tool/tool_call/turn_end/evaluator)
 * 3. Abort must SIGKILL after grace even though child.killed=true after SIGTERM
 * 4. Env must be a minimal allowlist, never {...process.env}
 * 5. Argv must include --verbose, --mcp-config, --allowedTools with the exact 4 MCP tools
 * 6. DONE must settle ONLY from a cohub_goal_verify tool_use + matching tool_result in this invocation
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { Launcher, State } from '../../src/cohub-claude-goal/launcher.js';
import { makeFakePorts, makeChild, feedStream, REAL_INIT_EVENT } from './helpers.mjs';

describe('repair RED: port injection is mandatory', () => {
  it('constructor throws INVALID_INPUT when ports are missing', () => {
    assert.throws(() => new Launcher({ goalDir: '/tmp/x' }), (err) => err.code === 'INVALID_INPUT');
  });

  it('module must not import fake foundation-adapters', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../../src/cohub-claude-goal/launcher.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('foundation-adapters'), 'launcher must not reference foundation-adapters');
  });

  it('fake foundation-adapters.js file must be removed', async () => {
    const { access } = await import('node:fs/promises');
    await assert.rejects(
      access(new URL('../../src/cohub-claude-goal/foundation-adapters.js', import.meta.url)),
      /ENOENT/
    );
  });
});

describe('repair RED: real stream shapes', () => {
  it('settles DONE only from real tool_use + bound tool_result with ACHIEVED', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    const { result } = await launcher.start({
      driveChild: (child) => {
        feedStream(child, [
          REAL_INIT_EVENT,
          // real assistant tool_use for verify
          { type: 'assistant', message: { id: 'm1', type: 'message', role: 'assistant', content: [
            { type: 'tool_use', id: 'toolu_v1', name: 'mcp__cohub_goal__cohub_goal_verify', input: {} }
          ], stop_reason: 'tool_use' }, session_id: ports.sessionIdHolder.value },
          // real user tool_result bound by tool_use_id
          { type: 'user', message: { role: 'user', content: [
            { tool_use_id: 'toolu_v1', type: 'tool_result', content: [
              { type: 'text', text: JSON.stringify({ ok: true, status: 'ACHIEVED' }) }
            ] }
          ] }, session_id: ports.sessionIdHolder.value },
          { type: 'result', subtype: 'success', is_error: false, num_turns: 1,
            modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 } } }
        ]);
        child.emitExit(0, null);
      }
    });

    assert.strictEqual(result.state, State.DONE);
  });

  it('ignores invented event.type=tool_call / event.tool shapes (INTEGRITY_FAILURE on unknown critical shape)', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    const { result } = await launcher.start({
      driveChild: (child) => {
        feedStream(child, [
          REAL_INIT_EVENT,
          // invented shape from old implementation — must NOT settle anything
          { type: 'tool_call', tool: 'verify', result: { verdict: 'DONE' } }
        ]);
        child.emitExit(0, null);
      }
    });

    assert.notStrictEqual(result.state, State.DONE,
      'invented tool_call event must never settle DONE');
  });

  it('unmatched tool_result (no prior tool_use) is INTEGRITY_FAILURE', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    const { result } = await launcher.start({
      driveChild: (child) => {
        feedStream(child, [
          REAL_INIT_EVENT,
          { type: 'user', message: { role: 'user', content: [
            { tool_use_id: 'toolu_never_issued', type: 'tool_result', content: [
              { type: 'text', text: JSON.stringify({ ok: true, status: 'ACHIEVED' }) }
            ] }
          ] } }
        ]);
        child.emitExit(0, null);
      }
    });

    assert.strictEqual(result.state, State.INTEGRITY_FAILURE);
  });

  it('malformed JSON line is INTEGRITY_FAILURE, not log-and-continue', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    const { result } = await launcher.start({
      driveChild: (child) => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(REAL_INIT_EVENT) + '\n'));
        child.stdout.emit('data', Buffer.from('{broken json\n'));
        child.emitExit(0, null);
      }
    });

    assert.strictEqual(result.state, State.INTEGRITY_FAILURE);
  });

  it('partial final line (no trailing newline before exit) is INTEGRITY_FAILURE', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    const { result } = await launcher.start({
      driveChild: (child) => {
        child.stdout.emit('data', Buffer.from(JSON.stringify(REAL_INIT_EVENT) + '\n'));
        child.stdout.emit('data', Buffer.from('{"type":"result","subtype":"succ')); // truncated
        child.emitExit(0, null);
      }
    });

    assert.strictEqual(result.state, State.INTEGRITY_FAILURE);
  });

  it('fails capability gate when init tools are not exactly the 4 MCP tools', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    const badInit = { ...REAL_INIT_EVENT, tools: ['Bash', 'mcp__cohub_goal__cohub_goal_inspect'] };

    const outcome = await launcher.start({
      driveChild: (child) => {
        feedStream(child, [badInit]);
        child.emitExit(0, null);
      }
    });

    assert.strictEqual(outcome.result.exitCode, 50, 'capability gate exit code 50');
  });
});

describe('repair RED: abort lifecycle', () => {
  it('sends SIGKILL after grace even though child.killed=true after SIGTERM', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options, { termGraceMs: 30 });
    await launcher.init();

    const signals = [];
    let exitEmitted = false;

    const startPromise = launcher.start({
      driveChild: (child) => {
        feedStream(child, [REAL_INIT_EVENT]);
        child.kill = (sig) => {
          signals.push(sig);
          child.killed = true; // node behavior: killed=true after ANY successful signal
          if (sig === 'SIGKILL' && !exitEmitted) {
            exitEmitted = true;
            child.emitExit(null, 'SIGKILL');
          }
          return true;
          // note: SIGTERM is IGNORED by this child — it never exits from it
        };
        // launcher will abort while child ignores SIGTERM
        setTimeout(() => launcher.abort(), 10);
      }
    });

    await startPromise;

    assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL'],
      'must escalate to SIGKILL despite killed=true');
  });

  it('abort resolves exactly once when exit races with grace timer', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options, { termGraceMs: 20 });
    await launcher.init();

    let aborted = 0;
    await launcher.start({
      driveChild: (child) => {
        feedStream(child, [REAL_INIT_EVENT]);
        child.kill = (sig) => {
          child.killed = true;
          // exit arrives just as grace expires
          setTimeout(() => child.emitExit(null, 'SIGTERM'), 19);
          return true;
        };
        setTimeout(async () => { await launcher.abort(); aborted++; }, 5);
      }
    });

    assert.strictEqual(aborted, 1);
  });
});

describe('repair RED: env and argv', () => {
  it('spawn env is a minimal allowlist, never inherits full process.env', async () => {
    process.env.SECRET_SENTINEL_XYZ = 'leak-me';
    try {
      const ports = makeFakePorts();
      const launcher = new Launcher(ports.options);
      await launcher.init();

      let spawnedEnv = null;
      ports.recordSpawn((cmd, args, opts) => { spawnedEnv = opts.env; });

      await launcher.start({
        driveChild: (child) => {
          feedStream(child, [REAL_INIT_EVENT]);
          child.emitExit(0, null);
        }
      });

      assert.ok(spawnedEnv, 'spawn options must include env');
      assert.ok(!('SECRET_SENTINEL_XYZ' in spawnedEnv), 'must not inherit arbitrary env vars');
      assert.ok(!('ANTHROPIC_API_KEY' in spawnedEnv) || spawnedEnv.ANTHROPIC_API_KEY === undefined);
    } finally {
      delete process.env.SECRET_SENTINEL_XYZ;
    }
  });

  it('start argv contains --verbose, --mcp-config file, --strict-mcp-config, allowedTools with exact 4 MCP tools', async () => {
    const ports = makeFakePorts();
    const launcher = new Launcher(ports.options);
    await launcher.init();

    let spawnedArgs = null;
    ports.recordSpawn((cmd, args) => { spawnedArgs = args; });

    await launcher.start({
      driveChild: (child) => {
        feedStream(child, [REAL_INIT_EVENT]);
        child.emitExit(0, null);
      }
    });

    assert.ok(spawnedArgs.includes('--verbose'), 'must include --verbose (required for stream-json with -p)');
    assert.ok(spawnedArgs.includes('--strict-mcp-config'));
    const mcpIdx = spawnedArgs.indexOf('--mcp-config');
    assert.ok(mcpIdx >= 0 && typeof spawnedArgs[mcpIdx + 1] === 'string', 'must pass explicit --mcp-config file');
    const allowedIdx = spawnedArgs.indexOf('--allowedTools');
    assert.ok(allowedIdx >= 0, 'must pass --allowedTools');
    const allowed = spawnedArgs[allowedIdx + 1];
    for (const t of ['mcp__cohub_goal__cohub_goal_inspect', 'mcp__cohub_goal__cohub_goal_submit', 'mcp__cohub_goal__cohub_goal_wait', 'mcp__cohub_goal__cohub_goal_verify']) {
      assert.ok(allowed.includes(t), `allowedTools must include ${t}`);
    }
    // no secrets in argv
    for (const a of spawnedArgs) {
      assert.ok(!/sk-ant-|Bearer /.test(a), 'no token material in argv');
    }
  });
});
