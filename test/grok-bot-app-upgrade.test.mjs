import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseGrokBotCaskPayload,
  parseHdiutilMountPoint,
} from '../src/grok-bot-app-upgrade.js';

const checksum = 'a'.repeat(64);

test('parseGrokBotCaskPayload accepts the official stable artifact', () => {
  assert.deepEqual(parseGrokBotCaskPayload({
    casks: [{
      token: 'grok-bot',
      version: '0.31.0',
      sha256: checksum,
      url: 'https://downloads.cursor.com/sand/stable/darwin-arm64/0.31.0/Grok_Bot_0.31.0.dmg',
    }],
  }), {
    version: '0.31.0',
    sha256: checksum,
    url: 'https://downloads.cursor.com/sand/stable/darwin-arm64/0.31.0/Grok_Bot_0.31.0.dmg',
  });
});

test('parseGrokBotCaskPayload rejects non-official and non-stable artifacts', () => {
  assert.throws(() => parseGrokBotCaskPayload({
    casks: [{
      token: 'grok-bot',
      version: '0.31.0-beta.1',
      sha256: checksum,
      url: 'https://downloads.cursor.com/sand/beta/darwin-arm64/0.31.0-beta.1/Grok_Bot_0.31.0-beta.1.dmg',
    }],
  }), /stable version/);
  assert.throws(() => parseGrokBotCaskPayload({
    casks: [{
      token: 'grok-bot',
      version: '0.31.0',
      sha256: checksum,
      url: 'https://example.com/Grok_Bot_0.31.0.dmg',
    }],
  }), /official stable artifact/);
});

test('parseHdiutilMountPoint accepts only mounted volumes', () => {
  assert.equal(parseHdiutilMountPoint({
    'system-entities': [{ 'mount-point': '/Volumes/Grok Bot' }],
  }), '/Volumes/Grok Bot');
  assert.throws(() => parseHdiutilMountPoint({
    'system-entities': [{ 'mount-point': '/tmp/Grok Bot' }],
  }), /mounted volume/);
});
