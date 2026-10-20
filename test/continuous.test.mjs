import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { renderDraft, locateAnchor, validateContinuousAnchor } from '../src/renderer.mjs';

async function fixture(t, submit) {
  const root = await fs.mkdtemp(path.resolve('.test-continuous-'));
  const draft = path.join(root, 'draft.md');
  await fs.writeFile(draft, '# A quiet morning\n\nCafé &amp; coast 🌊.\n\nAnother **paragraph** with a view.\n');
  const directory = path.join(root, 'private');
  const binding = { draft, assetRoots: [root], siteAssetRoot: root, sessionId: 'ses_fake', sessionDirectory: root, upstreamIdentity: 'fake' };
  let store = await openStore(directory, binding);
  const tokens = [await store.issue(), await store.issue()], calls = [];
  const upstream = { async inspect(id) { return { id, directory: root, upstreamIdentity: 'fake' }; }, async submit(p) { calls.push(p); return submit ? submit(p, f) : { accepted: true, messageId: p.messageId }; } };
  let app = await startServer({ store, upstream, deliveryTimeout: 100 });
  const f = { root, draft, directory, binding, upstream, calls, tokens,
    get store() { return store; }, get app() { return app; },
    async restart() { await app.close(); await store.close(); store = await openStore(directory); app = await startServer({ store, upstream, deliveryTimeout: 100 }); },
    async request(client, route, data, headers = {}) {
      return fetch(`${app.origin}/galley/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${tokens[client]}`, ...(data === undefined ? {} : { Origin: app.origin, 'X-Galley': '1', 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    },
    async doc(client = 0) { const r = await this.request(client, 'api/document'); assert.equal(r.status, 200); return r.json(); },
    async note(message = 'Keep this passage', client = 0) {
      const d = await this.doc(client), offset = d.text.indexOf('Café'), quote = d.text.slice(offset, d.text.indexOf('with a view.'));
      const n = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, message, anchor: { kind: 'continuous', revision: d.revision, offset, quote, prefix: d.text.slice(Math.max(0, offset - 80), offset), suffix: d.text.slice(offset + quote.length, offset + quote.length + 80) } };
      const r = await this.request(client, 'api/notes', n); assert.equal(r.status, 200, await r.clone().text()); return { request: n, note: await r.json() };
    },
    async send(client = 0, data) { return this.request(client, 'api/batches', data || { id: randomUUID(), revision: (await this.doc()).revision }); },
  };
  t.after(async () => { await app.close(); await store.close(); await fs.rm(root, { recursive: true }); });
  return f;
}
test('two independent capabilities share pending count and cross-block/entity/Unicode anchors; version conflicts preserve first edit', async t => {
  const f = await fixture(t), a = await f.note();
  assert.match(a.note.anchor.quote, /Café & coast 🌊\.\nAnother paragraph/);
  const phone = await f.doc(1); assert.equal(phone.notes.length, 1); assert.equal(phone.notes[0].message, a.note.message);
  const update = { ...a.request, operationId: randomUUID(), expectedVersion: 1, message: 'Phone edit' };
  assert.equal((await f.request(1, 'api/notes', update)).status, 200);
  assert.equal((await f.request(0, 'api/notes', { ...update, operationId: randomUUID(), message: 'Conflicting desktop edit' })).status, 409);
  assert.equal((await f.doc()).notes[0].message, 'Phone edit');
  assert.equal((await f.request(1, 'api/notes', update)).status, 200); // response-loss retry
  assert.equal((await f.request(1, 'api/notes', { ...update, expectedVersion: 2, message: 'Reused operation' })).status, 409);
  await f.restart(); assert.equal((await f.doc(1)).notes[0].version, 2);
});
test('batch journal fsynced before one native message; concurrent Sends cannot duplicate; late notes wait', async t => {
  let release, entered;
  const enteredPromise = new Promise(r => { entered = r; });
  const f = await fixture(t, async (p, f) => {
    const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'state.json')));
    const batch = disk.batches[0]; assert.equal(batch.status, 'sending'); assert.equal(batch.members.length, 2);
    assert.equal(batch.payload.text, p.text); assert.equal(batch.messageId, p.messageId);
    assert.ok(disk.notes.every(n => n.status === 'sending'));
    entered(); await new Promise(r => { release = r; }); return { accepted: true, messageId: p.messageId };
  });
  const a = await f.note('First'), b = await f.note('Second', 1);
  const data = { id: randomUUID(), revision: (await f.doc()).revision };
  const first = f.send(0, data); await enteredPromise;
  const duplicate = await f.send(1, data); assert.equal((await duplicate.json()).status, 'sending');
  assert.equal((await f.send(1)).status, 409);
  assert.equal((await f.request(1, 'api/notes', { ...a.request, operationId: randomUUID(), expectedVersion: 1, message: 'Too late' })).status, 409);
  await f.note('Late note', 1); release();
  assert.equal((await (await first).json()).status, 'accepted'); assert.equal(f.calls.length, 1);
  const doc = await f.doc(); assert.deepEqual(doc.notes.map(n => n.status), ['accepted', 'accepted', 'pending']);
  assert.match(f.calls[0].text, new RegExp(a.note.id)); assert.match(f.calls[0].text, new RegExp(b.note.id));
  await f.restart(); assert.equal((await (await f.send(1, data)).json()).status, 'accepted'); assert.equal(f.calls.length, 1);
});
test('timeout, wrong ack, thrown admission fence batch/member states through restart; no new batch replay', async t => {
  for (const behavior of [() => new Promise(() => {}), async () => ({ accepted: true, messageId: 'wrong' }), async () => { throw new Error('Lost reply'); }]) {
    const f = await fixture(t, behavior); await f.note(); const data = { id: randomUUID(), revision: (await f.doc()).revision };
    assert.equal((await (await f.send(0, data)).json()).status, 'uncertain'); await f.restart();
    assert.equal((await f.doc()).notes[0].status, 'uncertain');
    assert.equal((await (await f.send(1, data)).json()).status, 'uncertain');
    await f.note('New note'); assert.equal((await f.send(1)).status, 409); assert.equal(f.calls.length, 1);
  }
});
test('crash sending recovery preserves complete payload and historical fences without migration', async t => {
  const f = await fixture(t); const a = await f.note();
  await f.store.transaction(s => { s.comments.push({ id: 'old', status: 'accepted', payload: { text: 'old' } }); s.closedSaves = ['old-save']; s.batches.push({ id: randomUUID(), status: 'sending', messageId: 'msg_original', members: [{ id: a.note.id, version: 1 }], payload: { text: 'original complete payload' } }); s.notes[0].status = 'sending'; s.notes[0].batchId = s.batches[0].id; });
  await f.restart(); assert.equal(f.store.state.batches[0].status, 'uncertain'); assert.equal(f.store.state.notes[0].status, 'uncertain');
  assert.equal(f.store.state.batches[0].payload.text, 'original complete payload'); assert.equal(f.store.state.comments[0].status, 'accepted'); assert.deepEqual(f.store.state.closedSaves, ['old-save']); assert.equal(f.calls.length, 0);
});
test('revision relocation honest; changed quote never silently anchors or dispatches', async t => {
  const f = await fixture(t), a = await f.note();
  await fs.appendFile(f.draft, '\nAn appended passage.\n');
  let d = await f.doc(); assert.equal(d.notes[0].located.quote, a.note.anchor.quote);
  assert.equal((await f.send()).status, 409); assert.equal(f.calls.length, 0);
  const data = { id: randomUUID(), revision: d.revision, confirmRevision: d.revision };
  assert.equal((await (await f.send(0, data)).json()).status, 'accepted');
  const second = await f.note('Another');
  await fs.writeFile(f.draft, '# Replaced\n\nNo original text.'); d = await f.doc();
  assert.equal(d.notes.find(n => n.id === second.note.id).located, null);
  assert.equal((await f.send(0, { id: randomUUID(), revision: d.revision, confirmRevision: d.revision })).status, 409);
  assert.equal((await f.request(0, 'api/notes', { ...second.request, id: randomUUID() })).status, 409);
  assert.equal(d.notes.find(n => n.id === second.note.id).anchor.quote, second.note.anchor.quote);
  const explicit = await (await f.send(0, { id: randomUUID(), revision: d.revision, confirmRevision: d.revision, confirmStale: d.revision })).json();
  assert.equal(explicit.status, 'accepted'); assert.equal(explicit.members[0].currentAnchor, null);
  assert.equal(explicit.members[0].anchor.quote, second.note.anchor.quote);
  assert.equal(explicit.members[0].anchorStatus, 'stale-unanchored-explicitly-confirmed');
});
test('ambiguous relocation refused, offsets/entities exact, no renderer buttons or trusted client HTML', async t => {
  const f = await fixture(t), doc = renderDraft('**A** &amp; 🌊\n\nB &lt;C&gt;', f.binding);
  const anchor = { kind: 'continuous', revision: doc.revision, offset: 0, quote: doc.text, prefix: '', suffix: '' };
  assert.equal(validateContinuousAnchor(anchor, doc).quote, 'A & 🌊\nB <C>\n');
  assert.doesNotMatch(doc.html, /button|data-comment/);
  assert.throws(() => validateContinuousAnchor({ ...anchor, offset: 1, html: '<script>' }, doc));
  const repeated = renderDraft(`${anchor.quote}\n\n${anchor.quote}`, f.binding);
  assert.equal(locateAnchor(anchor, repeated), null);
});
test('HTML5 canonicalization normalizes sanitized CRLF and repairs table foster parenting before offsets', () => {
  const binding = { assetRoots: [], siteAssetRoot: '/unavailable' };
  for (const [markdown, text] of [
    ['<p>A&#13;&#10;B</p>\n\nNext', 'A\nBNext\n'],
    ['<table>a<tr><td>b</td></tr>c</table>', 'acb'],
  ]) {
    const doc = renderDraft(markdown, binding); assert.equal(doc.text, text);
    const offset = text.indexOf(markdown.includes('Next') ? 'Next' : 'b');
    const anchor = { kind: 'continuous', revision: doc.revision, offset, quote: text.slice(offset), prefix: text.slice(0, offset), suffix: '' };
    assert.deepEqual(validateContinuousAnchor(anchor, doc), anchor);
    if (markdown.includes('Next')) assert.equal(offset, 3);
    else assert.match(doc.html, /ac<table><tbody><tr><td>b<\/td><\/tr><\/tbody><\/table>/);
  }
});
test('batch preflight changes/session mismatch and revoked/expired/Origin/CSRF/request bounds remain closed', async t => {
  const f = await fixture(t), a = await f.note(); const data = { id: randomUUID(), revision: a.note.anchor.revision };
  assert.equal((await f.request(0, 'api/batches', data, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request(0, 'api/batches', data, { 'X-Galley': '' })).status, 403);
  assert.equal((await f.request(0, 'api/notes', { ...a.request, message: 'x'.repeat(40000) })).status, 413);
  const short = await f.store.issue(1); await new Promise(r => setTimeout(r, 5));
  assert.equal((await f.request(0, 'api/batches', data, { Authorization: `Bearer ${short}` })).status, 401);
  f.upstream.inspect = async id => ({ id, directory: f.root + '-wrong', upstreamIdentity: 'fake' });
  assert.equal((await f.send(0, data)).status, 409); assert.equal(f.store.state.batches.length, 0);
  f.upstream.inspect = async id => { await fs.appendFile(f.draft, '\nChanged'); return { id, directory: f.root, upstreamIdentity: 'fake' }; };
  assert.equal((await f.send(0, data)).status, 409); assert.equal(f.calls.length, 0);
  assert.equal((await f.request(0, 'api/comments', a.request)).status, 409);
  await f.request(0, 'api/revoke', {}); assert.equal((await f.send(0, data)).status, 401);
  assert.equal((await f.doc(1)).notes.length, 1);
});
test('graceful listener close drains in-flight bounded batch before store lock can be released', async t => {
  let enter, release;
  const entered = new Promise(r => { enter = r; });
  const f = await fixture(t, async p => { enter(); await new Promise(r => { release = r; }); return { accepted: true, messageId: p.messageId }; });
  await f.note(); const request = f.send().catch(() => null); await entered;
  let closed = false;
  const closing = f.app.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false);
  release(); await closing; await request;
  assert.equal(f.store.state.batches[0].status, 'accepted');
  // fixture cleanup may close an already-closed HTTP listener harmlessly.
});
test('batch byte budget rejects before native admission, all members remain pending', async t => {
  const f = await fixture(t), a = await f.note();
  for (let i = 0; i < 40; i++) {
    const r = await f.request(0, 'api/notes', { ...a.request, id: randomUUID(), operationId: randomUUID(), message: '🌊'.repeat(3000) }); assert.equal(r.status, 200);
  }
  assert.equal((await f.send()).status, 413); assert.equal(f.calls.length, 0); assert.equal(f.store.state.batches.length, 0);
  assert.ok(f.store.state.notes.every(n => n.status === 'pending'));
});
test('versioned staged assets activate together; old asset URLs stay old, old mutations are fenced', async t => {
  const f = await fixture(t);
  const html = await (await f.request(0, '')).text(); assert.match(html, /continuous-v2\/app.js/);
  const js = await (await f.request(0, 'continuous-v2/app.js')).text(); assert.match(js, /api\/batches/);
  assert.equal((await f.request(0, 'continuous-v2/../private/state.json')).status, 404);
  assert.equal((await f.request(0, 'continuous-v2/app.js?x=1')).status, 400);
  assert.match(await (await f.request(0, 'app.js')).text(), /Save comment/);
  assert.equal((await f.request(0, `api/comments/${randomUUID()}/send`, {})).status, 409);
});
