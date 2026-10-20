import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { openStore } from '../src/store.mjs';
import { renderDraft, validateAnchor, presentationReader } from '../src/renderer.mjs';
import { boundedRead, assetPath, readImage, validateBinding } from '../src/files.mjs';
import { startServer } from '../src/server.mjs';
import { prepareWriter, startFakeWriter, canonicalSkills, verifyPrepared } from '../src/writer.mjs';
import { writerSkills } from './fixtures/writer-skills.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.resolve('.test-galley-'));
  const draft = path.join(root, 'draft.md'), assets = path.join(root, 'assets');
  await fs.mkdir(assets);
  await fs.writeFile(draft, '# Synthetic draft\n\nAlpha & beta. Alpha is repeated.\n\n![sample](assets/pixel.png)\n');
  await fs.writeFile(path.join(assets, 'pixel.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const binding = { draft, assetRoots: [assets], siteAssetRoot: assets, sessionId: 'ses_fake', sessionDirectory: root, upstreamIdentity: 'fake-only' };
  binding.skillPaths = (await writerSkills(root)).skillPaths;
  let store = await openStore(path.join(root, 'private'), binding);
  const token = await store.issue();
  const calls = [];
  const upstream = {
    async inspect(id) { return { id, directory: root, upstreamIdentity: 'fake-only' }; },
    async submit(payload) { calls.push(payload); return { accepted: true, messageId: payload.messageId }; },
    ...options.upstream,
  };
  let app = await startServer({ store, upstream, deliveryTimeout: 50, prefix: options.prefix ?? '/galley', historicalTestMode: true });
  const f = {
    root, draft, assets, binding, token, upstream, calls,
    get store() { return store; }, get app() { return app; },
    async restart() { await app.close(); await store.close(); store = await openStore(path.join(root, 'private')); app = await startServer({ store, upstream, deliveryTimeout: 50, prefix: options.prefix ?? '/galley', historicalTestMode: true }); },
    async request(route, data, headers = {}, method) {
      return fetch(`${app.origin}${options.prefix ?? '/galley'}/${route}`, {
        method: method || (data === undefined ? 'GET' : 'POST'),
        headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { Origin: app.origin, 'Content-Type': 'application/json', 'X-Galley': '1' }), ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    },
    async document() { const response = await this.request('api/document'); assert.equal(response.status, 200); return response.json(); },
    async comment() {
      const doc = await this.document(); const block = doc.blocks.find(b => b.text.includes('Alpha'));
      return { id: randomUUID(), message: 'Please clarify this synthetic paragraph.', anchor: { revision: doc.revision, block: block.id, quote: block.text, offset: 0, prefix: '', suffix: '' } };
    },
  };
  t.after(async () => { await app.close(); await store.close(); await fs.rm(root, { recursive: true }); });
  return f;
}

test('loopback binding, /galley UI, root prefix, private authorization', async t => {
  for (const prefix of ['/galley', '']) {
    const f = await fixture(t, { prefix });
    assert.equal(f.app.server.address().address, '127.0.0.1');
    assert.equal((await f.request('')).status, 200);
    assert.equal((await f.request('app.js')).status, 200);
    assert.equal((await f.request('api/document', undefined, { Authorization: '' })).status, 401);
    const doc = await f.document(); assert.match(doc.html, /Synthetic draft/);
    assert.equal((await f.request('api/document?token=secret')).status, 400);
    const response = await f.request('api/document');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('CSRF, cross-origin, host guard, bounds and robust malformed requests', async t => {
  const f = await fixture(t); const data = await f.comment();
  assert.equal((await f.request('api/comments', data, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('api/comments', data, { 'X-Galley': '' })).status, 403);
  assert.equal((await f.request('api/comments', data, { Origin: '' })).status, 403);
  assert.equal((await f.request('api/document', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.request('api/comments', { ...data, message: 'x'.repeat(40000) })).status, 413);
  assert.equal((await f.request('api/comments', data, { 'Content-Type': 'text/plain' })).status, 415);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${f.app.origin}/galley/api/document`, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await f.request('api/comments', null)).status, 400);
});

test('revocation and expiry persist; expired capability cannot submit', async t => {
  const f = await fixture(t);
  const short = await f.store.issue(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.request('api/document', undefined, { Authorization: `Bearer ${short}` })).status, 401);
  assert.equal((await f.request('api/revoke', {})).status, 200);
  assert.equal((await f.request('api/document')).status, 401);
  await f.restart();
  assert.equal((await f.request('api/document')).status, 401);
});

test('inert Markdown/HTML, no external images/links or script attributes', async t => {
  const f = await fixture(t);
  const rendered = renderDraft('# Hello\n\n<script>alert(1)</script><iframe src="/x"></iframe><img src="https://evil.invalid/a" onerror="alert(1)"><svg onload="x"></svg><a href="javascript:alert(1)">x</a>\n\n[external](https://example.com)\n\n**Bold** &amp; plain <em>words</em>', f.binding);
  assert.doesNotMatch(rendered.html, /<script|<iframe|<svg|onerror|onload|javascript:|https:\/\//i);
  assert.match(rendered.html, /<strong>Bold<\/strong>/);
  assert.equal(rendered.blocks.at(-1).text, 'Bold & plain words');
  assert.equal(Object.keys(rendered.images).length, 0);
});

test('registered relative, site-root and absolute raster assets; no proxy paths', async t => {
  const f = await fixture(t);
  for (const source of ['assets/pixel.png', '/assets/pixel.png', `${f.assets}/pixel.png`]) {
    await fs.writeFile(f.draft, `![synthetic](${source})`);
    const doc = await f.document(); const id = /data-image="([a-f\d]{32})"/.exec(doc.html)[1];
    const response = await f.request(`image/${id}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal((await response.arrayBuffer()).byteLength, 8);
    assert.doesNotMatch(doc.html, new RegExp(f.root));
  }
  assert.equal((await f.request('image/00000000000000000000000000000000')).status, 404);
  assert.equal((await f.request('image/not-a-path')).status, 404);
});

test('traversal, encoding, remote sources, SVG, oversized files, symlink escapes denied', async t => {
  const f = await fixture(t);
  for (const source of ['../draft.md', '%2e%2e/draft.md', 'https://evil.invalid/a', '//evil.invalid/a', 'file:///etc/passwd', '/etc/passwd', 'assets\\pixel.png']) {
    assert.throws(() => assetPath(source, f.binding));
  }
  assert.equal(assetPath('assets/%252e%252e/x', f.binding), path.join(f.assets, '%2e%2e/x')); // Decode once, never twice.
  const link = path.join(f.assets, 'link.png'); await fs.symlink(f.draft, link);
  await assert.rejects(readImage(link));
  const parentLink = path.join(f.assets, 'linkdir'); await fs.symlink(f.root, parentLink);
  await assert.rejects(boundedRead(path.join(parentLink, 'draft.md')));
  const svg = path.join(f.assets, 'bad.svg'); await fs.writeFile(svg, '<svg/>'); await assert.rejects(readImage(svg));
  const large = path.join(f.assets, 'large'); await fs.writeFile(large, Buffer.alloc(5 * 1024 * 1024 + 1)); await assert.rejects(readImage(large));
  await assert.rejects(validateBinding({ ...f.binding, draft: link }));
  const sibling = f.root + '-sibling';
  assert.throws(() => assetPath(`${sibling}/file.png`, f.binding));
});

test('durable save, exact duplicate posts and deliveries are idempotent', async t => {
  const f = await fixture(t); const data = await f.comment();
  const saved = await (await f.request('api/comments', data)).json(); assert.equal(saved.status, 'saved');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('api/comments', data)).status, 200);
  assert.equal((await f.request('api/comments', { ...data, message: 'different' })).status, 409);
  await f.restart();
  assert.equal((await f.document()).comments[0].id, data.id);
  const results = await Promise.all([f.request(`api/comments/${data.id}/send`, {}), f.request(`api/comments/${data.id}/send`, {})]);
  for (const result of results) assert.equal((await result.json()).status, 'accepted');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].directory, f.binding.sessionDirectory);
  assert.match(f.calls[0].text, /Direct author feedback/);
  await f.restart();
  assert.equal((await (await f.request(`api/comments/${data.id}/send`, {})).json()).status, 'accepted');
  assert.equal(f.calls.length, 1);
});

test('synthetic editing agent receives feedback, revises draft, refreshed snapshot stays honest', async t => {
  const f = await fixture(t); const data = await f.comment();
  const before = data.anchor.revision;
  f.upstream.submit = async payload => {
    assert.ok(payload.text.includes(data.id));
    assert.ok(payload.text.includes(data.message));
    await fs.appendFile(f.draft, '\n## Fake agent revision\n\nClarified synthetic text.\n');
    return { accepted: true, messageId: payload.messageId };
  };
  await f.request('api/comments', data);
  assert.equal((await (await f.request(`api/comments/${data.id}/send`, {})).json()).status, 'accepted');
  const refreshed = await f.document();
  assert.notEqual(refreshed.revision, before);
  assert.match(refreshed.html, /Clarified synthetic text/);
  assert.equal(refreshed.comments[0].status, 'accepted');
  assert.ok(!('completed' in refreshed.comments[0]));
  assert.equal(refreshed.observations.length, 2);
});

test('uncertain delivery after accepted network side effect is never automatically retried', async t => {
  let count = 0;
  let attempted;
  const f = await fixture(t, { upstream: { async submit(p) {
    count++; attempted = structuredClone({ id: p.messageId, text: p.text, delivery: 'queue', resume: true });
    const disk = JSON.parse(await fs.readFile(path.join(f.root, 'private/state.json'), 'utf8'));
    assert.equal(disk.comments[0].status, 'sending');
    assert.match(disk.comments[0].messageId, /^msg_[a-f0-9]{32}$/);
    assert.deepEqual(disk.comments[0].payload, attempted);
    throw new Error('Connection lost after side effect');
  } } });
  const data = await f.comment(); await f.request('api/comments', data);
  assert.equal((await (await f.request(`api/comments/${data.id}/send`, {})).json()).status, 'uncertain');
  await f.restart();
  assert.deepEqual(f.store.state.comments[0].payload, attempted);
  assert.equal((await (await f.request(`api/comments/${data.id}/send`, {})).json()).status, 'uncertain');
  assert.equal(count, 1);
});

test('timeout is bounded and missing exact acknowledgment remains uncertain', async t => {
  for (const submit of [() => new Promise(() => {}), async () => ({ accepted: true, messageId: 'wrong' })]) {
    const f = await fixture(t, { upstream: { submit } });
    const data = await f.comment(); await f.request('api/comments', data);
    assert.equal((await (await f.request(`api/comments/${data.id}/send`, {})).json()).status, 'uncertain');
  }
});

test('interrupted sending state on disk recovers uncertain, not saved', async t => {
  const f = await fixture(t); const data = await f.comment(); await f.request('api/comments', data);
  await f.store.transaction(s => { s.comments[0].status = 'sending'; });
  await f.restart();
  assert.equal((await f.document()).comments[0].status, 'uncertain'); assert.equal(f.calls.length, 0);
});

test('session directory and upstream identity rechecked before every send', async t => {
  const f = await fixture(t); const data = await f.comment(); await f.request('api/comments', data);
  f.upstream.inspect = async id => ({ id, directory: f.root + '-moved', upstreamIdentity: 'fake-only' });
  assert.equal((await f.request(`api/comments/${data.id}/send`, {})).status, 409);
  f.upstream.inspect = async id => ({ id, directory: f.root, upstreamIdentity: 'other' });
  assert.equal((await f.request(`api/comments/${data.id}/send`, {})).status, 409);
  assert.equal((await f.document()).comments[0].status, 'saved'); assert.equal(f.calls.length, 0);
});

test('stale selections and stale saved comments blocked; revisions observed, not completion', async t => {
  const f = await fixture(t); const data = await f.comment(); await f.request('api/comments', data);
  const prior = (await f.document()).revision;
  await fs.appendFile(f.draft, '\nNew synthetic revision.\n');
  assert.equal((await f.request('api/comments', { ...data, id: randomUUID() })).status, 409);
  assert.equal((await f.request(`api/comments/${data.id}/send`, {})).status, 409);
  const doc = await f.document(); assert.notEqual(doc.revision, prior);
  assert.equal(doc.observations.length, 2); assert.equal(doc.comments[0].status, 'saved');
  assert.equal(f.calls.length, 0);
});

test('draft changing during upstream inspection is rechecked before submission', async t => {
  const f = await fixture(t); const data = await f.comment(); await f.request('api/comments', data);
  f.upstream.inspect = async id => { await fs.appendFile(f.draft, '\nChanged during inspection.'); return { id, directory: f.root, upstreamIdentity: 'fake-only' }; };
  assert.equal((await f.request(`api/comments/${data.id}/send`, {})).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.document()).comments[0].status, 'saved');
});

test('image authorization and changed/symlinked draft fail closed without paths in error', async t => {
  const f = await fixture(t); const doc = await f.document(); const image = `image/${/data-image="([a-f\d]{32})"/.exec(doc.html)[1]}`;
  assert.equal((await f.request(image, undefined, { Authorization: '' })).status, 401);
  await fs.unlink(f.draft); await fs.symlink(path.join(f.assets, 'pixel.png'), f.draft);
  const response = await f.request('api/document'); assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(f.root));
});

test('quote offset/context disambiguate repeated text; no silent anchor relocation', async t => {
  const f = await fixture(t);
  const doc = renderDraft('same same same', f.binding); const block = doc.blocks[0];
  const anchor = { revision: doc.revision, block: block.id, quote: 'same', offset: 5, prefix: 'same ', suffix: ' same' };
  assert.equal(validateAnchor(anchor, doc).offset, 5);
  assert.throws(() => validateAnchor({ ...anchor, prefix: 'wrong' }, doc));
  assert.throws(() => validateAnchor({ ...anchor, offset: 0 }, doc));
});

test('private state permissions and single writer lock', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'private');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'state.json'))).mode & 0o777, 0o600);
  await assert.rejects(openStore(directory));
  const raw = await fs.readFile(path.join(directory, 'state.json'), 'utf8'); assert.ok(!raw.includes(f.token));
});

test('full four-skill startup context, reference bases and least-privilege fake writer', async t => {
  const f = await fixture(t);
  const files = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(f.root, `skill-${i}.md`); files.push(file);
    await fs.writeFile(file, `---\n${i === 3 ? 'metadata:\n  version: "3.1.0"\n' : ''}---\n# FULL skill ${i}\nDo actual work. [support](references/example.md)\n`);
  }
  const prepared = await prepareWriter(f.binding, files);
  const system = prepared.config.agents[prepared.agent].system;
  for (const file of files) { assert.ok(system.includes(await fs.readFile(file, 'utf8'))); assert.ok(system.includes(file)); }
  let received;
  await startFakeWriter(prepared, { kind: 'synthetic-test', async create(data) { received = data; return { id: 'ses_synthetic_writer' }; } });
  assert.equal(received.directory, f.root); assert.equal(received.config, prepared.config);
  const rules = prepared.config.agents[prepared.agent].permissions;
  assert.equal('default_agent' in prepared.config, false);
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.deepEqual(rules.filter(r => r.action === 'edit'), [{ action: 'edit', resource: 'draft.md', effect: 'allow' }]);
  assert.deepEqual(rules.filter(r => r.action === 'read').map(r => r.resource), ['draft.md', ...files.map(file => path.relative(f.root, file))]);
  assert.equal(rules.some(r => ['glob', 'grep'].includes(r.action) || r.resource === `${f.root}/**`), false);
  await assert.rejects(startFakeWriter(prepared, { kind: 'real' }));
  await fs.writeFile(files[3], 'metadata:\n  version: "2.0.0"');
  await assert.rejects(prepareWriter(f.binding, files));
});

test('save reconciliation finds durable lost response; absent attempts are fenced across restart', async t => {
  const f = await fixture(t), saved = await f.comment();
  await f.request('api/comments', saved); // Deliberately ignore the response.
  await f.restart();
  assert.equal((await (await f.request('api/comments/reconcile', saved)).json()).comment.id, saved.id);
  assert.equal((await f.request('api/comments/reconcile', { ...saved, message: 'altered' })).status, 409);
  const absent = { ...saved, id: randomUUID() };
  assert.deepEqual(await (await f.request('api/comments/reconcile', absent)).json(), { comment: null });
  await f.restart();
  assert.equal((await f.request('api/comments', absent)).status, 409); // Late original cannot race a new retry.
  const edited = { ...absent, id: randomUUID(), message: 'Edited feedback, explicitly retried.' };
  assert.equal((await f.request('api/comments', edited)).status, 200);
  assert.equal((await f.document()).comments.length, 2);
});

test('reconciliation racing an original save has one atomic outcome, never a late duplicate', async t => {
  const f = await fixture(t), data = await f.comment();
  const [save, resolve] = await Promise.all([f.request('api/comments', data), f.request('api/comments/reconcile', data)]);
  const result = await resolve.json();
  assert.equal(resolve.status, 200);
  if (result.comment) assert.equal(save.status, 200);
  else assert.equal(save.status, 409);
  assert.equal((await f.document()).comments.length, result.comment ? 1 : 0);
});

test('image-only replacement changes presentation/asset identity, not text anchors; stale text still rejected', async t => {
  const f = await fixture(t), before = await f.document(), data = await f.comment();
  await f.request('api/comments', data);
  const imageId = doc => /data-image="([a-f\d]{32})"/.exec(doc.html)[1];
  const replacement = Buffer.from('89504e470d0a1a0a01', 'hex');
  await fs.writeFile(path.join(f.assets, 'pixel.png'), replacement);
  const after = await f.document();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.blocks, before.blocks);
  assert.notEqual(after.presentationRevision, before.presentationRevision);
  assert.notEqual(imageId(after), imageId(before));
  assert.equal((await f.request(`image/${imageId(before)}`)).status, 404);
  assert.deepEqual(Buffer.from(await (await f.request(`image/${imageId(after)}`)).arrayBuffer()), replacement);
  assert.equal(after.observations.length, 2);
  assert.equal(after.comments[0].status, 'saved');
  assert.equal((await f.request(`api/comments/${data.id}/send`, {})).status, 200);
  await fs.appendFile(f.draft, '\nText change.');
  assert.equal((await f.request('api/comments', { ...data, id: randomUUID() })).status, 409);
});

test('image metadata cache avoids unchanged byte reads; same-size replacements and symlink invalidation work', async t => {
  const f = await fixture(t); let reads = 0;
  const read = presentationReader(f.binding, async file => { reads++; return readImage(file); });
  const before = await read();
  for (let i = 0; i < 5; i++) assert.equal((await read()).presentationRevision, before.presentationRevision);
  assert.equal(reads, 1);
  const file = path.join(f.assets, 'pixel.png');
  await fs.writeFile(file, Buffer.from('4749463839610000', 'hex'));
  assert.notEqual((await read()).presentationRevision, before.presentationRevision);
  assert.equal(reads, 2);
  await fs.unlink(file); await fs.symlink(f.draft, file);
  const invalid = await read();
  assert.equal(Object.values(invalid.assetDigests)[0], 'unavailable');
  assert.equal(reads, 2);
});

test('presentation reads have a 20 MiB aggregate image budget and retain 64-image bound', async t => {
  const f = await fixture(t); const lines = [];
  for (let i = 0; i < 65; i++) {
    lines.push(`![image](assets/${i}.png)`);
    if (i < 5) {
      const data = Buffer.alloc(5 * 1024 * 1024); Buffer.from('89504e470d0a1a0a', 'hex').copy(data);
      await fs.writeFile(path.join(f.assets, `${i}.png`), data);
    }
  }
  await fs.writeFile(f.draft, lines.join('\n\n'));
  let bytes = 0;
  const doc = await presentationReader(f.binding, async file => { const result = await readImage(file); bytes += result.data.length; return result; })();
  assert.equal(Object.keys(doc.images).length, 64);
  assert.equal(bytes, 20 * 1024 * 1024);
  assert.equal(doc.assetDigests[path.join(f.assets, '4.png')], 'unavailable');
});

test('explicit writer skill files are loaded in full, including Humanizer 3.1.0', async t => {
  const f = await fixture(t); const prepared = await prepareWriter(f.binding);
  assert.deepEqual(canonicalSkills, []);
  for (const file of f.binding.skillPaths) assert.ok(prepared.config.agents[prepared.agent].system.includes(await fs.readFile(file, 'utf8')));
  assert.equal(prepared.skills.length, 4);
});

test('writer configuration rejects absent or invalid explicit skill paths', async t => {
  const root = await fs.mkdtemp(path.resolve('.test-galley-writer-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const draft = path.join(root, 'draft.md'); await fs.writeFile(draft, '# Synthetic');
  const binding = { draft, sessionDirectory: root, assetRoots: [], sessionId: 'ses_fake', upstreamIdentity: 'fake' };
  for (const skillPaths of [undefined, null, [], 'bad', [1, 2, 3, 4], ['relative.md', 'a', 'b', 'c']]) {
    await assert.rejects(prepareWriter({ ...binding, skillPaths }), /Four explicit caller-owned skill paths/);
  }
  const { skillPaths } = await writerSkills(root);
  await assert.rejects(prepareWriter({ ...binding, skillPaths: [...skillPaths.slice(0, 3), path.join(root, 'absent.md')] }));
  const link = path.join(root, 'linked.md'); await fs.symlink(skillPaths[3], link);
  await assert.rejects(prepareWriter({ ...binding, skillPaths: [...skillPaths.slice(0, 3), link] }), /Symlink denied/);
  const meta = path.join(root, 'skill*.md'); await fs.writeFile(meta, 'version: 3.1.0');
  await assert.rejects(prepareWriter({ ...binding, skillPaths: [...skillPaths.slice(0, 3), meta] }), /Permission metacharacter/);
  const prepared = await prepareWriter({ ...binding, skillPaths });
  assert.deepEqual(prepared.referenceDirectories, []);
  assert.deepEqual(prepared.profile.permissions.filter(p => p.action === 'read').map(p => p.resource), ['draft.md', ...skillPaths.map(p => path.relative(root, p))]);
  await fs.writeFile(skillPaths[3], 'version: 2.0.0');
  await assert.rejects(prepareWriter({ ...binding, skillPaths }), /Humanizer metadata 3.1.0/);
});

test('writer configuration bounds reference directories and grants only explicit read-only trees', async t => {
  const root = await fs.mkdtemp(path.resolve('.test-galley-writer-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const draft = path.join(project, 'draft.md'); await fs.writeFile(draft, '# Synthetic');
  const inputs = await writerSkills(root);
  const binding = { draft, sessionDirectory: project, assetRoots: [], sessionId: 'ses_fake', upstreamIdentity: 'fake', skillPaths: inputs.skillPaths };
  const external = inputs.skillReferenceDirectories[0];
  const local = path.join(project, 'references'); await fs.mkdir(local);
  const link = path.join(root, 'linked'); await fs.symlink(external, link);
  const meta = path.join(root, 'refs*'); await fs.mkdir(meta);
  for (const skillReferenceDirectories of [null, 'bad', [1], Array(17).fill(external), ['/'], ['relative'], [external + '/..'], [path.join(root, 'missing')], [draft], [link], [meta]]) {
    await assert.rejects(prepareWriter({ ...binding, skillReferenceDirectories }));
  }
  const prepared = await prepareWriter({ ...binding, skillReferenceDirectories: [external, local] });
  const rules = prepared.profile.permissions;
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.deepEqual(rules.filter(p => p.action === 'edit'), [{ action: 'edit', resource: 'draft.md', effect: 'allow' }]);
  assert.deepEqual(rules.filter(p => p.action === 'read' && p.resource.endsWith('/**')), [
    { action: 'read', resource: `${external}/**`, effect: 'allow' },
    { action: 'read', resource: 'references/**', effect: 'allow' },
  ]);
  assert.ok(rules.every(p => p.effect !== 'allow' || ['read', 'external_directory', 'edit'].includes(p.action)));
  const projectReferences = await prepareWriter({ ...binding, skillReferenceDirectories: [project, project] });
  assert.deepEqual(projectReferences.referenceDirectories, [project]);
  assert.deepEqual(projectReferences.profile.permissions.filter(p => p.action === 'read' && p.resource.includes('*')), [
    { action: 'read', resource: '**', effect: 'allow' },
  ]);
  assert.deepEqual(projectReferences.profile.permissions.filter(p => p.action === 'edit'), [{ action: 'edit', resource: 'draft.md', effect: 'allow' }]);
  await verifyPrepared(projectReferences);
  await verifyPrepared(prepared);
  await fs.rename(external, external + '-moved'); await fs.symlink(external + '-moved', external);
  await assert.rejects(verifyPrepared(prepared), /Symlink denied/);
});
