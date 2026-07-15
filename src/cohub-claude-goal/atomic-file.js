import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export class AtomicFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AtomicFileError';
  }
}

function tempNameFor(destPath) {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  return path.join(dir, `.${base}.tmp-${unique}`);
}

async function noop() {}

/**
 * Writes data to destPath via same-directory temp file + exclusive create +
 * full write + fsync(file) + atomic commit + fsync(dir). crashHook(point) is
 * invoked at each named point below for adversarial crash testing; if it
 * throws, execution stops there leaving on-disk state exactly as it was after
 * the last completed step.
 *
 * When allowReplace is false (the default), the commit itself is atomic and
 * clobber-proof: it hard-links the temp file onto destPath (fs.link fails
 * with EEXIST if destPath already exists — checked and created by the
 * kernel as one operation) and then unlinks the temp name. This closes the
 * TOCTOU window an existsSync-then-rename approach would have, since
 * rename() unconditionally replaces an existing destination on POSIX. When
 * allowReplace is true, the commit uses atomic rename (replace semantics).
 *
 * Points, in order: before-open, after-open, after-write, after-fsync-file,
 * after-close, before-rename, after-rename, after-fsync-dir.
 */
export async function writeFileAtomic(destPath, data, options = {}) {
  const { mode = 0o600, allowReplace = false, crashHook = noop } = options;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const dir = path.dirname(destPath);

  if (!allowReplace && fs.existsSync(destPath)) {
    throw new AtomicFileError(`writeFileAtomic: destination already exists and allowReplace is false: ${destPath}`);
  }

  const tempPath = tempNameFor(destPath);

  await crashHook('before-open');

  let fd;
  try {
    fd = await fsPromises.open(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  } catch (err) {
    throw new AtomicFileError(`writeFileAtomic: failed to create temp file ${tempPath}: ${err.message}`);
  }

  try {
    await crashHook('after-open');
    await fd.writeFile(buffer);
    await crashHook('after-write');
    await fd.sync();
    await crashHook('after-fsync-file');
  } finally {
    await fd.close();
  }
  await crashHook('after-close');

  await crashHook('before-rename');
  if (allowReplace) {
    await fsPromises.rename(tempPath, destPath);
  } else {
    try {
      await fsPromises.link(tempPath, destPath);
    } catch (err) {
      // Pre-commit failure: leave the temp file exactly as-is (do not
      // unlink it) so its bytes remain available for forensics/recovery.
      if (err.code === 'EEXIST') {
        throw new AtomicFileError(
          `writeFileAtomic: destination already exists and allowReplace is false: ${destPath}`,
        );
      }
      throw new AtomicFileError(`writeFileAtomic: failed to commit ${tempPath} -> ${destPath}: ${err.message}`);
    }
    await fsPromises.unlink(tempPath);
  }
  await crashHook('after-rename');

  const dirFd = await fsPromises.open(dir, fs.constants.O_RDONLY);
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
  await crashHook('after-fsync-dir');
}
