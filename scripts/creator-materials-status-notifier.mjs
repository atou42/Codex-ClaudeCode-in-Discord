#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  acquireNotifierLock,
  receiptPathFromPointerText,
  releaseNotifierLock,
  runNotifierTick,
} from '../src/creator-materials-status-notifier.js';

const execFile = promisify(execFileCallback);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const COLLECTOR_SPACE_ID = 'a3d5c4b2-8594-4b12-8365-5ae774835328';
const MATERIALS_SPACE_ID = '26f63f56-476a-486c-9775-cc25447d4046';
const DISCORD_THREAD_ID = '1542491214471766016';
const STATE_PATH = path.join(ROOT, 'data', 'creator-materials-status-notifier.json');
const LOCK_PATH = path.join(ROOT, 'data', 'creator-materials-status-notifier.lock');
const SEND_SCRIPT = path.join(ROOT, 'scripts', 'send-channel-message.mjs');
const LATEST_PATH = 'runtime/daily-status/latest.json';
const COMMAND_TIMEOUT_MS = 90_000;

function cliError(code, detail = null, cause = null) {
  const error = cause instanceof Error ? new Error(code, { cause }) : new Error(code);
  error.code = code;
  error.detail = detail;
  return error;
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true;
    else throw cliError('argument_unknown', argument);
  }
  return options;
}

async function command(command, args) {
  try {
    return await execFile(command, args, {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw cliError('command_failed', {
      command: path.basename(command),
      code: error.code ?? null,
      signal: error.signal ?? null,
      stderr: String(error.stderr ?? '').slice(0, 2000),
      stdout: String(error.stdout ?? '').slice(0, 2000),
    }, error);
  }
}

async function readSpaceFile(spaceId, filePath) {
  try {
    return (await command('cohub', ['-s', spaceId, 'spaces', 'files', 'cat', filePath])).stdout;
  } catch (error) {
    const evidence = `${error.detail?.stderr ?? ''}\n${error.detail?.stdout ?? ''}`;
    if (/not found|enoent|does not exist|404/iu.test(evidence)) {
      throw cliError('remote_status_missing', { spaceId, filePath }, error);
    }
    throw cliError('remote_status_read_failed', { spaceId, filePath, command: error.detail }, error);
  }
}

async function fetchRemoteStatus() {
  const pointerText = await readSpaceFile(COLLECTOR_SPACE_ID, LATEST_PATH);
  const receiptPath = receiptPathFromPointerText(pointerText);
  const receiptText = await readSpaceFile(COLLECTOR_SPACE_ID, receiptPath);
  return { pointerText, receiptText };
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  throw cliError('target_query_json_missing');
}

const TARGET_QUERY = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("v3/db/creator-materials.sqlite",{readOnly:true});const id=process.argv[1];const row=db.prepare("SELECT run_id,state,watermark_before,watermark_after,affected_count,prepared_count,failure_code,started_at,finished_at FROM shadow_pipeline_runs WHERE run_id=?").get(id)??null;db.close();process.stdout.write(JSON.stringify(row)+"\\n")`;
const LATEST_TARGET_QUERY = `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("v3/db/creator-materials.sqlite",{readOnly:true});const row=db.prepare("SELECT run_id,state,watermark_before,watermark_after,affected_count,prepared_count,failure_code,started_at,finished_at FROM shadow_pipeline_runs ORDER BY started_at DESC LIMIT 1").get()??null;db.close();process.stdout.write(JSON.stringify(row)+"\\n")`;

async function runTargetQuery(script, argument = null) {
  const args = ['-s', MATERIALS_SPACE_ID, 'run', '--', 'node', '-e', script];
  if (argument !== null) args.push(argument);
  const result = await command('cohub', args);
  return parseLastJsonLine(result.stdout);
}

async function fetchTargetRun(runId) {
  return runTargetQuery(TARGET_QUERY, runId);
}

async function fetchLatestTargetRun() {
  return runTargetQuery(LATEST_TARGET_QUERY);
}

async function sendDiscord(event) {
  const result = await command(process.execPath, [
    SEND_SCRIPT,
    '--channel', DISCORD_THREAD_ID,
    '--content', event.content,
    '--provider', 'codex',
    '--nonce', event.nonce,
    '--json',
  ]);
  const response = JSON.parse(result.stdout);
  if (response.channelId !== DISCORD_THREAD_ID || typeof response.messageId !== 'string' || !response.messageId) {
    throw cliError('discord_send_receipt_invalid', response);
  }
  return response;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const owner = await acquireNotifierLock(LOCK_PATH);
  try {
    const result = await runNotifierTick({
      now: new Date(),
      statePath: STATE_PATH,
      fetchRemoteStatus,
      fetchTargetRun,
      fetchLatestTargetRun,
      sendMessage: sendDiscord,
      dryRun: options.dryRun,
    });
    await releaseNotifierLock(LOCK_PATH, owner);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    try {
      await releaseNotifierLock(LOCK_PATH, owner);
    } catch (lockError) {
      error.lockReleaseError = { code: lockError.code ?? null, message: lockError.message };
    }
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'system_error',
    code: error.code ?? null,
    message: error.message,
    detail: error.detail ?? null,
    lockReleaseError: error.lockReleaseError ?? null,
  })}\n`);
  process.exitCode = 1;
});
