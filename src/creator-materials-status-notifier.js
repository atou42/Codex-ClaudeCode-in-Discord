import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,100}$/u;
const HASH_RE = /^[a-f0-9]{64}$/u;
const RECEIPT_STATES = new Set(['complete', 'failed']);
const RECEIPT_STAGES = new Set(['discovery', 'backfill', 'shadow', 'complete']);
const TARGET_TERMINAL_STATES = new Set(['succeeded', 'succeeded_noop', 'failed']);
const DEADLINE_HOUR = 4;
const DEADLINE_MINUTE = 10;
const MAX_DELIVERED_KEYS = 400;

function notifierError(code, detail = null, cause = null) {
  const error = cause instanceof Error ? new Error(code, { cause }) : new Error(code);
  error.code = code;
  error.detail = detail;
  return error;
}

function parseJson(text, code) {
  try {
    const value = JSON.parse(String(text));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch (error) {
    throw notifierError(code, error.message, error);
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validInstant(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw notifierError('remote_receipt_time_invalid', field);
  }
  return Date.parse(value);
}

function validateExecutionId(value, field = 'executionId') {
  if (typeof value !== 'string' || !EXECUTION_ID_RE.test(value)) {
    throw notifierError('remote_execution_id_invalid', field);
  }
}

function expectedReceiptPath(executionId) {
  return `runtime/daily-status/runs/${executionId}.json`;
}

export function buildStatusPointer(receipt, receiptText) {
  validateExecutionId(receipt?.executionId);
  if (!RECEIPT_STATES.has(receipt?.state)) throw notifierError('remote_receipt_state_invalid');
  return {
    schemaVersion: 1,
    executionId: receipt.executionId,
    state: receipt.state,
    receiptPath: expectedReceiptPath(receipt.executionId),
    receiptSha256: hash(receiptText),
  };
}

function validatePointer(pointer) {
  if (pointer.schemaVersion !== 1) throw notifierError('remote_pointer_schema_invalid');
  validateExecutionId(pointer.executionId, 'pointer.executionId');
  if (!RECEIPT_STATES.has(pointer.state)) throw notifierError('remote_pointer_state_invalid');
  if (pointer.receiptPath !== expectedReceiptPath(pointer.executionId)) throw notifierError('remote_pointer_path_invalid');
  if (typeof pointer.receiptSha256 !== 'string' || !HASH_RE.test(pointer.receiptSha256)) throw notifierError('remote_pointer_hash_invalid');
  return pointer;
}

export function receiptPathFromPointerText(pointerText) {
  return validatePointer(parseJson(pointerText, 'remote_pointer_json_invalid')).receiptPath;
}

function validateReceipt(receipt) {
  if (receipt.schemaVersion !== 1) throw notifierError('remote_receipt_schema_invalid');
  validateExecutionId(receipt.executionId);
  if (!RECEIPT_STATES.has(receipt.state)) throw notifierError('remote_receipt_state_invalid');
  if (!RECEIPT_STAGES.has(receipt.stage)) throw notifierError('remote_receipt_stage_invalid');
  const startedAt = validInstant(receipt.startedAt, 'startedAt');
  const finishedAt = validInstant(receipt.finishedAt, 'finishedAt');
  if (finishedAt < startedAt) throw notifierError('remote_receipt_time_order_invalid');
  if (!receipt.window || typeof receipt.window !== 'object') throw notifierError('remote_receipt_window_invalid');
  validInstant(receipt.window.start, 'window.start');
  validInstant(receipt.window.end, 'window.end');
  if (!receipt.stages || typeof receipt.stages !== 'object') throw notifierError('remote_receipt_stages_invalid');
  if (!receipt.counts || typeof receipt.counts !== 'object') throw notifierError('remote_receipt_counts_invalid');
  if (!receipt.backfill || typeof receipt.backfill !== 'object') throw notifierError('remote_receipt_backfill_invalid');
  if (!receipt.shadow || typeof receipt.shadow !== 'object') throw notifierError('remote_receipt_shadow_invalid');
  if (![null, 0].includes(receipt.externalWrites)) throw notifierError('remote_receipt_external_writes_invalid');
  if (receipt.state === 'complete') {
    if (receipt.stage !== 'complete' || receipt.error !== null) throw notifierError('remote_receipt_complete_contract_invalid');
    for (const stage of ['discovery', 'backfill', 'shadow']) {
      if (receipt.stages[stage] !== 'complete') throw notifierError('remote_receipt_complete_stage_invalid', stage);
    }
    if (receipt.externalWrites !== 0) throw notifierError('remote_receipt_complete_external_writes_invalid');
  } else {
    if (!receipt.error || typeof receipt.error !== 'object') throw notifierError('remote_receipt_failure_error_missing');
    if (typeof receipt.error.code !== 'string' || !receipt.error.code) throw notifierError('remote_receipt_failure_code_missing');
    if (receipt.stages[receipt.stage] !== 'failed') throw notifierError('remote_receipt_failure_stage_invalid');
  }
}

export function validateRemoteStatus({ pointerText, receiptText }) {
  const pointer = validatePointer(parseJson(pointerText, 'remote_pointer_json_invalid'));
  if (hash(receiptText) !== pointer.receiptSha256) throw notifierError('remote_receipt_hash_mismatch');
  const receipt = parseJson(receiptText, 'remote_receipt_json_invalid');
  validateReceipt(receipt);
  if (receipt.executionId !== pointer.executionId) throw notifierError('remote_execution_mismatch');
  if (receipt.state !== pointer.state) throw notifierError('remote_state_mismatch');
  return { pointer, receipt };
}

function shanghaiParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw notifierError('notifier_clock_invalid');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function shanghaiDate(value) {
  const parts = shanghaiParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isPastDeadline(value) {
  const parts = shanghaiParts(value);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= DEADLINE_HOUR * 60 + DEADLINE_MINUTE;
}

function display(value, absent = '未进入') {
  return value === null || value === undefined || value === '' ? absent : String(value);
}

function validateTargetRun(target, receipt) {
  if (!receipt.shadowRunId) {
    if (receipt.state === 'complete') throw notifierError('target_run_id_missing');
    return null;
  }
  if (!target) {
    if (receipt.state === 'complete') throw notifierError('target_run_missing');
    return null;
  }
  if (target.run_id !== receipt.shadowRunId) throw notifierError('target_run_binding_invalid');
  if (!TARGET_TERMINAL_STATES.has(target.state)) throw notifierError('target_run_not_terminal');
  if (receipt.state === 'complete' && !['succeeded', 'succeeded_noop'].includes(target.state)) {
    throw notifierError('target_run_not_successful');
  }
  if (receipt.state === 'complete' && !target.watermark_after) throw notifierError('target_run_watermark_missing');
  return target;
}

function buildNonce(key) {
  return `cm${hash(key).slice(0, 23)}`;
}

function commonLinks() {
  return 'Collector https://cohub.run/spaces/a3d5c4b2-8594-4b12-8365-5ae774835328\n材料库 https://cohub.run/spaces/26f63f56-476a-486c-9775-cc25447d4046';
}

function successEvent(receipt, target) {
  const key = `success:${receipt.executionId}`;
  const content = [
    'Creator Materials 每日链路成功',
    `运行 ${receipt.executionId}`,
    `完成 ${receipt.finishedAt}`,
    `采集 ${display(receipt.counts.messages)} 条消息，${display(receipt.counts.links)} 个链接，${display(receipt.counts.groups)} 个群`,
    `处理 ${display(target?.affected_count ?? receipt.shadow.affected)} 个，通过 ${display(target?.prepared_count ?? receipt.shadow.approved)} 个，预备批次 ${display(receipt.shadow.preparedBatchId)}`,
    `水位 ${display(target?.watermark_before, '未知')} → ${display(target?.watermark_after, '未知')}`,
    commonLinks(),
  ].join('\n');
  return { key, type: 'success', executionId: receipt.executionId, content, nonce: buildNonce(key) };
}

function failureEvent(receipt, target) {
  const key = `failure:${receipt.executionId}`;
  const error = receipt.error;
  const targetFailure = target?.failure_code && target.failure_code !== error.code ? `；目标 ${target.failure_code}` : '';
  const content = [
    'Creator Materials 每日链路失败',
    `运行 ${receipt.executionId}`,
    `完成 ${receipt.finishedAt}`,
    `失败节点 ${receipt.stage}`,
    `原因 ${error.code}${error.message ? ` · ${error.message}` : ''}${targetFailure}`,
    `采集 ${display(receipt.counts.messages)} 条消息，${display(receipt.counts.links)} 个链接；回补 ${display(receipt.backfill.completedChats)}/${display(receipt.backfill.totalChats)}，失败 ${display(receipt.backfill.failedChats)}`,
    `处理 ${display(target?.affected_count ?? receipt.shadow.affected)} 个，通过 ${display(target?.prepared_count ?? receipt.shadow.approved)} 个`,
    `水位 ${display(target?.watermark_before, '未知')} → ${display(target?.watermark_after, '未推进')}`,
    '重试 后续定时运行会再次尝试',
    commonLinks(),
  ].join('\n');
  return { key, type: 'failure', executionId: receipt.executionId, content, nonce: buildNonce(key) };
}

function timeoutEvent(date, latestTarget, readError) {
  const executionId = `missing-${date}`;
  const key = `timeout:${date}`;
  const content = [
    'Creator Materials 每日链路超时',
    `日期 ${date}`,
    '04:10 后仍没有当天终态回执，不能把 Cohub cron 的 completed 当作业务成功。',
    `状态读取 ${display(readError?.code, 'remote_status_missing')}`,
    `最近目标运行 ${display(latestTarget?.run_id, '缺失')} · ${display(latestTarget?.state, '未知')} · ${display(latestTarget?.failure_code, '无明确失败码')}`,
    `水位 ${display(latestTarget?.watermark_before, '未知')} → ${display(latestTarget?.watermark_after, '未推进')}`,
    '重试 本机通知器会继续轮询，下一份成功回执会触发恢复通知',
    commonLinks(),
  ].join('\n');
  return { key, type: 'timeout', executionId, content, nonce: buildNonce(key) };
}

function recoveryEvent(activeFailure, receipt) {
  const key = `recovery:${activeFailure.executionId}:${receipt.executionId}`;
  const content = [
    'Creator Materials 链路已恢复',
    `原失败 ${activeFailure.executionId}`,
    `恢复运行 ${receipt.executionId}`,
    `完成 ${receipt.finishedAt}`,
    commonLinks(),
  ].join('\n');
  return { key, type: 'recovery', executionId: receipt.executionId, recoveredExecutionId: activeFailure.executionId, content, nonce: buildNonce(key) };
}

function emptyState() {
  return { schemaVersion: 1, deliveredKeys: [], activeFailure: null, updatedAt: null };
}

async function loadState(statePath, fsImpl) {
  let text;
  try {
    text = await fsImpl.readFile(statePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw notifierError('notifier_state_read_failed', null, error);
  }
  const state = parseJson(text, 'notifier_state_json_invalid');
  if (state.schemaVersion !== 1 || !Array.isArray(state.deliveredKeys)) throw notifierError('notifier_state_invalid');
  if (state.deliveredKeys.some((key) => typeof key !== 'string')) throw notifierError('notifier_state_invalid');
  if (state.activeFailure !== null && (
    typeof state.activeFailure !== 'object'
    || typeof state.activeFailure.executionId !== 'string'
    || typeof state.activeFailure.key !== 'string'
  )) throw notifierError('notifier_state_invalid');
  return state;
}

async function saveState(statePath, state, fsImpl) {
  await fsImpl.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fsImpl.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fsImpl.rename(temporaryPath, statePath);
  } catch (error) {
    try { await fsImpl.unlink(temporaryPath); } catch {}
    throw notifierError('notifier_state_write_failed', null, error);
  }
}

function applyDeliveredEvent(state, event, now) {
  const deliveredKeys = [...state.deliveredKeys, event.key].slice(-MAX_DELIVERED_KEYS);
  let activeFailure = state.activeFailure;
  if (event.type === 'failure' || event.type === 'timeout') activeFailure = { executionId: event.executionId, key: event.key };
  if (event.type === 'recovery' && activeFailure?.executionId === event.recoveredExecutionId) activeFailure = null;
  return { schemaVersion: 1, deliveredKeys, activeFailure, updatedAt: now.toISOString() };
}

function eventsForReceipt(receipt, target, state) {
  if (receipt.state === 'failed') return [failureEvent(receipt, target)];
  const events = [];
  if (state.activeFailure) events.push(recoveryEvent(state.activeFailure, receipt));
  events.push(successEvent(receipt, target));
  return events;
}

export async function runNotifierTick({
  now = new Date(),
  statePath,
  fetchRemoteStatus,
  fetchTargetRun,
  fetchLatestTargetRun,
  sendMessage,
  fsImpl = fs,
  dryRun = false,
} = {}) {
  if (!statePath || typeof fetchRemoteStatus !== 'function' || typeof sendMessage !== 'function') {
    throw notifierError('notifier_dependencies_invalid');
  }
  const clock = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(clock.getTime())) throw notifierError('notifier_clock_invalid');
  const state = await loadState(statePath, fsImpl);
  let events;
  try {
    const source = await fetchRemoteStatus();
    const { receipt } = validateRemoteStatus(source);
    const receiptDate = shanghaiDate(receipt.startedAt);
    const currentDate = shanghaiDate(clock);
    if (receiptDate > currentDate) throw notifierError('remote_receipt_from_future');
    if (receiptDate < currentDate) {
      if (!isPastDeadline(clock)) return { status: 'waiting', events: [] };
      const latestTarget = typeof fetchLatestTargetRun === 'function' ? await fetchLatestTargetRun() : null;
      events = [timeoutEvent(currentDate, latestTarget, { code: 'current_receipt_missing' })];
    } else {
      if (Date.parse(receipt.finishedAt) > clock.getTime()) throw notifierError('remote_receipt_finished_in_future');
      const target = receipt.shadowRunId && typeof fetchTargetRun === 'function'
        ? await fetchTargetRun(receipt.shadowRunId)
        : null;
      validateTargetRun(target, receipt);
      events = eventsForReceipt(receipt, target, state);
    }
  } catch (error) {
    if (error.code !== 'remote_status_missing') throw error;
    if (!isPastDeadline(clock)) return { status: 'waiting', events: [] };
    const latestTarget = typeof fetchLatestTargetRun === 'function' ? await fetchLatestTargetRun() : null;
    events = [timeoutEvent(shanghaiDate(clock), latestTarget, error)];
  }

  const pending = events.filter((event) => !state.deliveredKeys.includes(event.key));
  if (!pending.length) return { status: 'noop', events: [] };
  if (dryRun) return { status: 'dry_run', events: pending };

  let nextState = state;
  for (const event of pending) {
    if (event.content.length > 2000) throw notifierError('notifier_message_too_long', event.key);
    await sendMessage(event);
    nextState = applyDeliveredEvent(nextState, event, clock);
    await saveState(statePath, nextState, fsImpl);
  }
  return { status: 'sent', events: pending };
}

export async function acquireNotifierLock(lockPath, { fsImpl = fs, pid = process.pid, now = new Date() } = {}) {
  await fsImpl.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fsImpl.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw notifierError('notifier_lock_exists', lockPath);
    throw error;
  }
  const owner = { schemaVersion: 1, pid, createdAt: new Date(now).toISOString() };
  await handle.writeFile(`${JSON.stringify(owner)}\n`);
  await handle.close();
  return owner;
}

export async function releaseNotifierLock(lockPath, owner, { fsImpl = fs } = {}) {
  const current = parseJson(await fsImpl.readFile(lockPath, 'utf8'), 'notifier_lock_invalid');
  if (current.pid !== owner.pid || current.createdAt !== owner.createdAt) throw notifierError('notifier_lock_ownership_invalid');
  await fsImpl.unlink(lockPath);
}
