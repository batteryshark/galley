import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { executeNative, exactAdmission, within } from '../src/native-worker.mjs';
import { openNative, ipcRequest } from '../src/native-ipc.mjs';
import { nativePlugin } from '../src/native-plugin.mjs';
import { processBirth } from '../src/native-owner.mjs';
import { startPreparedWriter } from '../src/startup.mjs';
import { prepareWriter } from '../src/writer.mjs';
import { writerSkills } from './fixtures/writer-skills.mjs';
import { generateNative } from '../src/native-artifacts.mjs';
import { readPrivate, writePrivate } from '../src/private.mjs';
import { openStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';

const model = { providerID: 'fake', id: 'exact', variant: 'high' };
const payload = { id: 'msg_fake', text: 'immutable', delivery: 'queue', resume: true };
const admission = (p = payload) => ({ id: p.id, sessionID: 'ses_fake', type: 'user', delivery: 'queue', payload: { text: p.text }, time: { created: Date.now() } });
// Force a socket event boundary between the two UTF-8 bytes, in both directions.
async function splitProxy(f) {
  const original = f.connector.privateBinding;
  const socket = path.join(f.directory, 'split.sock');
  function forward(from, to) {
    const chunks = [];
    from.on('data', c => chunks.push(c));
    from.on('end', () => {
      const bytes = Buffer.concat(chunks), i = bytes.indexOf(Buffer.from('é'));
      if (i < 0) return to.end(bytes);
      to.write(bytes.subarray(0, i + 1));
      setTimeout(() => to.end(bytes.subarray(i + 1)), 15);
    });
    from.on('error', () => to.destroy());
  }
  const server = net.createServer({ allowHalfOpen: true }, s => {
    const upstream = net.createConnection({ path: original.socket, allowHalfOpen: true });
    forward(s, upstream); forward(upstream, s);
  });
  await new Promise(r => server.listen(socket, r));
  f.cleanups.push(() => new Promise(r => server.close(r)));
  const b = { ...original, socket };
  await writePrivate(path.join(f.directory, 'binding.json'), b);
  return b;
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'n-'));
  const draft = path.join(root, 'draft.md'); await fs.writeFile(draft, '# Synthetic\n\nReview this paragraph.\n');
  const binding = { sessionId: 'ses_fake', sessionDirectory: path.resolve('.'), draft, assetRoots: [], agent: 'galley-writer-fake', upstreamIdentity: 'pending' };
  const directory = path.join(root, 'p'); await fs.mkdir(directory, { mode: 0o700 });
  // Private IPC must be outside writer project; fake tests use sibling project root.
  const project = path.join(root, 'project'); await fs.mkdir(project); binding.sessionDirectory = project;
  binding.draft = path.join(project, 'draft.md'); await fs.copyFile(draft, binding.draft);
  binding.skillPaths = (await writerSkills(root)).skillPaths;
  const calls = [];
  let session = { id: 'ses_fake', location: { directory: project }, agent: binding.agent };
  const ctx = { location: { directory: project }, agent: { get: async () => { throw new Error('Unprepared'); } }, session: {
    get: async () => { calls.push('get'); return session; },
    prompt: async p => { calls.push(p); return admission(p); },
    context: async () => [],
    create: async p => { calls.push({ create: p }); session = { id: 'ses_fake', ...p }; return session; },
  } };
  const prepared = options.prepare ? await prepareWriter(binding) : undefined;
  if (prepared) binding.agent = prepared.agent;
  const owner = { ownerPID: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000 };
  const connector = await openNative({ directory, binding, ...owner, ...options });
  binding.upstreamIdentity = connector.identity;
  let stop; const cleanups = [];
  t.after(async () => { for (const fn of cleanups) await fn(); await stop?.(); await connector.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, directory, binding, connector, calls, ctx, cleanups, prepared, setSession: s => { session = s; },
    async plugin() { stop = await nativePlugin(path.join(directory, 'binding.json')).setup(ctx); await connector.waitOwner(1000); },
  };
}

test('native worker exact affinity and immutable queued payload', async t => {
  const f = await fixture(t); let authorized = 0;
  const result = await executeNative(f.ctx, { kind: 'feedback', binding: f.binding, payload }, async () => authorized++);
  assert.deepEqual(result, { accepted: true, messageId: payload.id }); assert.equal(authorized, 1);
  assert.deepEqual(f.calls[1], { sessionID: 'ses_fake', ...payload });
  for (const change of [{ id: 'ses_other' }, { agent: 'lead' }, { location: { directory: '/wrong' } }]) {
    f.setSession({ id: 'ses_fake', agent: f.binding.agent, location: { directory: f.project }, ...change });
    await assert.rejects(executeNative(f.ctx, { kind: 'feedback', binding: f.binding, payload }, async () => assert.fail('must not authorize')));
  }
});
test('native admission rejects ID/session/type/delivery/text/extras/time mismatch', () => {
  assert.equal(exactAdmission(admission(), 'ses_fake', payload), true);
  for (const bad of [{ id: 'msg_other' }, { sessionID: 'ses_other' }, { type: 'synthetic' }, { delivery: 'steer' }, { payload: { text: 'altered' } }, { payload: { text: payload.text, files: [] } }, { time: { created: 'now' } }]) assert.equal(exactAdmission({ ...admission(), ...bad }, 'ses_fake', payload), false);
});
test('split multibyte feedback retains intended admission bytes; altered receipt rejected', async t => {
  const f = await fixture(t); await splitProxy(f); await f.plugin();
  const input = { sessionId: 'ses_fake', directory: f.project, upstreamIdentity: f.connector.identity, messageId: 'msg_utf8', text: 'café' };
  await f.connector.submit(input);
  assert.equal(f.calls.find(c => c.id === input.messageId).text, 'café');
  f.ctx.session.prompt = async p => admission({ ...p, text: 'caf��' });
  await assert.rejects(f.connector.submit({ ...input, messageId: 'msg_bad_utf8' }));
});
test('split multibyte startup profile resolves exact complete system before create', async t => {
  const f = await fixture(t, { prepare: true }); const p = f.prepared;
  p.profile.system += '\nSynthetic café regression.';
  f.ctx.agent.get = async () => ({ location: { directory: p.directory }, data: { id: p.agent, ...p.profile } });
  await splitProxy(f); await f.plugin();
  assert.equal((await f.connector.startup(p, model)).agent, p.agent);
  assert.equal(f.calls.filter(c => c.create).length, 1);
});
test('split multibyte IPC result decodes once; raw byte and malformed UTF8 bounds enforced', async t => {
  const f = await fixture(t); const b = await splitProxy(f);
  const who = { pid: process.pid, instance: 'a'.repeat(64) };
  const pending = f.connector.inspect('ses_fake');
  const job = await ipcRequest(b, { ...who, op: 'claim' });
  await ipcRequest(b, { ...who, op: 'result', id: job.id, result: { text: 'café' } });
  assert.deepEqual(await pending, { text: 'café' });
  for (const bytes of [Buffer.alloc(2 * 1024 * 1024 + 1, 32), Buffer.from([0xff])]) {
    await new Promise(resolve => {
      const s = net.createConnection(f.connector.privateBinding.socket);
      s.on('connect', () => s.end(bytes)); s.on('data', c => assert.equal(c.toString(), '{"ok":false}'));
      s.on('error', () => {}); s.on('close', resolve);
    });
  }
  const output = net.createServer(s => { s.on('data', () => {}); s.on('end', () => s.end(Buffer.alloc(2 * 1024 * 1024 + 1, 32))); });
  const socket = path.join(f.directory, 'limit.sock'); await new Promise(r => output.listen(socket, r));
  try { await assert.rejects(ipcRequest({ ...b, socket }, {}), /IPC limit/); } finally { await new Promise(r => output.close(r)); }
});
test('native deadline bounds ignored signals and late preflight never prompts', async t => {
  const f = await fixture(t); let release;
  f.ctx.session.get = () => new Promise(r => { release = r; });
  await assert.rejects(executeNative(f.ctx, { kind: 'feedback', binding: f.binding, payload }, async () => assert.fail(), 10));
  release({ id: 'ses_fake', agent: f.binding.agent, location: { directory: f.project } });
  await within(() => Promise.resolve(), 10); assert.equal(f.calls.length, 0);
});
test('private IPC authenticates credential/epoch/owner and pins one plugin instance', async t => {
  const f = await fixture(t); const b = f.connector.privateBinding;
  const claim = { op: 'claim', pid: process.pid, instance: 'a'.repeat(64) };
  for (const [binding, request] of [[{ ...b, token: 'b'.repeat(64) }, claim], [{ ...b, epoch: 'bad' }, claim], [b, { ...claim, pid: process.pid + 1 }]]) await assert.rejects(ipcRequest(binding, request));
  assert.equal(await ipcRequest(b, claim), null);
  await assert.rejects(ipcRequest(b, { ...claim, instance: 'b'.repeat(64) }));
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(b.socket)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.directory, 'binding.json'))).mode & 0o777, 0o600);
});
test('native plugin inert for absent binding, wrong location, PID and birth time', async t => {
  const f = await fixture(t);
  f.cleanups.push(await nativePlugin(path.join(f.directory, 'absent')).setup(f.ctx));
  f.cleanups.push(await nativePlugin(path.join(f.directory, 'binding.json')).setup({ ...f.ctx, location: { directory: '/other' } }));
  // Wrong PID/birth-time are checked before claims by plugin and by broker.
  const b = await readPrivate(path.join(f.directory, 'binding.json'));
  for (const change of [{ ownerPID: process.pid + 1 }, { ownerStartedAt: 1 }]) {
    const file = path.join(f.directory, `wrong-${Object.keys(change)[0]}.json`);
    await fs.writeFile(file, JSON.stringify({ ...b, ...change }), { mode: 0o600 });
    f.cleanups.push(await nativePlugin(file).setup(f.ctx));
  }
  await assert.rejects(f.connector.waitOwner(80));
});
test('claim loss expires once; old lease and restarted plugin cannot resend', async t => {
  const f = await fixture(t, { leaseMs: 40 }); const b = f.connector.privateBinding;
  const who = { pid: process.pid, instance: 'a'.repeat(64) };
  const pending = f.connector.inspect('ses_fake'); const rejected = assert.rejects(pending);
  const job = await ipcRequest(b, { ...who, op: 'claim' }); assert.equal(job.kind, 'inspect');
  await rejected;
  await assert.rejects(ipcRequest(b, { ...who, op: 'authorize', id: job.id }));
  await assert.rejects(ipcRequest(b, { ...who, op: 'result', id: job.id, result: {} }));
  assert.equal(await ipcRequest(b, { ...who, op: 'claim' }), null);
  await assert.rejects(ipcRequest(b, { ...who, instance: 'b'.repeat(64), op: 'claim' }));
});
test('native context reconciliation is read-only; absent is never permission to retry', async t => {
  const f = await fixture(t);
  for (const [messages, expected] of [[[], 'absent-not-retryable'], [[{ id: payload.id, type: 'user', text: payload.text }], 'observed-message'], [[{ id: payload.id, type: 'user', text: 'changed' }], 'conflict']]) {
    f.ctx.session.context = async () => messages;
    assert.equal((await executeNative(f.ctx, { kind: 'reconcile', binding: f.binding, payload }, async () => assert.fail())).status, expected);
  }
  assert.ok(f.calls.every(c => c === 'get'));
});
test('same-process plugin/broker inspect and submit, no arbitrary session', async t => {
  const f = await fixture(t); await f.plugin();
  assert.equal((await f.connector.inspect('ses_fake')).upstreamIdentity, f.connector.identity);
  await assert.rejects(f.connector.inspect('ses_lead'));
  assert.equal((await f.connector.submit({ sessionId: 'ses_fake', directory: f.project, upstreamIdentity: f.connector.identity, messageId: payload.id, text: payload.text })).accepted, true);
});
test('native startup full profile, exact model and final permissions; exclusive journal fences retry', async t => {
  const f = await fixture(t); const p = await prepareWriter(f.binding);
  // Reopen is intentionally forbidden; this fixture enrolls the prepared agent before loading.
  f.binding.agent = p.agent;
  f.ctx.agent.get = async () => ({ location: { directory: p.directory }, data: { id: p.agent, ...p.profile } });
  const job = { kind: 'startup', binding: f.binding, prepared: p, model };
  const s = await executeNative(f.ctx, job, async () => {});
  assert.equal(s.agent, p.agent); assert.deepEqual(s.model, model); assert.deepEqual(s.permissions, p.profile.permissions);
  const fake = { startup: async () => { assert.equal((await readPrivate(path.join(f.directory, `startup-${p.agent}.json`))).state, 'uncertain'); return s; } };
  await startPreparedWriter(p, model, { directory: f.directory, connector: fake });
  await assert.rejects(startPreparedWriter(p, model, { directory: f.directory, connector: fake }));
  assert.equal((await readPrivate(path.join(f.directory, `startup-${p.agent}.json`))).state, 'created-not-edit-verified');
  f.ctx.agent.get = async () => ({ location: { directory: p.directory }, data: { id: p.agent, ...p.profile, system: 'partial' } });
  await assert.rejects(executeNative(f.ctx, job, async () => assert.fail()));
});
test('native uncertain create stays fenced and artifacts are generated only, never active', async t => {
  const f = await fixture(t); const p = await prepareWriter(f.binding);
  let creates = 0;
  const connector = { startup: async () => { creates++; throw new Error('response lost'); } };
  for (let i = 0; i < 2; i++) await assert.rejects(startPreparedWriter(p, model, { directory: f.directory, connector }));
  assert.equal(creates, 1);
  const output = path.join(f.root, 'artifacts'); await fs.mkdir(output);
  await generateNative(p, output, path.join(f.directory, 'binding.json'));
  assert.match(await fs.readFile(path.join(output, 'galley-native.ts'), 'utf8'), /nativePlugin/);
  assert.ok((await fs.readFile(path.join(output, `${p.agent}.md`), 'utf8')).includes(p.profile.system));
  await assert.rejects(fs.stat(path.join(f.project, '.opencode')));
  await assert.rejects(generateNative(p, output, path.join(f.directory, 'binding.json')));
});
test('native startup through real IPC/fake Context reads durable pre-create fence and binds only new writer', async t => {
  const f = await fixture(t, { prepare: true }); const p = f.prepared;
  f.ctx.agent.get = async () => ({ location: { directory: p.directory }, data: { id: p.agent, ...p.profile } });
  const create = f.ctx.session.create;
  f.ctx.session.create = async input => {
    assert.equal((await readPrivate(path.join(f.directory, `startup-${p.agent}.json`))).state, 'uncertain');
    assert.deepEqual(input, { location: { directory: p.directory }, metadata: {}, agent: p.agent, model, permissions: p.profile.permissions });
    return create(input);
  };
  await f.plugin();
  const s = await startPreparedWriter(p, model, { directory: f.directory, connector: f.connector });
  assert.equal(s.agent, p.agent);
  assert.equal((await f.connector.inspect(s.id)).agent, p.agent);
  await assert.rejects(startPreparedWriter(p, model, { directory: f.directory, connector: f.connector }));
  assert.equal(f.calls.filter(c => c.create).length, 1);
});
test('in-flight prompt timeout stays uncertain even when native result completes later', async t => {
  const f = await fixture(t); let resolve, prompts = 0;
  f.ctx.session.prompt = () => { prompts++; return new Promise(r => { resolve = r; }); };
  await assert.rejects(executeNative(f.ctx, { kind: 'feedback', binding: f.binding, payload }, async () => {}, 10));
  resolve(admission()); await Promise.resolve(); assert.equal(prompts, 1);
});
test('native close cancels waiting owner; clean restart rotates epoch without deleting journals', async t => {
  const f = await fixture(t);
  const wait = assert.rejects(f.connector.waitOwner(1000));
  await f.connector.close(); await wait;
  const next = await openNative({ directory: f.directory, binding: f.binding });
  assert.notEqual(next.privateBinding.epoch, f.connector.privateBinding.epoch);
  await next.close();
  await assert.rejects(f.connector.inspect('ses_fake'));
});
test('browser save-before-native-send end to end, admission only, immutable once', async t => {
  const f = await fixture(t); await f.plugin();
  const store = await openStore(path.join(f.root, 'state'), f.binding);
  const token = await store.issue();
  const app = await startServer({ store, upstream: f.connector });
  f.cleanups.push(async () => { await app.close(); await store.close(); });
  // Use the existing HTTP API contract, not a plugin-specific control route.
  const origin = app.origin;
  const request = async (route, body) => {
    const r = await fetch(origin + '/galley/api/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Origin: origin, 'X-Galley': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  const snapshot = await request('document');
  assert.equal((await request('native/startup', { sessionId: 'ses_lead', directory: '/other', model })).status, 404);
  // Dedicated core tests cover browser anchors/save protocol; this seam checks native submit
  // reads the immutable disk intent before it crosses the side-effect boundary.
  assert.equal(snapshot.status, 200);
  let prompts = 0;
  f.ctx.session.prompt = async p => {
    prompts++;
    const disk = JSON.parse(await fs.readFile(path.join(f.root, 'state/state.json')));
    assert.equal(disk.batches[0].status, 'sending'); assert.equal(disk.batches[0].payload.text, p.text); assert.equal(disk.batches[0].members.length, 2);
    return admission(p);
  };
  const comment = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, message: 'Please clarify', anchor: { kind: 'continuous', revision: snapshot.data.revision, quote: snapshot.data.text, offset: 0, prefix: '', suffix: '' } };
  assert.equal((await request('notes', comment)).data.status, 'pending');
  assert.equal((await request('notes', { ...comment, id: randomUUID(), operationId: randomUUID(), message: 'A second note in the same message' })).data.status, 'pending');
  const batch = { id: randomUUID(), revision: snapshot.data.revision };
  assert.equal((await request('batches', batch)).data.status, 'accepted');
  assert.equal((await request('batches', batch)).data.status, 'accepted');
  assert.equal(prompts, 1);
});

test('automatic registration records owner; quiescent plugin reload fences old generation', async t => {
  const f = await fixture(t, { ownerPID: undefined, ownerStartedAt: undefined });
  let stop = await nativePlugin(path.join(f.directory, 'binding.json')).setup(f.ctx);
  f.cleanups.push(async () => stop());
  await f.connector.waitOwner(2000);
  const old = await readPrivate(path.join(f.directory, 'owner.json'));
  assert.equal(old.pid, process.pid); assert.equal(old.birth, processBirth(process.pid));
  assert.equal((await f.connector.inspect('ses_fake')).id, 'ses_fake');
  await stop();
  stop = await nativePlugin(path.join(f.directory, 'binding.json')).setup(f.ctx);
  await f.connector.waitOwner(2000);
  const next = await readPrivate(path.join(f.directory, 'owner.json'));
  assert.notEqual(old.generation, next.generation);
  await assert.rejects(ipcRequest(f.connector.privateBinding, { pid: old.pid, instance: old.instance, generation: old.generation, op: 'claim' }));
  assert.equal((await f.connector.inspect('ses_fake')).agent, f.binding.agent);
});
test('plugin loaded before binding reconnects to later and new broker generations without mutation replay', async t => {
  const f = await fixture(t, { ownerPID: undefined, ownerStartedAt: undefined });
  await f.connector.close();
  const file = path.join(f.directory, 'binding.json');
  const retired = await readPrivate(file); await fs.unlink(file);
  const stop = await nativePlugin(file).setup(f.ctx); f.cleanups.push(stop);
  await writePrivate(file, retired);
  let next = await openNative({ directory: f.directory, binding: f.binding });
  f.cleanups.push(async () => next.close());
  await next.waitOwner(3000); await next.inspect('ses_fake');
  const old = next.privateBinding;
  await next.close();
  next = await openNative({ directory: f.directory, binding: f.binding });
  await next.waitOwner(3500); await next.inspect('ses_fake');
  await assert.rejects(ipcRequest(old, { op: 'claim', pid: process.pid, instance: 'a'.repeat(64) }));
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 0);
});
test('ambiguous simultaneous registrations fail closed before job claim, no owner takeover', async t => {
  const f = await fixture(t, { ownerPID: undefined, ownerStartedAt: undefined });
  const b = f.connector.privateBinding;
  const who = { pid: process.pid, birth: processBirth(process.pid), directory: f.project, instance: 'a'.repeat(64) };
  const { generation } = await ipcRequest(b, { ...who, op: 'register' });
  await assert.rejects(ipcRequest(b, { ...who, instance: 'b'.repeat(64), op: 'register' }));
  await assert.rejects(ipcRequest(b, { ...who, generation, op: 'claim' }));
  await assert.rejects(f.connector.waitOwner(50));
  assert.equal(f.calls.length, 0);
});
test('in-flight lost mutation fences release/reload; heartbeat expiry never requeues', async t => {
  const f = await fixture(t, { ownerPID: undefined, ownerStartedAt: undefined, leaseMs: 30 });
  const b = f.connector.privateBinding;
  const who = { pid: process.pid, birth: processBirth(process.pid), directory: f.project, instance: 'a'.repeat(64) };
  const registration = await ipcRequest(b, { ...who, op: 'register' });
  await new Promise(r => setTimeout(r, 420));
  const pending = f.connector.submit({ sessionId: 'ses_fake', directory: f.project, upstreamIdentity: f.connector.identity, messageId: 'msg_lost', text: 'café' });
  const rejected = assert.rejects(pending);
  const request = body => ipcRequest(b, { ...who, ...registration, ...body });
  const job = await request({ op: 'claim' }); await rejected;
  await assert.rejects(request({ op: 'authorize', id: job.id }));
  await assert.rejects(request({ op: 'release' }));
  assert.equal(await request({ op: 'claim' }), null);
  await new Promise(r => setTimeout(r, 3020));
  await assert.rejects(request({ op: 'claim' }));
  assert.deepEqual(await ipcRequest(b, { ...who, op: 'register' }), registration);
  assert.equal(await request({ op: 'claim' }), null);
});
test('runtime live-owner recovery denied without unlocking or changing epoch', async t => {
  const f = await fixture(t, { ownerPID: undefined, ownerStartedAt: undefined });
  const before = await readPrivate(path.join(f.directory, 'binding.json'));
  await assert.rejects(openNative({ directory: f.directory, binding: f.binding }));
  assert.deepEqual(await readPrivate(path.join(f.directory, 'binding.json')), before);
  assert.equal((await readPrivate(path.join(f.directory, 'native.lock'))).pid, process.pid);
});
test('only exact gone broker metadata permits stale runtime recovery; fences survive', async t => {
  const f = await fixture(t, { ownerPID: undefined, ownerStartedAt: undefined });
  await f.connector.close();
  const file = path.join(f.directory, 'binding.json'); const old = await readPrivate(file);
  const gone = { pid: process.pid, birth: processBirth(process.pid) - 10000 };
  await writePrivate(file, { ...old, retired: false, broker: gone });
  await writePrivate(path.join(f.directory, 'native.lock'), gone, { exclusive: true });
  const fence = path.join(f.directory, 'startup-galley-writer-uncertain.json');
  await writePrivate(fence, { state: 'uncertain' }, { exclusive: true });
  const next = await openNative({ directory: f.directory, binding: f.binding });
  try { assert.deepEqual(await readPrivate(fence), { state: 'uncertain' }); assert.notEqual(next.privateBinding.epoch, old.epoch); } finally { await next.close(); }
});
test('supported native parentID requires exact parent directory and readback', async t => {
  const f = await fixture(t); const p = await prepareWriter(f.binding); f.binding.agent = p.agent;
  f.ctx.agent.get = async () => ({ location: { directory: p.directory }, data: { id: p.agent, ...p.profile } });
  const get = f.ctx.session.get;
  f.ctx.session.get = async x => x.sessionID === 'ses_parent' ? { id: 'ses_parent', location: { directory: p.directory } } : get(x);
  const s = await executeNative(f.ctx, { kind: 'startup', binding: f.binding, prepared: p, model, parentID: 'ses_parent' }, async () => {});
  assert.equal(s.parentID, 'ses_parent');
  assert.deepEqual(s.metadata, {});
  f.ctx.session.get = async () => ({ id: 'ses_parent', location: { directory: '/wrong' } });
  await assert.rejects(executeNative(f.ctx, { kind: 'startup', binding: f.binding, prepared: p, model, parentID: 'ses_parent' }, async () => assert.fail()));
  assert.equal(f.calls.filter(c => c.create).length, 1);
});
test('read-only observation and bounded stop target only the exact bound writer', async t => {
  const f = await fixture(t); let stopped;
  f.ctx.session.interrupt = async input => { stopped = input; };
  assert.deepEqual((await executeNative(f.ctx, { kind: 'observe', binding: f.binding }, async () => assert.fail())).messages, []);
  await executeNative(f.ctx, { kind: 'stop', binding: f.binding }, async () => {});
  assert.deepEqual(stopped, { sessionID: 'ses_fake', continue: false });
  f.setSession({ id: 'ses_other', agent: f.binding.agent, location: { directory: f.project } });
  await assert.rejects(executeNative(f.ctx, { kind: 'stop', binding: f.binding }, async () => assert.fail()));
});
