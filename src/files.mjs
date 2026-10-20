import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Enrollment uses canonical paths. Reads reject symlinks in every component,
// then verify the opened inode and path again. Local hostile rename races are
// outside the threat model (Node has no portable openat traversal).
export async function noLinks(file) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file) throw new Error('Noncanonical path');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink denied');
  }
  if (await fs.realpath(file) !== file) throw new Error('Noncanonical path');
  return file;
}

export async function boundedRead(file, max = 1024 * 1024) {
  await noLinks(file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > max) throw new Error('File type or size denied');
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    await noLinks(file);
    const after = await fs.stat(file);
    if (length > max || before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('File changed during read');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function validateBinding(input) {
  const binding = structuredClone(input);
  for (const key of ['draft', 'sessionDirectory']) await noLinks(binding[key]);
  if (!(await fs.stat(binding.sessionDirectory)).isDirectory()) throw new Error('Invalid session directory');
  if (!inside(binding.sessionDirectory, binding.draft)) throw new Error('Draft outside editing project');
  await boundedRead(binding.draft);
  if (!Array.isArray(binding.assetRoots) || binding.assetRoots.length > 16) throw new Error('Asset roots required');
  for (const root of binding.assetRoots) {
    await noLinks(root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Invalid asset root');
  }
  if (binding.siteAssetRoot && !binding.assetRoots.includes(binding.siteAssetRoot)) throw new Error('Register site asset root');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(binding.sessionId) || typeof binding.upstreamIdentity !== 'string' || !binding.upstreamIdentity.trim()) throw new Error('Explicit upstream binding required');
  return binding;
}

export function assetPath(source, binding) {
  if (typeof source !== 'string' || source.length > 4096 || /[\\\x00-\x20?#]/.test(source)) throw new Error('Invalid asset path');
  const decoded = decodeURIComponent(source);
  if (/[\\\x00-\x20?#]/.test(decoded) || decoded.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) throw new Error('External assets denied');
  if (decoded.split('/').includes('..')) throw new Error('Traversal denied');
  const file = decoded.startsWith('/assets/') && binding.siteAssetRoot
    ? path.resolve(binding.siteAssetRoot, decoded.slice('/assets/'.length))
    : path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(path.dirname(binding.draft), decoded);
  if (!binding.assetRoots.some(root => inside(root, file))) throw new Error('Asset outside roots');
  return file;
}

export async function readImage(file) {
  const data = await boundedRead(file, 5 * 1024 * 1024);
  let type;
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) type = 'image/png';
  else if (data[0] === 255 && data[1] === 216 && data[2] === 255) type = 'image/jpeg';
  else if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) type = 'image/gif';
  else if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') type = 'image/webp';
  if (!type) throw new Error('Only raster images accepted');
  return { data, type };
}
