import nodeTest from 'node:test';
// These historical fake contracts are NOT proof of authentication. The operational
// singleton gate is retired because fallback can return the exact same record.
const test = (name, fn) => nodeTest(`Historical fake seam: ${name}`, fn);
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { desktopTransport, localJSON, identity, exactAdmission, discoverPort } from './fixtures/retired-desktop.mjs';
import { enrollGalley, parseLocalLink, hiddenLink, pairingStatus } from './fixtures/retired-pairing.mjs';
import { readPrivate, writePrivate, privateLock } from '../src/private.mjs';
import { prepareWriter, installWriter } from '../src/writer.mjs';
import { writerSkills } from './fixtures/writer-skills.mjs';
import { startWriter } from './fixtures/retired-writer.mjs';
import { startPreparedWriter } from './fixtures/retired-startup.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.resolve('.test-galley-integration-'));
  const project = path.join(root, 'project'), credentials = path.join(root, 'private');
  await fs.mkdir(project); await fs.mkdir(credentials, { mode: 0o700 });
  await fs.writeFile(path.join(project, 'draft.md'), '# Fake draft');
  const client = { id: 'galleyfake', clientKind: 'desktop', authMethod: 'pairing', pairingId: 'pair_fake', usesRelay: false, revokedAt: null, expiresAt: null };
  const calls = []; let handler;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const call = { method: req.method, url: req.url, auth: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined }; calls.push(call);
    res.setHeader('content-type', 'application/json');
    if (handler && await handler(call, res)) return;
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', serverId: 'fake-server' }));
    if (req.url === '/api/client-auth/clients') return res.end(JSON.stringify({ clients: [client] }));
    if (req.url === '/api/client-auth/pairing/redeem') return res.end(JSON.stringify({ ok: true, server: { url: f.origin, fingerprint: 'ABCD-1234' }, client, clientToken: 'fake-token-12345678901234567890' }));
    if (req.url === '/api/session/ses_fake') return res.end(JSON.stringify({ data: { id: 'ses_fake', location: { directory: project }, agent: 'galley-fake' } }));
    if (req.url.endsWith('/prompt')) return res.end(JSON.stringify({ data: { id: call.body.id, sessionID: 'ses_fake', type: 'user', delivery: 'queue', payload: { text: call.body.text }, time: { created: Date.now() } } }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, settings = path.join(root, 'settings.json');
  await fs.writeFile(settings, JSON.stringify({ desktopLocalPort: port }));
  const binding = { draft: path.join(project, 'draft.md'), assetRoots: [], sessionId: 'ses_fake', sessionDirectory: project, agent: 'galley-fake', upstreamIdentity: identity('fake-server', client.id) };
  Object.assign(binding, await writerSkills(root));
  const f = { root, project, credentials, settings, port, origin: `http://127.0.0.1:${port}`, binding, client, calls, server,
    set handler(v) { handler = v; },
    transport() { return desktopTransport({ binding, credentials, settings }); },
    async credential() { await writePrivate(path.join(credentials, 'credential.json'), { serverId: 'fake-server', port, clientId: client.id, pairingId: client.pairingId, token: 'fake-token-12345678901234567890' }, { exclusive: true }); },
    link(overrides = {}) { return `openchamber://connect?v=2&p=${Buffer.from(JSON.stringify({ v: 2, pairingId: client.pairingId, secret: 'x'.repeat(43), fingerprint: 'ABCD-1234', expiresAt: new Date(Date.now() + 300000).toISOString(), candidates: [{ type: 'lan', url: f.origin }], ...overrides })).toString('base64url')}`; },
    options() { return { directory: credentials, settings, serverId: 'fake-server', writerDirectory: project }; },
    payload() { return { sessionId: binding.sessionId, directory: project, upstreamIdentity: binding.upstreamIdentity, messageId: 'msg_fake', text: 'immutable feedback' }; },
  };
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true }); });
  return f;
}

test('desktop literal discovery, server before bearer, exact prompt and admission', async t => {
  const f = await fixture(t); await f.credential();
  const p = f.payload(); assert.deepEqual(await f.transport().submit(p), { accepted: true, messageId: p.messageId });
  const posts = f.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { id: 'msg_fake', text: p.text, delivery: 'queue', resume: true });
  for (let i = 0; i < f.calls.length; i++) if (f.calls[i].url === '/health') assert.equal(f.calls[i].auth, undefined);
  assert.deepEqual(f.calls.slice(0, 3).map(c => c.url), ['/health', '/api/client-auth/clients', '/api/session/ses_fake']);
});

test('wrong server, redirect, changed port and missing credentials fail before bearer', async t => {
  for (const mode of ['server', 'redirect', 'port', 'missing']) {
    const f = await fixture(t); if (mode !== 'missing') await f.credential();
    if (mode === 'port') await fs.writeFile(f.settings, JSON.stringify({ desktopLocalPort: f.port === 65535 ? 1 : f.port + 1 }));
    f.handler = (c, r) => { if (c.url !== '/health') return false; if (mode === 'redirect') { r.statusCode = 302; r.setHeader('location', '/api/session/ses_fake'); r.end('{}'); } else r.end(JSON.stringify({ status: 'ok', serverId: 'wrong' })); return true; };
    await assert.rejects(f.transport().submit(f.payload())); assert.equal(f.calls.some(c => c.auth), false);
  }
});

test('own-client singleton identity, revoke, expiry, relay and HTTP negatives block POST', async t => {
  for (const mode of ['revoked', 'id', 'pairing', 'kind', 'expiry', 'relay', 'multiple', '401', '403']) {
    const f = await fixture(t); await f.credential();
    if (mode === 'revoked') f.client.revokedAt = new Date().toISOString();
    if (mode === 'id') f.client.id = 'other';
    if (mode === 'pairing') f.client.pairingId = 'pair_other';
    if (mode === 'kind') f.client.clientKind = 'desktop-local';
    if (mode === 'expiry') f.client.expiresAt = 'invalid';
    if (mode === 'relay') f.client.usesRelay = true;
    if (['multiple', '401', '403'].includes(mode)) f.handler = (c, r) => { if (c.url !== '/api/client-auth/clients') return false; r.statusCode = mode === 'multiple' ? 200 : Number(mode); r.end(JSON.stringify({ clients: [f.client, f.client] })); return true; };
    await assert.rejects(f.transport().submit(f.payload())); assert.equal(f.calls.some(c => c.method === 'POST'), false);
  }
});

test('exact session id/directory/agent enforced on each submit, no uncertain retry', async t => {
  for (const field of ['id', 'directory', 'agent', 'ack', 'disconnect']) {
    const f = await fixture(t); await f.credential();
    f.handler = (c, r) => {
      if (c.url === '/api/session/ses_fake' && !['ack', 'disconnect'].includes(field)) { const s = { id: 'ses_fake', location: { directory: f.project }, agent: 'galley-fake' }; if (field === 'directory') s.location.directory += '-moved'; else s[field] = 'other'; r.end(JSON.stringify({ data: s })); return true; }
      if (c.url.endsWith('/prompt')) { if (field === 'disconnect') r.destroy(); else r.end(JSON.stringify({ data: { id: c.body.id } })); return true; }
      return false;
    };
    await assert.rejects(f.transport().submit(f.payload()));
    assert.equal(f.calls.filter(c => c.method === 'POST').length, ['ack', 'disconnect'].includes(field) ? 1 : 0);
  }
});

test('admission schema rejects wrong payload, identity, delivery and time', () => {
  const prompt = { id: 'msg_test', text: 'text' };
  const ack = { id: prompt.id, sessionID: 'ses_fake', type: 'user', delivery: 'queue', payload: { text: 'text' }, time: { created: 123 } };
  assert.equal(exactAdmission(ack, 'ses_fake', prompt), true);
  for (const patch of [{ id: 'msg_other' }, { sessionID: 'ses_other' }, { type: 'synthetic' }, { delivery: 'steer' }, { payload: { text: 'changed' } }, { payload: { text: 'text', files: [] } }, { time: { created: 'today' } }]) assert.equal(exactAdmission({ ...ack, ...patch }, 'ses_fake', prompt), false);
});

test('a previously valid connection cannot bypass a later own-client revocation', async t => {
  const f = await fixture(t); await f.credential(); const adapter = f.transport();
  await adapter.submit(f.payload());
  f.client.revokedAt = new Date().toISOString();
  await assert.rejects(adapter.submit({ ...f.payload(), messageId: 'msg_second' }));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('bounded JSON and absolute deadline, redirects never followed', async t => {
  const f = await fixture(t);
  f.handler = (c, r) => { if (c.url === '/large') r.end(JSON.stringify({ text: 'x'.repeat(10000) })); else if (c.url === '/bad') r.end('not json'); else if (c.url === '/redirect') { r.statusCode = 302; r.setHeader('location', f.origin + '/health'); r.end('{}'); } else if (c.url === '/wait') { /* socket closed by deadline */ } return true; };
  await assert.rejects(localJSON(f.port, 'GET', '/large', { max: 100 }));
  await assert.rejects(localJSON(f.port, 'GET', '/bad'));
  await assert.rejects(localJSON(f.port, 'GET', '/redirect'));
  await assert.rejects(localJSON(f.port, 'GET', '/wait', { timeout: 30 }));
  assert.equal(f.calls.some(c => c.url === '/health'), false);
});

test('manual read reconciliation compares payload and never resubmits', async t => {
  const f = await fixture(t); await f.credential();
  let state = 'inbox';
  f.handler = (c, r) => {
    if (c.url.endsWith('/inbox')) { r.end(JSON.stringify({ data: state === 'inbox' ? [{ id: 'msg_fake', sessionID: 'ses_fake', type: 'user', delivery: 'queue', payload: { text: 'immutable feedback' }, time: { created: 123 } }] : [] })); return true; }
    if (c.url.includes('/message/')) { if (state === 'absent') { r.statusCode = 404; r.end('{}'); } else r.end(JSON.stringify({ data: { id: 'msg_fake', type: 'user', text: state === 'conflict' ? 'changed' : 'immutable feedback' } })); return true; } return false;
  };
  const c = { messageId: 'msg_fake', payload: { text: 'immutable feedback' } };
  for (const [s, expected] of [['inbox', 'admitted-inbox'], ['message', 'observed-message'], ['conflict', 'conflict'], ['absent', 'absent-not-retryable']]) { state = s; assert.equal((await f.transport().reconcile(c)).status, expected); }
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('Galley pairing redeems exactly once with stable own dedupe and token-free status', async t => {
  const f = await fixture(t); const link = f.link();
  assert.equal((await enrollGalley(link, f.options())).status, 'paired-not-authorized-for-deployment');
  const ledger = await readPrivate(path.join(f.credentials, 'attempts.json'));
  const redeem = f.calls.find(c => c.url.endsWith('/redeem'));
  assert.equal(redeem.body.dedupeKey, ledger.dedupeKey); assert.match(ledger.dedupeKey, /^galley:/);
  assert.equal(redeem.body.clientKind, 'desktop'); assert.equal(redeem.body.clientLabel, 'Galley');
  assert.equal(JSON.stringify(ledger).includes('x'.repeat(43)), false); assert.equal(JSON.stringify(ledger).includes(link), false);
  assert.equal((await fs.stat(path.join(f.credentials, 'credential.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.credentials, 'credential.json'))).nlink, 1);
  await assert.rejects(enrollGalley(link, f.options()));
  assert.equal(f.calls.filter(c => c.url.endsWith('/redeem')).length, 1);
  assert.deepEqual(await pairingStatus(f.credentials), { credential: 'present-not-live-verified', attempts: 1, halted: false });
});

test('redemption uncertainty persists across restart, even a fresh link cannot replay', async t => {
  const f = await fixture(t);
  f.handler = (c, r) => { if (c.url.endsWith('/redeem')) { r.destroy(); return true; } return false; };
  await assert.rejects(enrollGalley(f.link(), f.options()));
  await assert.rejects(enrollGalley(f.link({ pairingId: 'pair_new' }), f.options()));
  assert.equal(f.calls.filter(c => c.url.endsWith('/redeem')).length, 1);
  assert.equal((await pairingStatus(f.credentials)).halted, true);
});

test('pairing excludes relay/tunnel/LAN/localhost/alternate port/expired/duplicate routes', async t => {
  const f = await fixture(t);
  for (const candidates of [[{ type: 'relay', url: f.origin }], [{ type: 'tunnel', url: f.origin }], [{ type: 'lan', url: 'http://localhost:' + f.port }], [{ type: 'lan', url: 'http://192.0.2.1:' + f.port }], [{ type: 'lan', url: f.origin + '/' }], [{ type: 'lan', url: f.origin }, { type: 'lan', url: f.origin }]]) await assert.rejects(enrollGalley(f.link({ candidates }), f.options()));
  assert.throws(() => parseLocalLink(f.link({ expiresAt: '2000-01-01' }), f.port));
  assert.throws(() => parseLocalLink(f.link() + '&p=duplicate', f.port));
  assert.equal(f.calls.length, 0);
});

test('private files reject symlinks/hardlinks/modes/in-project credentials and exclusive locks', async t => {
  const f = await fixture(t); const file = path.join(f.credentials, 'secret.json'); await writePrivate(file, { fake: true }, { exclusive: true });
  await assert.rejects(writePrivate(file, {}, { exclusive: true }));
  await fs.link(file, path.join(f.credentials, 'hard')); await assert.rejects(readPrivate(file)); await fs.unlink(path.join(f.credentials, 'hard'));
  await fs.chmod(file, 0o644); await assert.rejects(readPrivate(file)); await fs.chmod(file, 0o600);
  await fs.symlink(file, path.join(f.credentials, 'sym')); await assert.rejects(readPrivate(path.join(f.credentials, 'sym')));
  await privateLock(f.credentials, async () => { await assert.rejects(privateLock(f.credentials, async () => {})); });
  await assert.rejects(enrollGalley(f.link(), { ...f.options(), directory: path.join(f.project, 'private') }));
  await fs.writeFile(f.settings, JSON.stringify({ desktopLocalPort: '123' })); await assert.rejects(discoverPort(f.settings));
});

test('hidden prompt never echoes, restores raw mode on success/cancel/overflow', async () => {
  for (const text of ['secret\r', '\u0003', 'a'.repeat(16385)]) {
    const input = new EventEmitter(); input.isTTY = true; input.isRaw = false; input.setRawMode = v => { input.isRaw = v; }; input.resume = () => {}; input.pause = () => {};
    let output = ''; const promise = hiddenLink(input, { isTTY: true, write(s) { output += s; } });
    input.emit('data', Buffer.from(text));
    if (text === 'secret\r') assert.equal(await promise, 'secret'); else await assert.rejects(promise);
    assert.equal(output.includes('secret'), false); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
  }
});

test('writer exclusive on-disk native profile, resolved runtime before installed session payload', async t => {
  const f = await fixture(t); const prepared = await prepareWriter(f.binding);
  assert.equal('default_agent' in prepared.config, false);
  assert.notEqual(prepared.agent, (await prepareWriter(f.binding)).agent);
  const file = await installWriter(prepared); await assert.rejects(installWriter(prepared));
  const content = await fs.readFile(file, 'utf8'); assert.ok(content.endsWith(prepared.profile.system));
  const fields = JSON.parse(content.split('\n')[1]); assert.deepEqual(fields.permissions, prepared.profile.permissions);
  assert.ok(fields.permissions.some(p => p.action === 'external_directory'));
  assert.deepEqual(fields.permissions.filter(p => p.action === 'read' && p.resource.endsWith('/**')).map(p => p.resource), f.binding.skillReferenceDirectories.map(p => `${p}/**`));
  assert.deepEqual(fields.permissions.filter(p => p.action === 'edit'), [{ action: 'edit', resource: 'draft.md', effect: 'allow' }]);
  const model = { providerID: 'fake', id: 'fake-model' }; const calls = []; let created;
  const transport = { async request(method, route, body) {
    calls.push({ method, route, body });
    if (route.startsWith('/api/agent/')) return { location: { directory: f.project }, data: { id: prepared.agent, ...prepared.profile } };
    if (method === 'POST') { created = { id: 'ses_created', ...body }; return { data: created }; }
    return { data: created };
  } };
  assert.equal((await startWriter(prepared, transport, model)).id, 'ses_created');
  assert.equal(calls[0].method, 'GET'); assert.ok(calls[0].route.includes('location%5Bdirectory%5D='));
  assert.deepEqual(calls[1].body, { location: { directory: f.project }, agent: prepared.agent, model, permissions: prepared.profile.permissions });
  assert.equal(calls[2].route, '/api/session/ses_created'); assert.equal('config' in calls[1].body, false);
});

test('runtime system/permissions/location/agent drift blocks creation; readback mismatch stops', async t => {
  const f = await fixture(t); const prepared = await prepareWriter(f.binding); const model = { providerID: 'fake', id: 'fake' };
  for (const mode of ['system', 'permissions', 'location', 'id', 'readback']) {
    let posts = 0;
    const transport = { async request(method, route, body) {
      if (route.startsWith('/api/agent')) {
        const value = { location: { directory: f.project }, data: { id: prepared.agent, ...structuredClone(prepared.profile) } };
        if (mode === 'location') value.location.directory += '-other'; else if (mode !== 'readback') value.data[mode] = mode === 'permissions' ? [...value.data.permissions, { action: '*', resource: '*', effect: 'allow' }] : 'wrong'; return value;
      }
      if (method === 'POST') { posts++; return { data: { id: 'ses_created', ...body } }; }
      return { data: { id: 'ses_created', agent: 'wrong' } };
    } };
    await assert.rejects(startWriter(prepared, transport, model)); assert.equal(posts, mode === 'readback' ? 1 : 0);
  }
});

test('startup journal fences uncertain create across restart; no auto replay', async t => {
  const f = await fixture(t); const prepared = await prepareWriter(f.binding); let posts = 0;
  const transport = { async request(method) {
    if (method === 'GET') return { location: { directory: f.project }, data: { id: prepared.agent, ...prepared.profile } };
    posts++; throw new Error('lost create response');
  } };
  const options = { credentials: f.credentials, transport };
  await assert.rejects(startPreparedWriter(prepared, { providerID: 'fake', id: 'fake' }, options));
  await assert.rejects(startPreparedWriter(prepared, { providerID: 'fake', id: 'fake' }, options));
  assert.equal(posts, 1);
  const journal = await readPrivate(path.join(f.credentials, `startup-${prepared.agent}.json`));
  assert.equal(journal.state, 'uncertain'); assert.equal(journal.digest, prepared.digest);
});

test('profile install refuses symlink parent before writing and skills drift before start', async t => {
  const f = await fixture(t); const prepared = await prepareWriter(f.binding);
  const elsewhere = path.join(f.root, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.project, '.opencode'));
  await assert.rejects(installWriter(prepared)); assert.deepEqual(await fs.readdir(elsewhere), []);
  const files = [];
  for (let i = 0; i < 4; i++) { const p = path.join(f.project, `skill${i}.md`); await fs.writeFile(p, i === 3 ? 'version: 3.1.0' : 'fake'); files.push(p); }
  const local = await prepareWriter(f.binding, files); await fs.appendFile(files[0], 'changed');
  await assert.rejects(startWriter(local, { request() { throw new Error('must not call'); } }, { providerID: 'fake', id: 'fake' }));
});
