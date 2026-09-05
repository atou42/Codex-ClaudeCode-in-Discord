import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function stageGrokPromptFile({
  prompt,
  inputImages = [],
  mkdtempFn = mkdtemp,
  writeFileFn = writeFile,
  rmFn = rm,
  tmpdir = os.tmpdir(),
} = {}) {
  const attachments = inputImages
    .map((imagePath) => String(imagePath || '').trim())
    .filter(Boolean)
    .map((imagePath) => `@${imagePath}`);
  const promptText = [String(prompt || ''), ...attachments].filter(Boolean).join('\n');
  const dir = await mkdtempFn(path.join(tmpdir, 'agents-in-discord-grok-prompt-'));
  const promptFile = path.join(dir, 'prompt.txt');

  try {
    await writeFileFn(promptFile, promptText, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await rmFn(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: promptFile,
    cleanup: () => rmFn(dir, { recursive: true, force: true }),
  };
}
