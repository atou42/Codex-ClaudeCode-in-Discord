import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLaunchctlInvocation,
  extractProtectedServiceLabels,
  getSafeRestartScriptPath,
} from '../src/launchctl-guard.js';

test('extractProtectedServiceLabels matches service refs and plist paths', () => {
  const labels = extractProtectedServiceLabels([
    'gui/501/com.atou.agents-in-discord',
    '/Users/atou/Library/LaunchAgents/com.atou.agents-in-discord.claude.plist',
    'com.atou.agents-in-discord.gemini',
  ]);

  assert.deepEqual(labels, [
    'com.atou.agents-in-discord',
    'com.atou.agents-in-discord.claude',
    'com.atou.agents-in-discord.gemini',
  ]);
});

test('classifyLaunchctlInvocation rewrites protected bootout to a safe restart', () => {
  const decision = classifyLaunchctlInvocation([
    'bootout',
    'gui/501/com.atou.agents-in-discord',
  ]);

  assert.equal(decision.action, 'rewrite-safe-restart');
  assert.equal(decision.targetLabel, 'com.atou.agents-in-discord');
});

test('classifyLaunchctlInvocation blocks protected disable operations', () => {
  const decision = classifyLaunchctlInvocation([
    'disable',
    'gui/501/com.atou.agents-in-discord.claude',
  ]);

  assert.equal(decision.action, 'block');
  assert.match(decision.reason, /protected bot service/i);
});

test('classifyLaunchctlInvocation leaves unrelated services untouched', () => {
  const decision = classifyLaunchctlInvocation([
    'bootout',
    'gui/501/com.example.other-service',
  ]);

  assert.equal(decision.action, 'passthrough');
});

test('safe restart helper path points into scripts directory', () => {
  assert.match(getSafeRestartScriptPath(), /scripts\/restart-discord-bot-service\.sh$/);
});
