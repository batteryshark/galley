import net from 'node:net';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { privateDirectory, writePrivate, readPrivate } from './private.mjs';
import { processBirth, ownerGone } from './native-owner.mjs';
import { assertSession } from './native-worker.mjs';

const MAX = 2 * 1024 * 1024;
const secret = () => randomBytes(32).toString('hex');
function match(a, b) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
export function ipcRequest(binding, body, ms = 1500) {
  return new Promise((resolve, reject) => {
    const frame = Buffer.from(JSON.stringify({ token: binding.token, epoch: binding.epoch, ...body }) + '\n');
    if (frame.length > MAX) { reject(new Error('IPC limit')); return; }
    const s = net.createConnection(binding.socket); const chunks = []; let size = 0;
    const timer = setTimeout(() => s.destroy(new Error('IPC deadline')), ms);
    s.on('connect', () => s.end(frame));
    s.on('data', chunk => { size += chunk.length; if (size > MAX) s.destroy(new Error('IPC limit')); else chunks.push(chunk); });
    s.on('error', reject);
    s.on('close', () => { clearTimeout(timer); try { const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); if (!r.ok) throw new Error('IPC refused'); resolve(r.value); } catch (e) { reject(e); } });
  });
}

// Galley owns this listener. Not HTTP, not mounted by the web server, no API proxy.
export async function openNative({ directory, binding, ownerPID, ownerStartedAt, leaseMs = 4500 }) {
  const automatic = ownerPID === undefined && ownerStartedAt === undefined;
  if ((!automatic && (!Number.isSafeInteger(ownerPID) || ownerPID < 1 || !Number.isFinite(ownerStartedAt))) || !(binding.agent?.startsWith('galley-writer-') || (binding.protocol === 'pack-writer-v1' && binding.agent === 'writer'))) throw new Error('Invalid native owner/writer');
  await privateDirectory(directory, binding.sessionDirectory);
  const socket = path.join(directory, 'ipc.sock');
  if (Buffer.byteLength(socket) > 100) throw new Error('Unix socket path too long');
  const lockFile = path.join(directory, 'native.lock'), bindingFile = path.join(directory, 'binding.json');
  const broker = { pid: process.pid, birth: processBirth(process.pid) };
  // Serialize recovery too. Never unlink an unrecognized lock or live owner's socket.
  const recovery = await fs.open(path.join(directory, 'recovery.lock'), 'wx', 0o600);
  let lock;
  try {
    let old;
    try { old = await readPrivate(bindingFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old && !old.retired && !ownerGone(old.broker)) throw new Error('Old broker not confirmed gone');
    try {
      const previous = await readPrivate(lockFile);
      if (!ownerGone(previous)) throw new Error('Native broker still alive');
      await fs.unlink(lockFile);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (old) {
      if (old.sessionDirectory !== binding.sessionDirectory) throw new Error('Changed runtime project');
      // Only exact known socket, no arbitrary cleanup target. Journals are untouched.
      try { const s = await fs.lstat(socket); if (!s.isSocket() || s.uid !== process.getuid()) throw new Error('Unsafe old socket'); await fs.unlink(socket); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    lock = await fs.open(lockFile, 'wx', 0o600);
    await lock.writeFile(JSON.stringify(broker)); await lock.sync();
  } finally { await recovery.close(); await fs.unlink(path.join(directory, 'recovery.lock')); }
  const epoch = secret(), token = secret();
  const privateBinding = { socket, epoch, token, ownerPID, ownerStartedAt, broker, sessionDirectory: binding.sessionDirectory };
  binding = { ...binding, upstreamIdentity: `native:${epoch}` };
  let instance, pending, closed = false, ownerReady, ownerFailed, closing, owner, ambiguous = false, tainted = false;
  let requests = Promise.resolve();
  const clients = new Set();
  function fail() { if (pending) { if (pending.claimed && ['startup', 'feedback'].includes(pending.job.kind)) tainted = true; clearTimeout(pending.timer); pending.reject(new Error('Native outcome uncertain; no replay')); pending = undefined; } }
  function valid(r) { return !closed && !ambiguous && r.pid === (automatic ? owner?.pid : ownerPID) && typeof r.instance === 'string' && /^[a-f0-9]{64}$/.test(r.instance) && (!instance || instance === r.instance) && (!automatic || (r.generation === owner?.generation && Date.now() - owner.heartbeat < 3000)); }
  const server = net.createServer({ allowHalfOpen: true }, s => {
    if (clients.size >= 16) { s.destroy(); return; }
    clients.add(s); const chunks = []; let size = 0; s.setTimeout(1500, () => s.destroy());
    s.on('error', () => {}); s.on('close', () => clients.delete(s));
    s.on('data', c => { size += c.length; if (size > MAX) s.destroy(); else chunks.push(c); });
    s.on('end', () => { requests = requests.then(async () => {
      let value;
      try {
        if (size > MAX) throw new Error('IPC limit');
        const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!match(r.token, token) || r.epoch !== epoch || closed) throw new Error('Denied');
        if (automatic && r.op === 'register') {
          if (ambiguous || r.directory !== binding.sessionDirectory || !Number.isFinite(r.birth) || !/^[a-f0-9]{64}$/.test(r.instance) || processBirth(r.pid) !== r.birth) throw new Error('Invalid registration');
          if (owner && (owner.pid !== r.pid || owner.instance !== r.instance || owner.birth !== r.birth)) {
            if (!ownerGone(owner)) { ambiguous = true; fail(); throw new Error('Ambiguous owners'); }
            fail(); owner = undefined; instance = undefined; tainted = false;
          }
          if (!owner) owner = { pid: r.pid, birth: r.birth, instance: r.instance, generation: secret(), readyAt: Date.now() + 400 };
          owner.heartbeat = Date.now(); instance = owner.instance;
          await writePrivate(path.join(directory, 'owner.json'), { ...owner, epoch });
          s.end(JSON.stringify({ ok: true, value: { generation: owner.generation } })); return;
        }
        if (!valid(r)) throw new Error('Denied');
        if (automatic) {
          owner.heartbeat = Date.now();
          if (r.op === 'release') {
            if (pending || tainted) throw new Error('Not quiescent');
            owner = undefined; instance = undefined; s.end('{"ok":true,"value":true}'); return;
          }
          if (Date.now() < owner.readyAt) { s.end('{"ok":true,"value":null}'); return; }
        }
        instance ||= r.instance; ownerReady?.();
        if (r.op === 'claim') {
          value = null;
          if (pending && !pending.claimed) { pending.claimed = true; pending.instance = instance; value = pending.job; }
        } else {
          if (!pending || !pending.claimed || pending.job.id !== r.id || pending.instance !== instance || Date.now() >= pending.expires) throw new Error('Expired claim');
          if (r.op === 'authorize') value = true;
          else if (r.op === 'result') {
            const p = pending; pending = undefined; clearTimeout(p.timer);
            if (r.failed) { if (['startup', 'feedback'].includes(p.job.kind)) tainted = true; p.reject(new Error('Native outcome uncertain')); }
            else p.resolve(r.result);
            value = true;
          } else throw new Error('Unknown IPC operation');
        }
        const bytes = JSON.stringify({ ok: true, value });
        if (Buffer.byteLength(bytes) > MAX) throw new Error('IPC output limit');
        s.end(bytes);
      } catch { s.end('{"ok":false}'); }
    }); });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    await fs.chmod(socket, 0o600);
    await writePrivate(bindingFile, privateBinding);
  } catch (e) { await new Promise(r => server.close(r)); await lock.close(); await fs.unlink(path.join(directory, 'native.lock')); throw e; }
  function run(kind, extra = {}) {
    if (pending || closed) return Promise.reject(new Error('Native connector busy/closed'));
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), kind, binding: structuredClone(binding), ...extra };
      pending = { job, resolve, reject, expires: Date.now() + leaseMs, timer: setTimeout(fail, leaseMs) };
    });
  }
  return {
    identity: binding.upstreamIdentity,
    privateBinding,
    waitOwner(ms = 60000) {
      if (closed) return Promise.reject(new Error('Connector closed'));
      if (instance && (!automatic || Date.now() >= owner.readyAt) && !ambiguous) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { ownerReady = undefined; reject(new Error('No enrolled plugin owner')); }, ms);
        ownerReady = () => { clearTimeout(t); ownerReady = undefined; ownerFailed = undefined; resolve(); };
        ownerFailed = () => { clearTimeout(t); ownerReady = undefined; ownerFailed = undefined; reject(new Error('Connector closed')); };
      });
    },
    async inspect(sessionId) { if (sessionId !== binding.sessionId) throw new Error('Wrong session'); return run('inspect'); },
    async submit(input) {
      if (input.sessionId !== binding.sessionId || input.directory !== binding.sessionDirectory || input.upstreamIdentity !== binding.upstreamIdentity || !/^msg_[\w-]+$/.test(input.messageId)) throw new Error('Wrong feedback binding');
      const result = await run('feedback', { payload: { id: input.messageId, text: input.text, delivery: 'queue', resume: true } });
      if (result?.accepted !== true || result.messageId !== input.messageId) throw new Error('Wrong feedback receipt');
      return result;
    },
    reconcile(comment) { return run('reconcile', { payload: { id: comment.messageId, text: comment.payload.text } }); },
    observe() { return run('observe'); },
    stopWriter() { return run('stop'); },
    async startup(prepared, model, parentID) {
      if (prepared.directory !== binding.sessionDirectory || prepared.draft !== binding.draft || prepared.agent !== binding.agent) throw new Error('Wrong startup binding');
      if (parentID !== undefined && !/^ses_[\w-]+$/.test(parentID)) throw new Error('Invalid parent');
      const s = await run('startup', { prepared, model, ...(parentID ? { parentID } : {}) });
      assertSession(s, { ...binding, sessionId: s.id }); binding.sessionId = s.id;
      return s;
    },
    close() {
      if (closing) return closing;
      closed = true; ownerFailed?.(); fail(); for (const s of clients) s.destroy();
      closing = (async () => { await new Promise(r => server.close(r)); await requests; await writePrivate(bindingFile, { ...privateBinding, retired: true }); await lock.close(); await fs.unlink(path.join(directory, 'native.lock')); })();
      // Retired generation may reconnect; journals/comments remain replay fences.
      return closing;
    },
  };
}
