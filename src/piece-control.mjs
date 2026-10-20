import net from 'node:net';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { privateDirectory, writePrivate } from './private.mjs';

// Operator-local control only. Never registered as a browser route or model tool.
export async function openPieceControl({ directory, manager }) {
  await privateDirectory(directory);
  const socket = path.join(directory, 'new.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('Short private control path required');
  const lock = await fs.open(path.join(directory, 'control.lock'), 'wx', 0o600);
  const token = randomBytes(32).toString('hex'), epoch = randomBytes(32).toString('hex');
  const clients = new Set(), requests = new Set();
  const server = net.createServer({ allowHalfOpen: true }, s => {
    if (clients.size >= 8) { s.destroy(); return; }
    clients.add(s); s.on('close', () => clients.delete(s)); s.on('error', () => {});
    s.setTimeout(60000, () => s.destroy()); let size = 0; const chunks = [];
    s.on('data', chunk => { size += chunk.length; if (size > 32768) s.destroy(); else chunks.push(chunk); });
    s.on('end', () => {
      const task = (async () => {
        try {
          if (size > 32768) throw new Error('Limit');
          const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (typeof r.token !== 'string' || r.token.length !== token.length || !timingSafeEqual(Buffer.from(r.token), Buffer.from(token)) || r.epoch !== epoch) throw new Error('Denied');
          if (Object.keys(r).some(k => !['token', 'epoch', 'op', 'input', 'id'].includes(k))) throw new Error('Unexpected control field');
          let value;
          if (r.op === 'new' && r.input && Object.keys(r.input).every(k => ['title', 'format', 'id', 'sources', 'learnMemory'].includes(k))) value = await manager.newPiece(r.input);
          else if (r.op === 'resume' && typeof r.id === 'string') value = await manager.resume(r.id);
          else if (r.op === 'resumeAllocated' && typeof r.id === 'string' && r.input) value = await manager.resumeAllocated(r.id, r.input);
          else throw new Error('Unknown operation');
          s.end(JSON.stringify({ ok: true, value }));
        } catch { s.end('{"ok":false}'); }
      })();
      requests.add(task); void task.finally(() => requests.delete(task));
    });
  });
  try {
    // No stale socket/lock cleanup: uncertain ownership needs local reconciliation.
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    await fs.chmod(socket, 0o600);
    await writePrivate(path.join(directory, 'control.json'), { socket, token, epoch }, { exclusive: true });
  } catch (e) { await new Promise(r => server.close(r)); await lock.close(); await fs.unlink(path.join(directory, 'control.lock')); throw e; }
  return { async close() {
    for (const s of clients) s.destroy();
    await new Promise(r => server.close(r)); await Promise.allSettled([...requests]);
    await fs.unlink(path.join(directory, 'control.json')); await lock.close(); await fs.unlink(path.join(directory, 'control.lock'));
  } };
}
