#!/usr/bin/env node

import {execSync} from 'node:child_process';

// Enforce small, focused commits by default.
// Bypass explicitly when needed:
//   ALLOW_LARGE_CHANGE=1 git commit ...

if (process.env.ALLOW_LARGE_CHANGE === '1') {
  process.exit(0);
}

const maxFiles = Number.parseInt(process.env.ATOMIC_MAX_FILES ?? '8', 10);
const maxLines = Number.parseInt(process.env.ATOMIC_MAX_CHANGED_LINES ?? '300', 10);
const stagedOnly = process.argv.includes('--staged');

if (!Number.isFinite(maxFiles) || maxFiles < 0) {
  console.error('[atomic-check] Invalid ATOMIC_MAX_FILES. Expected a non-negative integer.');
  process.exit(2);
}

if (!Number.isFinite(maxLines) || maxLines < 0) {
  console.error('[atomic-check] Invalid ATOMIC_MAX_CHANGED_LINES. Expected a non-negative integer.');
  process.exit(2);
}

const gitBaseArgs = stagedOnly ? ['diff', '--cached'] : ['diff'];

function gitOutput(args) {
  try {
    return execSync(`git ${args.join(' ')}`, {encoding: 'utf8'}).trim();
  } catch {
    console.error('[atomic-check] Failed to read git diff. Are you inside a git repository?');
    process.exit(2);
  }
}

const nameOnly = gitOutput([...gitBaseArgs, '--name-only']);
const shortStat = gitOutput([...gitBaseArgs, '--shortstat']);

const fileCount = nameOnly === '' ? 0 : nameOnly.split('\n').filter(Boolean).length;
const changedLinesMatch = shortStat.match(/(\d+)\s+insertions?\(\+\)/);
const deletedLinesMatch = shortStat.match(/(\d+)\s+deletions?\(-\)/);
const addedLines = changedLinesMatch ? Number.parseInt(changedLinesMatch[1], 10) : 0;
const deletedLines = deletedLinesMatch ? Number.parseInt(deletedLinesMatch[1], 10) : 0;
const changedLines = addedLines + deletedLines;

if (fileCount > maxFiles || changedLines > maxLines) {
  console.error(`[atomic-check] Commit looks large: ${fileCount} files, ${changedLines} changed lines.`);
  console.error(`[atomic-check] Limits: ${maxFiles} files, ${maxLines} changed lines.`);
  console.error('[atomic-check] Split into smaller commits, or bypass intentionally with:');
  console.error('[atomic-check]   ALLOW_LARGE_CHANGE=1 git commit ...');
  process.exit(1);
}

process.exit(0);
