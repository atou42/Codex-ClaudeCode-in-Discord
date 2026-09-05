import { parseVersion } from './agent-upgrade-report.js';

const GROK_BOT_DOWNLOAD_HOST = 'downloads.cursor.com';

export function parseGrokBotCaskPayload(payload) {
  const casks = Array.isArray(payload?.casks) ? payload.casks : [];
  const cask = casks.find((entry) => entry?.token === 'grok-bot');
  if (!cask) throw new Error('Homebrew did not return the grok-bot cask');

  const rawVersion = String(cask.version || '').trim();
  const version = parseVersion(rawVersion);
  if (!version || rawVersion !== version || !/^\d+(?:\.\d+){2}$/.test(version)) {
    throw new Error('grok-bot cask did not expose a stable version');
  }

  const sha256 = String(cask.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('grok-bot cask did not expose a valid SHA-256 checksum');
  }

  let url;
  try {
    url = new URL(String(cask.url || '').trim());
  } catch {
    throw new Error('grok-bot cask did not expose a valid download URL');
  }
  const expectedPath = `/sand/stable/darwin-arm64/${version}/Grok_Bot_${version}.dmg`;
  if (url.protocol !== 'https:' || url.hostname !== GROK_BOT_DOWNLOAD_HOST || url.pathname !== expectedPath) {
    throw new Error('grok-bot cask download URL was not the expected official stable artifact');
  }

  return { version, sha256, url: url.toString() };
}

export function parseHdiutilMountPoint(payload) {
  const entities = Array.isArray(payload?.['system-entities']) ? payload['system-entities'] : [];
  const mountPoint = entities
    .map((entry) => String(entry?.['mount-point'] || '').trim())
    .find(Boolean);
  if (!mountPoint || !mountPoint.startsWith('/Volumes/')) {
    throw new Error('disk image did not expose a mounted volume');
  }
  return mountPoint;
}
