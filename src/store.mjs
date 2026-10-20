import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { noLinks, boundedRead } from './files.mjs';
import { hash } from './renderer.mjs';

export async function openStore(directory, initial) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await noLinks(directory);
  const st = await fs.stat(directory);
  if ((st.mode & 0o077) || st.uid !== process.getuid()) throw new Error('State directory must be owned by this user and mode 0700');
  const lock = path.join(directory, 'lock');
  const lockHandle = await fs.open(lock, 'wx', 0o600); // Fail closed, including stale lock.
  const filename = path.join(directory, 'state.json');
  let state, tail = Promise.resolve();
  async function persist() {
    const tmp = path.join(directory, `state-${randomBytes(12).toString('hex')}.tmp`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, filename);
    const dir = await fs.open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  try {
    try {
      const stat = await fs.lstat(filename);
      if ((stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Unsafe state permissions');
      state = JSON.parse((await boundedRead(filename, 16 * 1024 * 1024)).toString());
      if (initial) throw new Error('Already enrolled');
    } catch (error) {
      if (error.code !== 'ENOENT' || !initial) throw error;
      state = { version: 1, binding: initial, capabilities: [], comments: [], observations: [] };
    }
    for (const comment of state.comments) if (comment.status === 'sending') comment.status = 'uncertain';
    state.notes ||= []; state.batches ||= [];
    for (const batch of state.batches) if (batch.status === 'sending') {
      batch.status = 'uncertain';
      for (const member of batch.members) {
        const note = state.notes.find(n => n.id === member.id);
        if (note?.batchId === batch.id) note.status = 'uncertain';
      }
    }
    await persist();
    return {
      get state() { return state; },
      transaction(fn) {
        const task = tail.then(async () => { const result = await fn(state, persist); await persist(); return result; });
        tail = task.catch(() => {}); return task;
      },
      async issue(ttl = 3600000) {
        if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400000) throw new Error('Capability TTL must be at most 24 hours');
        const token = randomBytes(32).toString('base64url');
        await this.transaction(s => { s.capabilities.push({ digest: hash(token), expires: Date.now() + ttl, revoked: false }); s.capabilities = s.capabilities.slice(-256); });
        return token;
      },
      authorized(token) {
        if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return false;
        return state.capabilities.some(c => c.digest === hash(token) && !c.revoked && c.expires > Date.now());
      },
      async close() { await tail; await lockHandle.close(); await fs.unlink(lock); },
    };
  } catch (error) { await lockHandle.close(); await fs.unlink(lock); throw error; }
}
