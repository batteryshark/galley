import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareWriter } from '../src/writer.mjs';
import { openStore } from '../src/store.mjs';
import { writePrivate, readPrivate } from '../src/private.mjs';
import { enrollAdditionalDraft, attachDraftAuthor, draftUpstream, assertDraftPermission } from '../src/additional-draft.mjs';
import { startServer } from '../src/server.mjs';
import { writerToolInputs } from './fixtures/writer-tools.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.resolve('.test-additional-'));
  let cleanup;
  t.after(async () => { await cleanup?.(); await fs.rm(root, { recursive: true, force: true }); });
  const project = path.join(root, 'project'), state = path.join(root, 'private');
  for (const d of [project, state, path.join(project, '_drafts'), path.join(project, '_images'), path.join(state, 'native')]) await fs.mkdir(d, { mode: 0o700 });
  const draft = path.join(project, '_drafts/old.md'), next = path.join(project, '_drafts/next.md'), image = path.join(project, '_images/one.png');
  await fs.writeFile(image, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  await fs.writeFile(draft, '# Original\n\nOld passage.');
  await fs.writeFile(next, `# Additional\n\nNew passage.\n\n![One](${image})`);
  const binding = { draft, sessionDirectory: project, sessionId: 'ses_existing', assetRoots: [path.join(project, '_images')], upstreamIdentity: 'previous', ...await writerToolInputs(root) };
  const p = await prepareWriter(binding); binding.agent = p.agent;
  const preparedFile = path.join(state, 'prepared.json'); await fs.writeFile(preparedFile, JSON.stringify(p), { mode: 0o600 });
  const model = { providerID: 'fake', id: 'exact' };
  const session = { id: binding.sessionId, location: { directory: project }, agent: p.agent, permissions: structuredClone(p.profile.permissions), model };
  const source = await openStore(path.join(state, 'original'), binding);
  await source.transaction(s => { s.comments.push({ id: 'historical', status: 'accepted' }); s.closedSaves = ['fence']; });
  const oldToken = await source.issue(); const before = structuredClone(source.state); await source.close();
  await writePrivate(path.join(state, `native/startup-${p.agent}.json`), { state: 'created-not-edit-verified', agent: p.agent, sessionId: binding.sessionId, digest: p.digest });
  const authorOperatorFile = path.join(state, 'author.json');
  await writePrivate(authorOperatorFile, { mode: 'attach', storeDirectory: path.join(state, 'original'), privateDirectory: path.join(state, 'native') });
  const input = { authorOperatorFile, preparedFile, model, draft: next, assetRoots: binding.assetRoots, storeDirectory: path.join(state, 'additional'), operatorOutput: path.join(state, 'multi.json'), resultFile: path.join(state, 'result.json'), publicOrigin: 'https://review.example.invalid' };
  const prompts = [];
  const native = { identity: 'native:new', waitOwner: async () => {}, observe: async () => ({ session }), submit: async x => { prompts.push(x); return { accepted: true, messageId: x.messageId }; }, close: async () => {} };
  return { root, project, state, binding, p, model, session, before, oldToken, input, native, prompts, set cleanup(fn) { cleanup = fn; } };
}

test('operator enrollment preserves author, history and capabilities in separate stores; refuses overwrite', async t => {
  const f = await fixture(t);
  await enrollAdditionalDraft(f.input);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.state, 'original/state.json'))), f.before);
  const result = await readPrivate(f.input.resultFile);
  assert.equal(result.sessionId, f.binding.sessionId); assert.equal(result.agent, f.p.agent);
  assert.equal((await fs.stat(f.input.resultFile)).mode & 0o777, 0o600);
  const s = await openStore(f.input.storeDirectory);
  assert.deepEqual(s.state.comments, []); assert.equal(s.authorized(f.oldToken), false);
  assert(s.authorized(new URL(result.reviewLink).hash.slice(8))); await s.close();
  await assert.rejects(enrollAdditionalDraft(f.input));
  assert.equal(f.prompts.length, 0);
});

test('existing permissions only: no broad grants, wrong author, model or changed permissions', async t => {
  const f = await fixture(t), binding = { ...f.binding, draft: f.input.draft };
  const up = draftUpstream(f.native, f.binding, binding, f.p, f.model);
  await up.inspect(f.binding.sessionId);
  assert.throws(() => assertDraftPermission(f.p.profile.permissions, { ...binding, draft: path.join(f.project, 'other.md') }));
  assert.throws(() => draftUpstream(f.native, f.binding, { ...binding, sessionId: 'ses_other' }, f.p, f.model));
  for (const change of [{ agent: 'lead' }, { id: 'ses_other' }, { model: { id: 'other' } }, { permissions: [] }, { location: { directory: f.root } }]) {
    const saved = structuredClone(f.session); Object.assign(f.session, change);
    await assert.rejects(up.inspect(f.binding.sessionId)); Object.assign(f.session, saved);
  }
  await assert.rejects(up.submit({ sessionId: binding.sessionId, directory: f.project, upstreamIdentity: f.native.identity, messageId: 'msg_wrong', text: `Feedback\n${JSON.stringify({ draft: f.binding.draft })}` }));
  assert.equal(f.prompts.length, 0);
});

test('same-author routing/images, immutable draft dispatch and per-draft history survive attach restart', async t => {
  const f = await fixture(t); await enrollAdditionalDraft(f.input);
  const config = await readPrivate(f.input.operatorOutput), result = await readPrivate(f.input.resultFile);
  const token = new URL(result.reviewLink).hash.slice(8);
  let author = await attachDraftAuthor(config, { connect: async () => f.native }), app;
  f.cleanup = async () => { await app?.close(); await author.close(); };
  let retained = false;
  const start = async () => { app = await startServer({ resolveReview: token => {
    const e = author.entries.find(e => e.store.authorized(token));
    return e && { ...e, readOnly: retained && token === f.oldToken };
  } }); };
  await start();
  const req = (token, route, data) => fetch(`${app.origin}/galley/${route}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(data ? { Origin: app.origin, 'X-Galley': '1', 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
  const old = await (await req(f.oldToken, 'api/document')).json(), doc = await (await req(token, 'api/document')).json();
  assert.match(old.text, /Original/); assert.match(doc.text, /Additional/); assert.equal(old.comments.length, 1); assert.equal(doc.comments.length, 0);
  const imageRoute = `image/${doc.html.match(/data-image="([a-f0-9]{32})"/)[1]}`;
  assert.equal((await req(token, imageRoute)).status, 200); assert.equal((await req(f.oldToken, imageRoute)).status, 404);
  assert.equal((await req('invalid', 'api/document')).status, 401);
  const offset = doc.text.indexOf('New passage.'), quote = 'New passage.';
  const note = { id: randomUUID(), operationId: randomUUID(), expectedVersion: 0, message: 'Fixture only', anchor: { kind: 'continuous', revision: doc.revision, offset, quote, prefix: doc.text.slice(Math.max(0, offset - 80), offset), suffix: doc.text.slice(offset + quote.length, offset + quote.length + 80) } };
  assert.equal((await req(token, 'api/notes', note)).status, 200);
  const batch = { id: randomUUID(), revision: doc.revision };
  assert.equal((await (await req(token, 'api/batches', batch)).json()).status, 'accepted');
  assert.equal(f.prompts.length, 1); assert.equal(JSON.parse(f.prompts[0].text.split('\n')[1]).draft, f.input.draft);
  await app.close(); app = undefined; await author.close();
  author = await attachDraftAuthor(config, { connect: async () => f.native }); await start();
  assert.equal((await (await req(token, 'api/document')).json()).notes[0].status, 'accepted');
  assert.equal((await (await req(f.oldToken, 'api/document')).json()).notes.length, 0);
  await req(token, 'api/batches', batch); assert.equal(f.prompts.length, 1);
  retained = true;
  assert.equal((await req(f.oldToken, 'api/batches', { id: randomUUID(), revision: old.revision })).status, 409);
  assert.equal((await req(f.oldToken, 'api/document')).status, 200);
  assert.equal(f.prompts.length, 1);
});
