import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { noLinks, inside } from './files.mjs';

export async function privateDirectory(directory, writerDirectory) {
  if (writerDirectory && inside(writerDirectory, directory)) throw new Error('Credential storage inside writer project');
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw new Error('Noncanonical private directory');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await noLinks(current); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await fs.mkdir(current, { mode: 0o700 }); await noLinks(current);
    }
  }
  await noLinks(directory);
  const s = await fs.lstat(directory);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error('Unsafe private directory');
}
function safe(s) {
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 65536) throw new Error('Unsafe private file');
}
export async function readPrivate(file) {
  await privateDirectory(path.dirname(file));
  await noLinks(file);
  const h = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = await h.stat(); safe(a);
    const b = Buffer.alloc(65537); let n = 0;
    while (n < b.length) { const r = await h.read(b, n, b.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
    const z = await fs.lstat(file); safe(z);
    if (n > 65536 || a.ino !== z.ino || a.dev !== z.dev || a.size !== z.size || a.mtimeMs !== z.mtimeMs) throw new Error('Private file changed');
    return JSON.parse(b.subarray(0, n));
  } finally { await h.close(); }
}
export async function writePrivate(file, value, { exclusive = false } = {}) {
  await privateDirectory(path.dirname(file));
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > 65536) throw new Error('Private storage limit');
  const tmp = path.join(path.dirname(file), `.tmp-${randomBytes(16).toString('hex')}`);
  const h = await fs.open(tmp, 'wx', 0o600);
  try {
    await h.writeFile(data); await h.sync(); await h.close();
    if (exclusive) { await fs.link(tmp, file); await fs.unlink(tmp); }
    else {
      try { await readPrivate(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fs.rename(tmp, file);
    }
    const d = await fs.open(path.dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
  } finally { await h.close().catch(() => {}); await fs.unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function privateLock(directory, fn) {
  await privateDirectory(directory);
  const file = path.join(directory, 'lock'); const h = await fs.open(file, 'wx', 0o600);
  try { await h.sync(); return await fn(); } finally { await h.close(); await fs.unlink(file); }
}
