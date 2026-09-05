import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireNotifierLock,
  buildStatusPointer,
  runNotifierTick,
  validateRemoteStatus,
} from '../src/creator-materials-status-notifier.js';

const NOW = new Date('2026-09-04T20:15:00.000Z'); // 2026-09-05 04:15 +08
const TARGET_SUCCESS = {
  run_id: 'v3-shadow-success-00000001',
  state: 'succeeded',
  watermark_before: '2026-09-03T19:00:00.000Z',
  watermark_after: '2026-09-04T19:00:00.000Z',
  affected_count: 17,
  prepared_count: 7,
  failure_code: null,
  started_at: '2026-09-04T19:03:00.000Z',
  finished_at: '2026-09-04T19:40:00.000Z',
};

function receipt({
  executionId = 'daily_11111111-1111-4111-8111-111111111111',
  state = 'complete',
  stage = state === 'complete' ? 'complete' : 'shadow',
  shadowRunId = state === 'complete' || stage === 'shadow' ? TARGET_SUCCESS.run_id : null,
} = {}) {
  return {
    schemaVersion: 1,
    executionId,
    state,
    stage,
    stages: {
      discovery: 'complete',
      backfill: stage === 'discovery' ? null : 'complete',
      shadow: state === 'complete' ? 'complete' : stage === 'shadow' ? 'failed' : null,
    },
    startedAt: '2026-09-04T19:00:00.000Z',
    finishedAt: '2026-09-04T19:45:00.000Z',
    window: {
      start: '2026-09-04T03:00:00+08:00',
      end: '2026-09-05T03:00:00+08:00',
    },
    discoveryRunId: 'discover_20260905',
    shadowRunId,
    counts: { groups: 23, messages: 500, links: 17 },
    backfill: { totalChats: 23, completedChats: 23, failedChats: 0 },
    shadow: state === 'complete'
      ? { status: 'succeeded', affected: 17, approved: 7, preparedBatchId: 'publication_batch_123' }
      : { status: null, affected: null, approved: null, preparedBatchId: null },
    externalWrites: state === 'complete' || stage === 'shadow' ? 0 : null,
    error: state === 'failed'
      ? { code: 'upstream_step_failed', message: 'context_package_count_mismatch', detail: null }
      : null,
  };
}

function remote(value) {
  const receiptText = `${JSON.stringify(value, null, 2)}\n`;
  const pointer = buildStatusPointer(value, receiptText);
  return {
    pointerText: `${JSON.stringify(pointer, null, 2)}\n`,
    receiptText,
  };
}

async function tempState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'creator-materials-notifier-'));
  return {
    root,
    statePath: path.join(root, 'state.json'),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test('validates the pointer, immutable receipt hash, and target run before notifying success', async () => {
  const storage = await tempState();
  const sent = [];
  try {
    const value = receipt();
    const source = remote(value);
    assert.equal(validateRemoteStatus(source).receipt.executionId, value.executionId);
    const result = await runNotifierTick({
      now: NOW,
      statePath: storage.statePath,
      fetchRemoteStatus: async () => source,
      fetchTargetRun: async () => TARGET_SUCCESS,
      fetchLatestTargetRun: async () => TARGET_SUCCESS,
      sendMessage: async (event) => sent.push(event),
    });
    assert.equal(result.status, 'sent');
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /每日链路成功/);
    assert.match(sent[0].content, /500 条消息，17 个链接/);
    assert.match(sent[0].content, /处理 17 个，通过 7 个/);
    assert.match(sent[0].content, /2026-09-03T19:00:00\.000Z → 2026-09-04T19:00:00\.000Z/);

    const repeated = await runNotifierTick({
      now: NOW,
      statePath: storage.statePath,
      fetchRemoteStatus: async () => source,
      fetchTargetRun: async () => TARGET_SUCCESS,
      fetchLatestTargetRun: async () => TARGET_SUCCESS,
      sendMessage: async (event) => sent.push(event),
    });
    assert.equal(repeated.status, 'noop');
    assert.equal(sent.length, 1);
  } finally {
    await storage.cleanup();
  }
});

test('sends one failure and later sends correlated recovery plus the new success', async () => {
  const storage = await tempState();
  const sent = [];
  try {
    const failedReceipt = receipt({ state: 'failed' });
    const failedTarget = { ...TARGET_SUCCESS, state: 'failed', watermark_after: null, prepared_count: 0, failure_code: 'upstream_step_failed' };
    await runNotifierTick({
      now: NOW,
      statePath: storage.statePath,
      fetchRemoteStatus: async () => remote(failedReceipt),
      fetchTargetRun: async () => failedTarget,
      fetchLatestTargetRun: async () => failedTarget,
      sendMessage: async (event) => sent.push(event),
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /每日链路失败/);
    assert.match(sent[0].content, /shadow/);
    assert.match(sent[0].content, /upstream_step_failed/);
    assert.match(sent[0].content, /后续定时运行会再次尝试/);

    const recovered = receipt({ executionId: 'daily_22222222-2222-4222-8222-222222222222' });
    await runNotifierTick({
      now: new Date('2026-09-04T20:16:00.000Z'),
      statePath: storage.statePath,
      fetchRemoteStatus: async () => remote(recovered),
      fetchTargetRun: async () => TARGET_SUCCESS,
      fetchLatestTargetRun: async () => TARGET_SUCCESS,
      sendMessage: async (event) => sent.push(event),
    });
    assert.equal(sent.length, 3);
    assert.match(sent[1].content, /链路已恢复/);
    assert.match(sent[1].content, new RegExp(failedReceipt.executionId));
    assert.match(sent[1].content, new RegExp(recovered.executionId));
    assert.match(sent[2].content, /每日链路成功/);
  } finally {
    await storage.cleanup();
  }
});

test('after 04:10 a missing current receipt sends one truthful timeout alert with latest target evidence', async () => {
  const storage = await tempState();
  const sent = [];
  const missing = Object.assign(new Error('remote latest missing'), { code: 'remote_status_missing' });
  const latest = { ...TARGET_SUCCESS, state: 'failed', watermark_after: null, failure_code: 'upstream_step_failed' };
  try {
    const dependencies = {
      now: NOW,
      statePath: storage.statePath,
      fetchRemoteStatus: async () => { throw missing; },
      fetchTargetRun: async () => null,
      fetchLatestTargetRun: async () => latest,
      sendMessage: async (event) => sent.push(event),
    };
    const first = await runNotifierTick(dependencies);
    const second = await runNotifierTick(dependencies);
    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'noop');
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /04:10/);
    assert.match(sent[0].content, /终态回执/);
    assert.match(sent[0].content, /upstream_step_failed/);
  } finally {
    await storage.cleanup();
  }
});

test('before the deadline a missing receipt remains an explicit waiting state without sending', async () => {
  const storage = await tempState();
  const sent = [];
  try {
    const result = await runNotifierTick({
      now: new Date('2026-09-04T19:30:00.000Z'), // 03:30 +08
      statePath: storage.statePath,
      fetchRemoteStatus: async () => { throw Object.assign(new Error('missing'), { code: 'remote_status_missing' }); },
      fetchLatestTargetRun: async () => TARGET_SUCCESS,
      sendMessage: async (event) => sent.push(event),
    });
    assert.equal(result.status, 'waiting');
    assert.equal(sent.length, 0);
    await assert.rejects(() => fs.readFile(storage.statePath), /ENOENT/);
  } finally {
    await storage.cleanup();
  }
});

test('a failed Discord send does not commit delivery and is retried on the next tick', async () => {
  const storage = await tempState();
  const source = remote(receipt());
  let attempts = 0;
  try {
    const dependencies = {
      now: NOW,
      statePath: storage.statePath,
      fetchRemoteStatus: async () => source,
      fetchTargetRun: async () => TARGET_SUCCESS,
      fetchLatestTargetRun: async () => TARGET_SUCCESS,
      sendMessage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('discord unavailable');
      },
    };
    await assert.rejects(() => runNotifierTick(dependencies), /discord unavailable/);
    await assert.rejects(() => fs.readFile(storage.statePath), /ENOENT/);
    assert.equal((await runNotifierTick(dependencies)).status, 'sent');
    assert.equal(attempts, 2);
  } finally {
    await storage.cleanup();
  }
});

test('bad JSON, bad hash, binding conflicts, and impossible target success fail closed', async () => {
  const value = receipt();
  const source = remote(value);
  assert.throws(() => validateRemoteStatus({ ...source, pointerText: '{bad' }), /remote_pointer_json_invalid/);
  assert.throws(() => validateRemoteStatus({ ...source, receiptText: `${source.receiptText} ` }), /remote_receipt_hash_mismatch/);
  const other = receipt({ executionId: 'daily_33333333-3333-4333-8333-333333333333' });
  assert.throws(() => validateRemoteStatus({ pointerText: source.pointerText, receiptText: `${JSON.stringify(other, null, 2)}\n` }), /remote_receipt_hash_mismatch|remote_execution_mismatch/);

  const storage = await tempState();
  try {
    await assert.rejects(() => runNotifierTick({
      now: NOW,
      statePath: storage.statePath,
      fetchRemoteStatus: async () => source,
      fetchTargetRun: async () => ({ ...TARGET_SUCCESS, state: 'failed' }),
      fetchLatestTargetRun: async () => TARGET_SUCCESS,
      sendMessage: async () => assert.fail('must not send'),
    }), /target_run_not_successful/);
    await assert.rejects(() => fs.readFile(storage.statePath), /ENOENT/);
  } finally {
    await storage.cleanup();
  }
});

test('an existing unknown lock is never removed or replaced', async () => {
  const storage = await tempState();
  const lockPath = path.join(storage.root, 'notifier.lock');
  try {
    await fs.writeFile(lockPath, '{"owner":"someone-else"}\n', { mode: 0o600 });
    await assert.rejects(() => acquireNotifierLock(lockPath), /notifier_lock_exists/);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"owner":"someone-else"}\n');
  } finally {
    await storage.cleanup();
  }
});

test('receipt pointer hash uses the exact bytes, not reserialized JSON', () => {
  const value = receipt();
  const exact = `${JSON.stringify(value)}\n`;
  const pointer = buildStatusPointer(value, exact);
  assert.equal(pointer.receiptSha256, crypto.createHash('sha256').update(exact).digest('hex'));
});
